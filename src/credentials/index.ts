/**
 * Unified credential provider module.
 *
 * Barrel export for all credential types, providers, and helpers.
 */

export type { Credentials, CredentialProvider, LookupOptions, ProviderName } from './types';
export { DEFAULT_KEY_PASSWORD_PROVIDER } from './types';

export { GitCredentialProvider, gitCredentialFill, gitCredentialApprove, gitCredentialReject, assertCredentialValue } from './git-credential';
export type { GitCredential } from './git-credential';

export { PassCliProvider } from './pass-cli';
export { StdinProvider, readPasswordFromStdin } from './stdin';
export { InteractiveProvider } from './interactive';

export {
  createProvider,
  normalizeProviderName,
} from './factory';
export type { ProviderOptions } from './factory';
