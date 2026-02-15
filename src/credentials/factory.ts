/**
 * Credential provider factory and orchestration.
 *
 * Provides:
 * - createProvider(): Instantiate a provider by name
 * - normalizeProviderName(): Normalize aliases ('git' → 'git-credential')
 * - resolveCredentials(): Full resolution with fallback chain
 * - resolvePassword(): Thin wrapper for commands that only need a password
 */

import type { CredentialProvider, Credentials, ProviderName } from './types';
import { GitCredentialProvider, gitCredentialFill } from './git-credential';
import { PassCliProvider } from './pass-cli';
import { StdinProvider, readPasswordFromStdin } from './stdin';
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
      return new PassCliProvider();
    case 'stdin':
      return new StdinProvider();
    case 'interactive':
      return new InteractiveProvider();
    default:
      throw new Error(`Unknown credential provider: ${name}`);
  }
}

export interface ResolveOptions {
  provider?: string;
  username?: string;
  passwordStdin?: boolean;
}

/**
 * Resolve credentials with fallback chain:
 * 1. Explicit provider (if specified)
 * 2. Stdin (if piped)
 * 3. Interactive (if TTY)
 * 4. Error
 */
export async function resolveCredentials(options: ResolveOptions): Promise<Credentials> {
  // 1. Explicit provider
  if (options.provider) {
    const name = normalizeProviderName(options.provider);
    const provider = createProvider(name);
    return provider.resolve({ username: options.username });
  }

  // 2. --credential-provider git (legacy compat: 'git' as credentialProvider)
  // This path is kept for backward compatibility with existing CLI options

  // 3. Stdin (piped)
  if (options.passwordStdin || !process.stdin.isTTY) {
    const password = await readPasswordFromStdin();
    if (!options.username) {
      throw new Error('Username is required when reading password from stdin');
    }
    return { username: options.username, password };
  }

  // 4. Interactive
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const interactive = new InteractiveProvider();
    return interactive.resolve({ username: options.username });
  }

  throw new Error(
    'No credential source available. Use --credential-provider, --password-stdin, or run interactively.',
  );
}

/**
 * Resolve password only (backward-compatible wrapper).
 *
 * Used by the 8 drive CLI commands (ls, upload, download, etc.) that only
 * need a password for SDK client creation.
 *
 * Resolution order:
 * 1. --credential-provider git → git credential fill (returns password)
 * 2. --credential-provider pass-cli → pass-cli search (returns password)
 * 3. --password-stdin (piped password)
 * 4. Interactive prompt (if TTY)
 * 5. Error
 */
export async function resolvePassword(options: {
  passwordStdin?: boolean;
  credentialProvider?: string;
}): Promise<string> {
  // Handle credential providers that return both username + password
  if (options.credentialProvider) {
    const name = normalizeProviderName(options.credentialProvider);
    if (name === 'git-credential') {
      const cred = await gitCredentialFill();
      return cred.password;
    }
    if (name === 'pass-cli') {
      const provider = new PassCliProvider();
      const cred = await provider.resolve();
      return cred.password;
    }
  }

  // Stdin (piped)
  if (options.passwordStdin || !process.stdin.isTTY) {
    return readPasswordFromStdin();
  }

  // Interactive prompt (password only)
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const inquirer = await import('inquirer');
    const answers = await inquirer.default.prompt([
      {
        type: 'password',
        name: 'password',
        message: 'Password (for key decryption):',
        mask: '*',
        validate: (input: string) => input.length > 0 || 'Password is required',
      },
    ]);
    return answers.password;
  }

  throw new Error(
    'Password required for key decryption. Use --credential-provider git, --password-stdin, or run interactively.',
  );
}
