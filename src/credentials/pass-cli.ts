/**
 * Proton Pass CLI credential provider.
 *
 * Resolves and stores secrets as login items in Proton Pass vaults through
 * the `pass-cli` binary, matching items by the credential host URL. The JSON
 * shapes handled here are the serializers of the pinned pass-cli release
 * (submodules/pass-cli, 2.7.0):
 *
 * - `vault list --output json` -> `{ vaults: [{ name, vault_id, share_id }] }`
 *   (pass-cli/src/commands/vault/list.rs)
 * - `item list --share-id <id> --filter-type login --output json`
 *   -> `{ items: [{ id, share_id, vault_id, title, item_type, ... }] }`;
 *   summaries carry neither secrets nor URLs (pass-cli/src/commands/item/list.rs)
 * - `item view --share-id <id> --item-id <id> --output json`
 *   -> `{ item: { id, share_id, content: { title, content: { Login: { email,
 *   username, password, urls } } } }, attachments }` (pass/src/item/get_one.rs)
 * - `item create login --share-id <id> --from-template -` reads the login
 *   template JSON from stdin (pass-cli/src/commands/item/create/login.rs)
 * - `info` exits non-zero without an authenticated session
 *   (docs/public/docs/commands/info.md)
 *
 * Security:
 * - execFile without a shell and a 15-second timeout on every call
 * - passwords reach pass-cli only through stdin (create template); an existing
 *   entry is replaced by create-then-delete because `item update` takes field
 *   values as command-line arguments, which are visible to other local
 *   processes (CWE-214)
 * - secrets never appear in trace output
 */

import { execFile } from 'child_process';

import { PROTON_CREDENTIAL_HOST } from '../constants';
import type { CredentialProvider, Credentials, LookupOptions } from './types';
import { authTrace, maskIdentifier } from '../utils/auth-trace';
import { logger } from '../utils/logger';

const TIMEOUT_MS = 15_000;
const DEFAULT_BIN = 'pass-cli';

/** One entry of `pass-cli vault list --output json`. */
export interface PassCliVault {
  name: string;
  vaultId: string;
  shareId: string;
}

/** One entry of `pass-cli item list --output json`. */
interface PassCliItemSummary {
  id: string;
  shareId: string;
  title: string;
}

/** A login item hydrated through `pass-cli item view --output json`. */
export interface PassCliLoginItem {
  id: string;
  shareId: string;
  vaultName: string;
  title: string;
  username?: string;
  email?: string;
  password?: string;
  urls: string[];
}

/** Login template accepted by `pass-cli item create login --from-template -`. */
interface PassCliLoginTemplate {
  title: string;
  username: string | null;
  email: string | null;
  password: string | null;
  totp_uri: string | null;
  urls: string[];
  extra_fields: never[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function credentialHostPattern(host: string = PROTON_CREDENTIAL_HOST): RegExp {
  return new RegExp(escapeRegExp(host), 'i');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseJsonObject(output: string, command: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) {
    throw new Error(`pass-cli ${command} did not return a JSON object`);
  }
  return parsed;
}

function toVault(raw: unknown): PassCliVault | null {
  if (!isRecord(raw)) return null;
  const name = optionalString(raw.name);
  const vaultId = optionalString(raw.vault_id);
  const shareId = optionalString(raw.share_id);
  if (!name || !vaultId || !shareId) return null;
  return { name, vaultId, shareId };
}

function toItemSummary(raw: unknown): PassCliItemSummary | null {
  if (!isRecord(raw)) return null;
  const id = optionalString(raw.id);
  const shareId = optionalString(raw.share_id);
  if (!id || !shareId) return null;
  return { id, shareId, title: optionalString(raw.title) ?? '' };
}

function toLoginItem(raw: unknown, vaultName: string): PassCliLoginItem | null {
  if (!isRecord(raw) || !isRecord(raw.item)) return null;
  const item = raw.item;
  const id = optionalString(item.id);
  const shareId = optionalString(item.share_id);
  if (!id || !shareId) return null;
  const data = isRecord(item.content) ? item.content : {};
  const login = isRecord(data.content) && isRecord(data.content.Login) ? data.content.Login : {};
  return {
    id,
    shareId,
    vaultName,
    title: optionalString(data.title) ?? '',
    username: optionalString(login.username),
    email: optionalString(login.email),
    password: optionalString(login.password),
    urls: stringArray(login.urls),
  };
}

function titleMatchesCredentialHost(title: string, host: string): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedTitle || !normalizedHost) return false;
  if (normalizedTitle.includes(normalizedHost)) return true;

  // Proton's own login item is commonly titled "Proton" or "Proton Account";
  // its URL is only visible through `item view`.
  return normalizedHost === PROTON_CREDENTIAL_HOST && /\bproton\b/.test(normalizedTitle);
}

function urlHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      hosts.add(parsed.host || parsed.protocol.replace(/:$/, ''));
    } catch {
      hosts.add(url.replace(/:.*/, ''));
    }
  }
  return [...hosts].sort();
}

function getPassCliBin(): string {
  return process.env.PROTON_PASS_CLI_BIN?.trim() || DEFAULT_BIN;
}

function runPassCli(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      getPassCliBin(),
      args,
      { timeout: TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          reject(new Error(`pass-cli ${args[0]} failed: ${msg}`));
          return;
        }
        resolve(stdout);
      },
    );
    // A child that exits before reading stdin makes the write fail with
    // EPIPE; the exit status reported to the callback above is the error the
    // caller needs, so the stream error itself is not rethrown. Ending stdin
    // on every call keeps a prompting subcommand from waiting for input.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}

/** True when `pass-cli info` succeeds, i.e. an authenticated session exists. */
async function passCliSessionActive(): Promise<boolean> {
  authTrace('credential.pass-cli.session.start');
  try {
    await runPassCli(['info']);
    authTrace('credential.pass-cli.session.success');
    return true;
  } catch (error) {
    authTrace('credential.pass-cli.session.failure', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** List the vaults of the authenticated account. */
async function listVaults(): Promise<PassCliVault[]> {
  const output = await runPassCli(['vault', 'list', '--output', 'json']);
  const parsed = parseJsonObject(output, 'vault list');
  const vaults = Array.isArray(parsed.vaults) ? parsed.vaults : [];
  const normalizedVaults = vaults
    .map(toVault)
    .filter((vault): vault is PassCliVault => vault !== null);
  authTrace('credential.pass-cli.vaults', {
    count: normalizedVaults.length,
    vaults: normalizedVaults.map((vault) => vault.name),
  });
  return normalizedVaults;
}

async function listLoginItems(vault: PassCliVault): Promise<PassCliItemSummary[]> {
  const output = await runPassCli([
    'item', 'list',
    '--share-id', vault.shareId,
    '--filter-type', 'login',
    '--output', 'json',
  ]);
  const parsed = parseJsonObject(output, 'item list');
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items
    .map(toItemSummary)
    .filter((item): item is PassCliItemSummary => item !== null);
}

async function viewLoginItem(vault: PassCliVault, summary: PassCliItemSummary): Promise<PassCliLoginItem | null> {
  const output = await runPassCli([
    'item', 'view',
    '--share-id', summary.shareId,
    '--item-id', summary.id,
    '--output', 'json',
  ]);
  return toLoginItem(parseJsonObject(output, 'item view'), vault.name);
}

/**
 * Search one vault for login items whose URLs match the credential host.
 *
 * Listing never exposes URLs, so candidates are selected by title and then
 * hydrated through `item view`; with `exhaustive` every login item is
 * hydrated.
 */
async function searchVault(
  vault: PassCliVault,
  urlPattern: RegExp = credentialHostPattern(),
  host: string = PROTON_CREDENTIAL_HOST,
  options: { exhaustive?: boolean } = {},
): Promise<PassCliLoginItem[]> {
  const exhaustive = Boolean(options.exhaustive);
  authTrace('credential.pass-cli.vault-scan.start', {
    vault: vault.name,
    exhaustive,
  });
  const summaries = await listLoginItems(vault);
  const matches: PassCliLoginItem[] = [];
  for (const summary of summaries) {
    if (!exhaustive && !titleMatchesCredentialHost(summary.title, host)) continue;
    const item = await viewLoginItem(vault, summary);
    if (item && item.urls.some((url) => urlPattern.test(url))) {
      matches.push(item);
    }
  }
  authTrace('credential.pass-cli.vault-scan.success', {
    vault: vault.name,
    exhaustive,
    itemCount: summaries.length,
    matchCount: matches.length,
  });
  return matches;
}

/**
 * Search all vaults for a login entry of the credential host, optionally
 * restricted to an exact username or email.
 */
async function searchProtonEntry(
  urlPattern?: RegExp,
  username?: string,
  host: string = PROTON_CREDENTIAL_HOST,
  options: { exhaustiveLookup?: boolean; vaults?: PassCliVault[] } = {},
): Promise<PassCliLoginItem | null> {
  const normalizedUsername = username?.trim().toLowerCase();
  const exhaustiveLookup = options.exhaustiveLookup ?? true;
  const vaults = options.vaults ?? await listVaults();
  authTrace('credential.pass-cli.search.start', {
    host,
    username: maskIdentifier(username),
    vaultCount: vaults.length,
    exhaustiveLookup,
  });
  const findInVaults = async (exhaustive: boolean): Promise<PassCliLoginItem | null> => {
    for (const vault of vaults) {
      const matches = await searchVault(vault, urlPattern, host, { exhaustive });
      const selected = normalizedUsername
        ? matches.find((entry) =>
          entry.email?.trim().toLowerCase() === normalizedUsername ||
          entry.username?.trim().toLowerCase() === normalizedUsername)
        : matches[0];
      if (selected) {
        authTrace('credential.pass-cli.selected', {
          host,
          mode: exhaustive ? 'exhaustive' : 'title',
          vault: selected.vaultName,
          username: maskIdentifier(selected.email || selected.username),
          urlHosts: urlHosts(selected.urls),
        });
        return selected;
      }
    }
    return null;
  };

  const titleMatch = await findInVaults(false);
  if (titleMatch) {
    return titleMatch;
  }

  const exhaustiveMatch = exhaustiveLookup ? await findInVaults(true) : null;
  if (!exhaustiveMatch) {
    authTrace('credential.pass-cli.search.miss', {
      host,
      username: maskIdentifier(username),
      vaultCount: vaults.length,
      exhaustiveLookup,
    });
  }
  return exhaustiveMatch;
}

export class PassCliProvider implements CredentialProvider {
  readonly name = 'pass-cli' as const;
  private readonly host: string;
  private readonly urlPattern: RegExp;

  constructor(host: string = PROTON_CREDENTIAL_HOST) {
    this.host = host;
    this.urlPattern = credentialHostPattern(host);
  }

  async isAvailable(): Promise<boolean> {
    return passCliSessionActive();
  }

  async resolve(options?: { username?: string } & LookupOptions): Promise<Credentials> {
    authTrace('credential.resolve.start', {
      provider: this.name,
      host: this.host,
      username: maskIdentifier(options?.username),
    });
    const loggedIn = await passCliSessionActive();
    if (!loggedIn) {
      authTrace('credential.resolve.failure', {
        provider: this.name,
        host: this.host,
        reason: 'pass-cli-not-logged-in',
      });
      throw new Error('pass-cli is not logged in. Run: pass-cli login');
    }

    const entry = await searchProtonEntry(this.urlPattern, options?.username, this.host, {
      exhaustiveLookup: options?.exhaustiveLookup,
    });
    if (!entry || !entry.password) {
      authTrace('credential.resolve.failure', {
        provider: this.name,
        host: this.host,
        reason: 'entry-not-found',
      });
      throw new Error(
        'No Proton login entry found in pass-cli vaults. ' +
        'Create one with a matching credential URL or configure a different key/data password provider.',
      );
    }

    const username = options?.username || entry.email || entry.username;
    if (!username) {
      authTrace('credential.resolve.failure', {
        provider: this.name,
        host: this.host,
        reason: 'missing-username',
      });
      throw new Error('Proton login entry found but has no username or email.');
    }

    authTrace('credential.resolve.success', {
      provider: this.name,
      host: this.host,
      username: maskIdentifier(username),
      vault: entry.vaultName,
      urlHosts: urlHosts(entry.urls),
    });
    return { username, password: entry.password };
  }

  /**
   * Create the login entry for `username` from a stdin template; an existing
   * entry for the same host and username is deleted after the replacement
   * has been created. A failed deletion leaves a duplicate with an outdated
   * password, which is reported but does not fail the store: the new entry
   * exists and later lookups select it before older duplicates are removed by
   * remove().
   */
  async store(username: string, password: string, options: LookupOptions = {}): Promise<void> {
    const vaults = await listVaults();
    if (vaults.length === 0) {
      throw new Error('pass-cli has no vault to store the Proton entry in. Run: pass-cli vault create --name <name>');
    }
    const existing = await searchProtonEntry(this.urlPattern, username, this.host, {
      exhaustiveLookup: options.exhaustiveLookup ?? true,
      vaults,
    });
    const target = (existing && vaults.find((vault) => vault.shareId === existing.shareId)) || vaults[0];
    const template: PassCliLoginTemplate = {
      title: this.host === PROTON_CREDENTIAL_HOST ? 'Proton' : `Proton ${this.host}`,
      username,
      email: null,
      password,
      totp_uri: null,
      urls: [`https://${this.host}`],
      extra_fields: [],
    };
    await runPassCli(
      ['item', 'create', 'login', '--share-id', target.shareId, '--from-template', '-'],
      JSON.stringify(template),
    );
    if (existing) {
      try {
        await deleteItem(existing);
      } catch (error) {
        authTrace('credential.pass-cli.replace.delete-failed', {
          host: this.host,
          username: maskIdentifier(username),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        logger.warn(`pass-cli: the previous Proton entry for this host could not be deleted (${error instanceof Error ? error.message : String(error)}); remove the duplicate in Proton Pass.`);
      }
    }
  }

  /**
   * Delete every entry for `username` on this host. Throws when none exists.
   */
  async remove(username: string, options: LookupOptions = {}): Promise<void> {
    const deleted = new Set<string>();
    for (;;) {
      const entry = await searchProtonEntry(this.urlPattern, username, this.host, {
        exhaustiveLookup: options.exhaustiveLookup,
      });
      if (!entry) break;
      const key = `${entry.shareId}/${entry.id}`;
      if (deleted.has(key)) {
        throw new Error(`pass-cli reported item ${key} as deleted but still lists it`);
      }
      await deleteItem(entry);
      deleted.add(key);
    }
    if (deleted.size === 0) {
      throw new Error(`No Proton entry found for ${username}`);
    }
  }

  async verify(): Promise<boolean> {
    authTrace('credential.verify.start', {
      provider: this.name,
      host: this.host,
    });
    try {
      const loggedIn = await passCliSessionActive();
      if (!loggedIn) {
        authTrace('credential.verify.success', {
          provider: this.name,
          host: this.host,
          ok: false,
          reason: 'pass-cli-not-logged-in',
        });
        return false;
      }
      const entry = await searchProtonEntry(this.urlPattern, undefined, this.host);
      const ok = entry !== null && !!entry.password;
      authTrace('credential.verify.success', {
        provider: this.name,
        host: this.host,
        ok,
        username: maskIdentifier(entry?.email || entry?.username),
      });
      return ok;
    } catch (error) {
      authTrace('credential.verify.failure', {
        provider: this.name,
        host: this.host,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

async function deleteItem(entry: Pick<PassCliLoginItem, 'id' | 'shareId'>): Promise<void> {
  await runPassCli(['item', 'delete', '--share-id', entry.shareId, '--item-id', entry.id]);
}

export { passCliSessionActive, listVaults, searchVault, searchProtonEntry };
