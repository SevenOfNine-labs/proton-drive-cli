/**
 * Credential stores holding the session secrets: one entry per login
 * session, addressed by credential host and username (the session UID) and
 * created by this CLI.
 */

export interface Credentials {
  username: string;
  password: string;
}

export type CredentialStoreName = 'git-credential' | 'pass-cli';

/**
 * Store used when neither the command option nor PROTON_CREDENTIAL_STORE
 * selects one. Matches the parent repository's config.DefaultCredentialStore.
 */
export const DEFAULT_CREDENTIAL_STORE = 'pass-cli' satisfies CredentialStoreName;

export interface CredentialStore {
  readonly name: CredentialStoreName;

  /** Password stored for `username` at the store's host; rejects when no entry exists. */
  resolve(username: string): Promise<Credentials>;

  /** Create or replace the entry for `username`. */
  store(username: string, password: string): Promise<void>;

  /** Rejects with the reason `store` would fail before it writes; writes nothing. */
  checkWritable(): Promise<void>;

  /** Delete every entry for `username` at the store's host; none existing is success. */
  remove(username: string): Promise<void>;
}
