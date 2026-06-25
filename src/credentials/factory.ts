/**
 * Credential provider factory and orchestration.
 *
 * Provides:
 * - createProvider(): Instantiate a provider by name
 * - normalizeProviderName(): Normalize aliases ('git' → 'git-credential')
 */

import type { CredentialProvider, ProviderName } from './types';
import { GitCredentialProvider } from './git-credential';
import { PassCliProvider } from './pass-cli';
import { StdinProvider } from './stdin';
import { InteractiveProvider } from './interactive';

export interface ProviderOptions {
  host?: string;
}

/**
 * Normalize provider name aliases.
 *   'git' → 'git-credential'
 *   'pass' → 'pass-cli'
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
    case 'stdin':
      return 'stdin';
    case 'interactive':
      return 'interactive';
    default:
      throw new Error(`Unknown credential provider: ${name}`);
  }
}

/**
 * Create a credential provider instance by name.
 */
export function createProvider(name: ProviderName, options?: ProviderOptions): CredentialProvider {
  switch (name) {
    case 'git-credential':
      return new GitCredentialProvider(options?.host);
    case 'pass-cli':
      return new PassCliProvider(options?.host);
    case 'stdin':
      return new StdinProvider();
    case 'interactive':
      return new InteractiveProvider();
    default:
      throw new Error(`Unknown credential provider: ${name}`);
  }
}
