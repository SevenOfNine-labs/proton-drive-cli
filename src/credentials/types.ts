/**
 * Credential provider types and interfaces.
 *
 * All credential providers implement the CredentialProvider interface,
 * enabling uniform credential resolution across git-credential, pass-cli,
 * stdin, and interactive sources.
 */

export interface Credentials {
  username: string;
  password: string;
}

export type ProviderName = 'git-credential' | 'pass-cli' | 'stdin' | 'interactive';

export interface CredentialProvider {
  readonly name: ProviderName;

  /** Check if this provider is available in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Resolve credentials. Username may be pre-supplied via options. */
  resolve(options?: { username?: string }): Promise<Credentials>;

  /** Store credentials (optional — not all providers support this). */
  store?(username: string, password: string): Promise<void>;

  /** Remove credentials (optional). */
  remove?(username: string): Promise<void>;

  /** Verify that credentials can be resolved (optional). */
  verify?(): Promise<boolean>;
}
