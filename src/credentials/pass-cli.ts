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

const TIMEOUT_MS = 15_000;
const DEFAULT_BIN = 'pass-cli';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function credentialHostPattern(host: string = PROTON_CREDENTIAL_HOST): RegExp {
  return new RegExp(escapeRegExp(host), 'i');
}

interface PassCliVault {
  id: string;
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
  return passCliItemURLs(raw).some((url) => urlPattern.test(url)) ||
    titleMatchesCredentialHost(passCliItemTitle(raw), host);
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
  try {
    await runPassCli(['test']);
    return true;
  } catch {
    return false;
  }
}

/** List all vaults. */
async function listVaults(): Promise<PassCliVault[]> {
  const output = await runPassCli(['vault', 'list', '--output', 'json']);
  const parsed = JSON.parse(output);
  // pass-cli returns { vaults: [...] } or an array directly
  const vaults = Array.isArray(parsed) ? parsed : (parsed.vaults || []);
  return vaults.map((v: any) => ({ id: v.vault_id || v.id || v.vaultId, name: v.name }));
}

async function viewVaultItem(vaultName: string, entry: PassCliLoginItem): Promise<PassCliLoginItem | null> {
  const args = ['item', 'view', '--output', 'json'];
  if (entry.shareId && entry.id) {
    args.push('--share-id', entry.shareId, '--item-id', entry.id);
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
  vault: string,
  urlPattern: RegExp = credentialHostPattern(),
  host: string = PROTON_CREDENTIAL_HOST
): Promise<PassCliLoginItem[]> {
  const output = await runPassCli([
    'item', 'list', vault,
    '--filter-type', 'login',
    '--output', 'json',
  ]);
  const parsed = JSON.parse(output);
  // pass-cli returns { items: [...] } or a bare array
  const items: any[] = Array.isArray(parsed) ? parsed : (parsed.items || []);
  const matches: PassCliLoginItem[] = [];
  for (const item of items) {
    if (!itemMatchesCredentialHost(item, urlPattern, host)) continue;

    const entry = toPassCliLoginItem(item, vault);
    if (entry.password && (entry.email || entry.username)) {
      matches.push(entry);
      continue;
    }

    const detailed = await viewVaultItem(vault, entry);
    if (detailed && itemMatchesCredentialHost(detailed, urlPattern, host)) {
      matches.push(detailed);
    }
  }
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
  for (const vault of vaults) {
    const matches = await searchVault(vault.name, urlPattern, host);
    if (normalizedUsername) {
      const exact = matches.find((entry) =>
        entry.email?.trim().toLowerCase() === normalizedUsername ||
        entry.username?.trim().toLowerCase() === normalizedUsername
      );
      if (exact) return exact;
      continue;
    }
    if (matches.length > 0) {
      return matches[0];
    }
  }
  return null;
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
    const loggedIn = await passCliTest();
    if (!loggedIn) {
      throw new Error(
        'pass-cli is not logged in. Run: pass-cli login',
      );
    }

    const entry = await searchProtonEntry(this.urlPattern, options?.username, this.host);
    if (!entry || !entry.password) {
      throw new Error(
        'No Proton login entry found in pass-cli vaults. ' +
        'Create one with a proton.me URL, or use --credential-provider git-credential.',
      );
    }

    const username = options?.username || entry.email || entry.username;
    if (!username) {
      throw new Error(
        'Proton login entry found but has no username or email.',
      );
    }

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
    try {
      const loggedIn = await passCliTest();
      if (!loggedIn) return false;
      const entry = await searchProtonEntry(this.urlPattern, undefined, this.host);
      return entry !== null && !!entry.password;
    } catch {
      return false;
    }
  }
}

// Export helpers for testing
export { passCliTest, listVaults, searchVault, searchProtonEntry };
