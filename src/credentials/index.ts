/**
 * Unified credential provider module.
 *
 * Barrel export for all credential types, providers, and helpers.
 */

export type { Credentials, CredentialProvider, ProviderName } from './types';

export { GitCredentialProvider, gitCredentialFill, gitCredentialApprove, gitCredentialReject } from './git-credential';
export type { GitCredential } from './git-credential';

export { PassCliProvider } from './pass-cli';
export { StdinProvider, readPasswordFromStdin } from './stdin';
export { InteractiveProvider } from './interactive';

export {
  createProvider,
  normalizeProviderName,
  resolveCredentials,
  resolvePassword,
} from './factory';
export type { ProviderOptions, ResolveOptions } from './factory';
