import type { CredentialStore, CredentialStoreName } from './types';
import { GitCredentialStore } from './git-credential';
import { PassCliStore } from './pass-cli';

/**
 * Normalize a credential store name; `git` and `pass` are accepted as
 * aliases of `git-credential` and `pass-cli`.
 */
export function normalizeCredentialStoreName(name: string): CredentialStoreName {
  const normalized = name.trim().toLowerCase();
  switch (normalized) {
    case 'git':
    case 'git-credential':
      return 'git-credential';
    case 'pass':
    case 'pass-cli':
      return 'pass-cli';
    default:
      throw new Error(`Unknown credential store: ${name}`);
  }
}

/** Create the credential store `name` for entries at credential host `host`. */
export function createCredentialStore(name: CredentialStoreName, host: string): CredentialStore {
  switch (name) {
    case 'git-credential':
      return new GitCredentialStore(host);
    case 'pass-cli':
      return new PassCliStore(host);
    default:
      throw new Error(`Unknown credential store: ${name}`);
  }
}
