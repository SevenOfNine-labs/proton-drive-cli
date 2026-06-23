/**
 * Proton Pass CLI credential provider.
 *
 * Resolves credentials by searching pass-cli vaults for login entries
 * with a proton.me URL. Replaces the Go-side pass-cli integration
 * (cmd/adapter/passcli.go) so the Go adapter no longer needs to
 * resolve credentials itself.
 *
 * Security:
 * - Uses execFile (not exec) to prevent shell injection
 * - 15-second timeout on all subprocess calls
 * - Credentials never exposed via command-line arguments
 */

import { execFile } from 'child_process';

import { PROTON_CREDENTIAL_HOST } from '../constants';
import type { CredentialProvider, Credentials } from './types';
import { authTrace, maskIdentifier } from '../utils/auth-trace';

const TIMEOUT_MS = 15_000;
const DEFAULT_BIN = 'pass-cli';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function credentialHostPattern(host: string = PROTON_CREDENTIAL_HOST): RegExp {
  return new RegExp(escapeRegExp(host), 'i');
}

interface PassCliVault {
  id?: string;
  shareId?: string;
  name: string;
}

interface PassCliLoginItem {
  id?: string;
  shareId?: string;
  vaultId?: string;
  vaultName?: string;
  name: string;
  username?: string;
  email?: string;
  password?: string;
  urls?: string[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function unwrapPassCliItem(raw: any): any {
  return raw?.item || raw;
}

function loginContent(raw: any): any {
  const item = unwrapPassCliItem(raw);
  return (
    item?.content?.content?.Login ||
    item?.content?.Login ||
    item?.login ||
    item?.Login ||
    {}
  );
}

function passCliItemTitle(raw: any): string {
  const item = unwrapPassCliItem(raw);
  return item?.content?.title || item?.title || item?.name || '';
}

function passCliItemURLs(raw: any): string[] {
  const item = unwrapPassCliItem(raw);
  const login = loginContent(item);
  return [
    ...asStringArray(login.urls),
    ...asStringArray(login.url ? [login.url] : []),
    ...asStringArray(item?.urls),
    ...asStringArray(item?.content?.urls),
  ];
}

function toPassCliLoginItem(raw: any, vaultName: string): PassCliLoginItem {
  const item = unwrapPassCliItem(raw);
  const login = loginContent(item);
  return {
    id: item?.id || item?.item_id || item?.itemId,
    shareId: item?.share_id || item?.shareId,
    vaultId: item?.vault_id || item?.vaultId,
    vaultName,
    name: passCliItemTitle(item),
    username: login.username || item?.username,
    email: login.email || item?.email,
    password: login.password || item?.password,
    urls: passCliItemURLs(item),
  };
}

function toPassCliVault(raw: any): PassCliVault | null {
  const id = raw?.vault_id || raw?.vaultId || raw?.id;
  const shareId = raw?.share_id || raw?.shareId;
  const name = raw?.name || raw?.title || id || shareId;
  if (!name && !shareId) return null;

  const vault: PassCliVault = { name: name || shareId };
  if (id) vault.id = id;
  if (shareId) vault.shareId = shareId;
  return vault;
}

function vaultDisplayName(vault: PassCliVault | string): string {
  return typeof vault === 'string' ? vault : vault.name;
}

function vaultShareId(vault: PassCliVault | string): string | undefined {
  return typeof vault === 'string' ? undefined : vault.shareId;
}

function itemListArgs(vault: PassCliVault | string): string[] {
  const args = ['item', 'list'];
  const shareId = vaultShareId(vault);
  if (shareId) {
    args.push('--share-id', shareId);
  } else {
    args.push(vaultDisplayName(vault));
  }
  args.push('--filter-type', 'login', '--output', 'json');
  return args;
}

function titleMatchesCredentialHost(title: string, host: string): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedTitle || !normalizedHost) return false;
  if (normalizedTitle === normalizedHost) return true;
  if (normalizedTitle.includes(normalizedHost)) return true;

  // The default Proton login entry is often titled just "Proton" or
  // "Proton Account" while the URL is only available from `item view`.
  return normalizedHost === PROTON_CREDENTIAL_HOST && /\bproton\b/.test(normalizedTitle);
}

function itemMatchesCredentialHost(raw: any, urlPattern: RegExp, host: string): boolean {
  const urls = passCliItemURLs(raw);
  if (urls.length > 0) {
    return urls.some((url) => urlPattern.test(url));
  }
  return titleMatchesCredentialHost(passCliItemTitle(raw), host);
}

function urlHosts(urls: string[] = []): string[] {
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

function runPassCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
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
  });
}

/** Check if pass-cli is installed and logged in. */
async function passCliTest(): Promise<boolean> {
  authTrace('credential.pass-cli.test.start');
  try {
    await runPassCli(['test']);
    authTrace('credential.pass-cli.test.success');
    return true;
  } catch (error) {
    authTrace('credential.pass-cli.test.failure', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** List all vaults. */
async function listVaults(): Promise<PassCliVault[]> {
  const output = await runPassCli(['vault', 'list', '--output', 'json']);
  const parsed = JSON.parse(output);
  // pass-cli returns { vaults: [...] } or an array directly
  const vaults = Array.isArray(parsed) ? parsed : (parsed.vaults || []);
  const normalizedVaults = vaults
    .map(toPassCliVault)
    .filter((vault: PassCliVault | null): vault is PassCliVault => vault !== null);
  authTrace('credential.pass-cli.vaults', {
    count: normalizedVaults.length,
    vaults: normalizedVaults.map((vault: PassCliVault) => vault.name),
  });
  return normalizedVaults;
}

async function viewVaultItem(vault: PassCliVault | string, entry: PassCliLoginItem): Promise<PassCliLoginItem | null> {
  const args = ['item', 'view', '--output', 'json'];
  const shareId = entry.shareId || vaultShareId(vault);
  const vaultName = vaultDisplayName(vault);
  if (shareId && entry.id) {
    args.push('--share-id', shareId, '--item-id', entry.id);
  } else if (shareId && entry.name) {
    args.push('--share-id', shareId, '--item-title', entry.name);
  } else if (entry.name) {
    args.push('--vault-name', vaultName, '--item-title', entry.name);
  } else {
    return null;
  }

  const output = await runPassCli(args);
  return toPassCliLoginItem(JSON.parse(output), vaultName);
}

/** Search a single vault for login items matching the requested credential host. */
async function searchVault(
  vault: PassCliVault | string,
  urlPattern: RegExp = credentialHostPattern(),
  host: string = PROTON_CREDENTIAL_HOST,
  options: { exhaustive?: boolean } = {},
): Promise<PassCliLoginItem[]> {
  authTrace('credential.pass-cli.vault-scan.start', {
    vault: vaultDisplayName(vault),
    byShareId: Boolean(vaultShareId(vault)),
    exhaustive: Boolean(options.exhaustive),
  });
  const output = await runPassCli(itemListArgs(vault));
  const parsed = JSON.parse(output);
  // pass-cli returns { items: [...] } or a bare array
  const items: any[] = Array.isArray(parsed) ? parsed : (parsed.items || []);
  const matches: PassCliLoginItem[] = [];
  for (const item of items) {
    const listedMatch = itemMatchesCredentialHost(item, urlPattern, host);
    const shouldHydrateHiddenURL = options.exhaustive && passCliItemURLs(item).length === 0;
    if (!listedMatch && !shouldHydrateHiddenURL) continue;

    const entry = toPassCliLoginItem(item, vaultDisplayName(vault));
    if (entry.password && (entry.email || entry.username)) {
      matches.push(entry);
      continue;
    }

    const detailed = await viewVaultItem(vault, entry);
    if (detailed && itemMatchesCredentialHost(detailed, urlPattern, host)) {
      matches.push(detailed);
    }
  }
  authTrace('credential.pass-cli.vault-scan.success', {
    vault: vaultDisplayName(vault),
    exhaustive: Boolean(options.exhaustive),
    itemCount: items.length,
    matchCount: matches.length,
  });
  return matches;
}

/** Search all vaults for a Proton login entry. */
async function searchProtonEntry(
  urlPattern?: RegExp,
  username?: string,
  host: string = PROTON_CREDENTIAL_HOST
): Promise<PassCliLoginItem | null> {
  const normalizedUsername = username?.trim().toLowerCase();
  const vaults = await listVaults();
  authTrace('credential.pass-cli.search.start', {
    host,
    username: maskIdentifier(username),
    vaultCount: vaults.length,
  });
  const findInVaults = async (exhaustive: boolean): Promise<PassCliLoginItem | null> => {
    for (const vault of vaults) {
      const matches = await searchVault(vault, urlPattern, host, { exhaustive });
      if (normalizedUsername) {
        const exact = matches.find((entry) =>
          entry.email?.trim().toLowerCase() === normalizedUsername ||
          entry.username?.trim().toLowerCase() === normalizedUsername
        );
        if (exact) {
          authTrace('credential.pass-cli.selected', {
            host,
            mode: exhaustive ? 'exhaustive' : 'heuristic',
            vault: exact.vaultName,
            username: maskIdentifier(exact.email || exact.username),
            urlHosts: urlHosts(exact.urls),
          });
          return exact;
        }
        continue;
      }
      if (matches.length > 0) {
        const selected = matches[0];
        authTrace('credential.pass-cli.selected', {
          host,
          mode: exhaustive ? 'exhaustive' : 'heuristic',
          vault: selected.vaultName,
          username: maskIdentifier(selected.email || selected.username),
          urlHosts: urlHosts(selected.urls),
        });
        return selected;
      }
    }
    return null;
  };

  const heuristicMatch = await findInVaults(false);
  if (heuristicMatch) {
    return heuristicMatch;
  }

  // `pass-cli item list` can omit URL fields unless secrets are explicitly
  // shown, which is not available for agent sessions. If title heuristics
  // miss, hydrate every login item across every vault and inspect URLs from
  // `item view`.
  const exhaustiveMatch = await findInVaults(true);
  if (!exhaustiveMatch) {
    authTrace('credential.pass-cli.search.miss', {
      host,
      username: maskIdentifier(username),
      vaultCount: vaults.length,
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
    return passCliTest();
  }

  async resolve(options?: { username?: string }): Promise<Credentials> {
    authTrace('credential.resolve.start', {
      provider: this.name,
      host: this.host,
      username: maskIdentifier(options?.username),
    });
    const loggedIn = await passCliTest();
    if (!loggedIn) {
      authTrace('credential.resolve.failure', {
        provider: this.name,
        host: this.host,
        reason: 'pass-cli-not-logged-in',
      });
      throw new Error(
        'pass-cli is not logged in. Run: pass-cli login',
      );
    }

    const entry = await searchProtonEntry(this.urlPattern, options?.username, this.host);
    if (!entry || !entry.password) {
      authTrace('credential.resolve.failure', {
        provider: this.name,
        host: this.host,
        reason: 'entry-not-found',
      });
      throw new Error(
        'No Proton login entry found in pass-cli vaults. ' +
        'Create one with a proton.me URL, or use --credential-provider git-credential.',
      );
    }

    const username = options?.username || entry.email || entry.username;
    if (!username) {
      authTrace('credential.resolve.failure', {
        provider: this.name,
        host: this.host,
        reason: 'missing-username',
      });
      throw new Error(
        'Proton login entry found but has no username or email.',
      );
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

  async store(username: string, password: string): Promise<void> {
    const existing = await searchProtonEntry(this.urlPattern, username, this.host);
    if (existing?.id && existing.shareId) {
      await runPassCli([
        'item', 'update',
        '--share-id', existing.shareId,
        '--item-id', existing.id,
        '--field', `username=${username}`,
        '--field', `email=${username}`,
        '--field', `password=${password}`,
        '--field', `url=https://${this.host}`,
      ]);
      return;
    }

    // Use the first available vault
    const vaults = await listVaults();
    const vaultName = vaults[0]?.name || 'Personal';
    await runPassCli([
      'item', 'create', 'login',
      '--vault-name', vaultName,
      '--title', this.host === PROTON_CREDENTIAL_HOST ? 'Proton' : `Proton ${this.host}`,
      '--email', username,
      '--username', username,
      '--password', password,
      '--url', `https://${this.host}`,
    ]);
  }

  async remove(username: string): Promise<void> {
    // Find the entry first, then delete by name
    const entry = await searchProtonEntry(this.urlPattern, username, this.host);
    if (!entry) {
      throw new Error(`No Proton entry found for ${username}`);
    }
    if (!entry.id || !entry.shareId) {
      throw new Error(`Proton entry for ${username} is missing item metadata`);
    }
    await runPassCli([
      'item', 'delete',
      '--share-id', entry.shareId,
      '--item-id', entry.id,
    ]);
  }

  async verify(): Promise<boolean> {
    authTrace('credential.verify.start', {
      provider: this.name,
      host: this.host,
    });
    try {
      const loggedIn = await passCliTest();
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

// Export helpers for testing
export { passCliTest, listVaults, searchVault, searchProtonEntry };
