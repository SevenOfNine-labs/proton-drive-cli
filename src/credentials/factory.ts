import type { CredentialProvider, ProviderName } from './types';
import { GitCredentialProvider } from './git-credential';
import { PassCliProvider } from './pass-cli';

/**
 * Normalize a provider name; `git` and `pass` are accepted as aliases of
 * `git-credential` and `pass-cli`.
 */
export function normalizeProviderName(name: string): ProviderName {
  const normalized = name.trim().toLowerCase();
  switch (normalized) {
    case 'git':
    case 'git-credential':
      return 'git-credential';
    case 'pass':
    case 'pass-cli':
      return 'pass-cli';
    default:
      throw new Error(`Unknown credential provider: ${name}`);
  }
}

/** Create the provider `name` for entries at credential host `host`. */
export function createProvider(name: ProviderName, host: string): CredentialProvider {
  switch (name) {
    case 'git-credential':
      return new GitCredentialProvider(host);
    case 'pass-cli':
      return new PassCliProvider(host);
    default:
      throw new Error(`Unknown credential provider: ${name}`);
  }
}
