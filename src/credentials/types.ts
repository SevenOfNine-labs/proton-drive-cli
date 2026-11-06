/**
 * Credential providers holding the browser-fork key password. Entries are
 * addressed by credential host and username (the session UID) and are
 * created by this CLI.
 */

export interface Credentials {
  username: string;
  password: string;
}

export type ProviderName = 'git-credential' | 'pass-cli';

/**
 * Provider used for the browser-fork key password when neither the command
 * option nor PROTON_KEY_PASSWORD_PROVIDER selects one. Matches the parent
 * repository's config.DefaultKeyPasswordProvider.
 */
export const DEFAULT_KEY_PASSWORD_PROVIDER = 'pass-cli' satisfies ProviderName;

export interface CredentialProvider {
  readonly name: ProviderName;

  /** Password stored for `username` at the provider's host; rejects when no entry exists. */
  resolve(username: string): Promise<Credentials>;

  /** Create or replace the entry for `username`. */
  store(username: string, password: string): Promise<void>;

  /** Delete every entry for `username` at the provider's host. */
  remove(username: string): Promise<void>;
}
