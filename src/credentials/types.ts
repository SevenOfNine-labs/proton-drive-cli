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

/**
 * Provider used for the browser-fork key password when neither the command
 * option nor PROTON_KEY_PASSWORD_PROVIDER selects one. Matches the parent
 * repository's config.DefaultKeyPasswordProvider.
 */
export const DEFAULT_KEY_PASSWORD_PROVIDER = 'pass-cli' satisfies ProviderName;

/**
 * Lookup tuning for providers that search a store. `exhaustiveLookup: false`
 * limits the search to entries whose title identifies the credential host,
 * which is sufficient for entries this CLI created itself.
 */
export interface LookupOptions {
  exhaustiveLookup?: boolean;
}

export interface CredentialProvider {
  readonly name: ProviderName;

  /** Check if this provider is available in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Resolve credentials. Username may be pre-supplied via options. */
  resolve(options?: { username?: string } & LookupOptions): Promise<Credentials>;

  /** Store credentials (optional — not all providers support this). */
  store?(username: string, password: string, options?: LookupOptions): Promise<void>;

  /** Remove credentials (optional). */
  remove?(username: string, options?: LookupOptions): Promise<void>;

  /** Verify that credentials can be resolved (optional). */
  verify?(): Promise<boolean>;
}
