import { execFile } from 'child_process';

import type { CredentialStore, Credentials } from './types';
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
  /** `create_time`, an ISO 8601 civil date-time (pass-cli/src/commands/item/list.rs). */
  createTime: string;
}

/** A login item hydrated through `pass-cli item view --output json`. */
export interface PassCliLoginItem {
  id: string;
  shareId: string;
  vaultName: string;
  title: string;
  username?: string;
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
  return { id, shareId, title: optionalString(raw.title) ?? '', createTime: optionalString(raw.create_time) ?? '' };
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
    password: optionalString(login.password),
    urls: stringArray(login.urls),
  };
}

function titleMatchesHost(title: string, host: string): boolean {
  return title.toLowerCase().includes(host.toLowerCase());
}

function urlMatchesHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === new URL(`https://${host}`).host;
  } catch {
    return false;
  }
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
    // EPIPE from a child that exits before reading stdin is reported by its
    // exit status above; ending stdin keeps a prompting subcommand from waiting.
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

/** Vault roles that may create items (pass/src/domain/models/share/role.rs). */
const WRITABLE_VAULT_ROLES = new Set(['Owner', 'Manager', 'Editor']);

/** Role of each vault share the authenticated account can write to, by share ID. */
async function writableVaultRoles(): Promise<Map<string, string>> {
  const output = await runPassCli(['share', 'list', '--only-vaults', 'true', '--output', 'json']);
  const parsed = parseJsonObject(output, 'share list');
  const shares = Array.isArray(parsed.shares) ? parsed.shares : [];
  const roles = new Map<string, string>();
  for (const share of shares) {
    if (!isRecord(share) || share.share_type !== 'Vault' || typeof share.share_role !== 'string') continue;
    const id = optionalString(share.id);
    if (id && WRITABLE_VAULT_ROLES.has(share.share_role)) roles.set(id, share.share_role);
  }
  return roles;
}

/** Active login items of `vault`, newest first. */
async function listLoginItems(vault: PassCliVault): Promise<PassCliItemSummary[]> {
  const output = await runPassCli([
    'item', 'list',
    '--share-id', vault.shareId,
    '--filter-type', 'login',
    '--filter-state', 'active',
    '--sort-by', 'created-desc',
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

/** A login item of a vault whose title names `host`, not yet viewed. */
interface Candidate {
  vault: PassCliVault;
  summary: PassCliItemSummary;
}

/** Items of `vaults` whose title names `host`, newest first; listing never exposes URLs. */
async function listCandidates(vaults: PassCliVault[], host: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const vault of vaults) {
    for (const summary of await listLoginItems(vault)) {
      if (titleMatchesHost(summary.title, host)) {
        candidates.push({ vault, summary });
      }
    }
  }
  return candidates.sort((a, b) => b.summary.createTime.localeCompare(a.summary.createTime));
}

function isEntryOf(item: PassCliLoginItem | null, host: string, username: string): item is PassCliLoginItem {
  return item !== null && item.username === username && item.urls.some((url) => urlMatchesHost(url, host));
}

/**
 * The newest entry of `username` at `host` in any vault; a failed view fails
 * the search, so an older item never stands in for a newer one, and the
 * search runs once more, since a save deletes the items it replaces.
 */
async function findEntry(
  host: string,
  username: string,
  vaults?: PassCliVault[],
): Promise<PassCliLoginItem | null> {
  const searched = vaults ?? await listVaults();
  authTrace('credential.pass-cli.search.start', {
    host,
    username: maskIdentifier(username),
    vaultCount: searched.length,
  });
  for (let attempt = 1; ; attempt += 1) {
    try {
      for (const { vault, summary } of await listCandidates(searched, host)) {
        const item = await viewLoginItem(vault, summary);
        if (isEntryOf(item, host, username)) {
          authTrace('credential.pass-cli.selected', {
            host,
            vault: item.vaultName,
            username: maskIdentifier(item.username),
            urlHosts: urlHosts(item.urls),
          });
          return item;
        }
      }
      authTrace('credential.pass-cli.search.miss', {
        host,
        username: maskIdentifier(username),
        vaultCount: searched.length,
      });
      return null;
    } catch (error) {
      if (attempt >= 2) {
        throw error;
      }
    }
  }
}

/** Every entry of `host` whose username field equals `username`, across all vaults; an item that cannot be viewed is skipped. */
async function findEntries(
  host: string,
  username: string,
  vaults: PassCliVault[],
): Promise<PassCliLoginItem[]> {
  const entries: PassCliLoginItem[] = [];
  for (const { vault, summary } of await listCandidates(vaults, host)) {
    const item = await viewLoginItem(vault, summary).catch(() => null);
    if (isEntryOf(item, host, username)) {
      entries.push(item);
    }
  }
  return entries;
}

/**
 * Proton Pass CLI credential store.
 *
 * Stores, resolves and removes secrets as login items in Proton Pass vaults
 * through the `pass-cli` binary. An entry is addressed by credential host and
 * username: its title contains the host, one of its URLs has exactly that
 * host (WHATWG URL `host`) and its username field equals the username. The JSON
 * shapes handled here are the serializers of the pinned pass-cli release
 * (submodules/pass-cli, 2.7.0):
 *
 * - `vault list --output json` -> `{ vaults: [{ name, vault_id, share_id }] }`
 *   (pass-cli/src/commands/vault/list.rs)
 * - `share list --only-vaults true --output json` -> `{ shares: [{ id, name,
 *   share_type, share_role }] }`, `share_role` "Owner", "Manager", "Editor" or
 *   "Viewer"; a personal access token or agent session owns no share
 *   (pass-cli/src/commands/share/list.rs, pass/src/share/list.rs)
 * - `item list --share-id <id> --filter-type login --filter-state active
 *   --sort-by created-desc --output json`
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
 * New entries go to a vault the account owns, else to one it can write to
 * (role Manager or Editor). Every call runs through execFile without a shell, with a 15-second
 * timeout; passwords reach pass-cli only through stdin, and an existing entry
 * is replaced by create-then-delete because `item update` takes field values
 * as command-line arguments, visible to other local processes (CWE-214).
 */
export class PassCliStore implements CredentialStore {
  readonly name = 'pass-cli' as const;

  constructor(private readonly host: string) {
    if (!host.trim()) {
      throw new Error('pass-cli store requires a credential host');
    }
  }

  async resolve(username: string): Promise<Credentials> {
    authTrace('credential.resolve.start', {
      store: this.name,
      host: this.host,
      username: maskIdentifier(username),
    });
    if (!await passCliSessionActive()) {
      authTrace('credential.resolve.failure', {
        store: this.name,
        host: this.host,
        reason: 'pass-cli-not-logged-in',
      });
      throw new Error('pass-cli is not logged in. Run: pass-cli login');
    }

    const entry = await findEntry(this.host, username);
    if (!entry?.password) {
      authTrace('credential.resolve.failure', {
        store: this.name,
        host: this.host,
        reason: 'entry-not-found',
      });
      throw new Error(`No pass-cli session entry found for this session at ${this.host}.`);
    }

    authTrace('credential.resolve.success', {
      store: this.name,
      host: this.host,
      username: maskIdentifier(username),
      vault: entry.vaultName,
      urlHosts: urlHosts(entry.urls),
    });
    return { username, password: entry.password };
  }

  /**
   * Create the entry for `username` from a stdin template, then delete every
   * entry it replaces. Candidate vaults are those the account owns or, when
   * it owns none (a personal access token or agent session), those it may
   * edit as Manager or Editor; the vault of an existing entry wins among
   * them, else the first. A failed deletion is logged: reads return the
   * newest entry, and the next save or remove() deletes the rest.
   */
  async store(username: string, password: string): Promise<void> {
    const vaults = await listVaults();
    if (vaults.length === 0) {
      throw new Error('pass-cli has no vault to store the session entry in. Run: pass-cli vault create --name <name>');
    }
    const roles = await writableVaultRoles();
    const owned = vaults.filter((vault) => roles.get(vault.shareId) === 'Owner');
    const candidates = owned.length > 0 ? owned : vaults.filter((vault) => roles.has(vault.shareId));
    if (candidates.length === 0) {
      throw new Error(
        'pass-cli lists no vault this account owns or may edit (role Owner, Manager or Editor) for the session entry. ' +
          'Run: pass-cli vault create --name <name>, or share a vault with Manager or Editor role to the personal access token',
      );
    }
    const existing = await findEntries(this.host, username, vaults);
    const target = candidates.find((vault) => existing.some((entry) => entry.shareId === vault.shareId)) || candidates[0];
    const template: PassCliLoginTemplate = {
      title: `Proton ${this.host}`,
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
    for (const entry of existing) {
      try {
        await deleteItem(entry);
      } catch (error) {
        authTrace('credential.pass-cli.replace.delete-failed', {
          host: this.host,
          username: maskIdentifier(username),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        logger.warn(`pass-cli: a replaced session entry at ${this.host} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Delete every entry for `username` on this host; none existing is
   * success, and so is an entry another process deleted meanwhile.
   */
  async remove(username: string): Promise<void> {
    const deleted = new Set<string>();
    for (;;) {
      const entry = await findEntry(this.host, username);
      if (!entry) break;
      const key = `${entry.shareId}/${entry.id}`;
      if (deleted.has(key)) {
        throw new Error(`pass-cli reported item ${key} as deleted but still lists it`);
      }
      try {
        await deleteItem(entry);
      } catch (error) {
        const remaining = await findEntry(this.host, username);
        if (remaining && `${remaining.shareId}/${remaining.id}` === key) {
          throw error;
        }
      }
      deleted.add(key);
    }
  }
}

async function deleteItem(entry: Pick<PassCliLoginItem, 'id' | 'shareId'>): Promise<void> {
  await runPassCli(['item', 'delete', '--share-id', entry.shareId, '--item-id', entry.id]);
}

export { passCliSessionActive, listVaults, writableVaultRoles, findEntry, findEntries };
