import { PROTON_KEY_PASSWORD_CREDENTIAL_HOST } from '../constants';
import { createProvider, DEFAULT_KEY_PASSWORD_PROVIDER, normalizeProviderName } from '../credentials';
import type { ProviderName } from '../credentials';
import { redactSensitive } from '../utils/redaction';

export interface KeyPasswordStoreOptions {
  provider?: string;
  host?: string;
}

/**
 * Browser-fork key password storage: one credential-provider entry per
 * session UID (the entry's username) at the key-password credential host.
 */
export interface KeyPasswordStore {
  readonly provider: ProviderName;
  readonly host: string;
  store(uid: string, keyPassword: string): Promise<void>;
  /**
   * The stored key password. Rejects when it is missing or unreadable, with
   * the provider's reason as the (redacted) message.
   */
  load(uid: string): Promise<string>;
  remove(uid: string): Promise<void>;
  /** True when {@link load} returns a key password. */
  verify(uid: string): Promise<boolean>;
}

export function normalizeKeyPasswordProvider(provider?: string): ProviderName {
  const name = provider || DEFAULT_KEY_PASSWORD_PROVIDER;
  try {
    return normalizeProviderName(name);
  } catch {
    throw new Error(`Unsupported key password provider: ${name}`);
  }
}

export function createKeyPasswordStore(options: KeyPasswordStoreOptions = {}): KeyPasswordStore {
  return new ProviderBackedKeyPasswordStore(
    normalizeKeyPasswordProvider(options.provider),
    options.host || PROTON_KEY_PASSWORD_CREDENTIAL_HOST,
  );
}

class ProviderBackedKeyPasswordStore implements KeyPasswordStore {
  constructor(
    public readonly provider: ProviderName,
    public readonly host: string,
  ) {}

  async store(uid: string, keyPassword: string): Promise<void> {
    this.assertUid(uid);
    if (!keyPassword) {
      throw new Error('Cannot store an empty key password');
    }
    await createProvider(this.provider, this.host).store(uid, keyPassword);
  }

  async load(uid: string): Promise<string> {
    this.assertUid(uid);
    let password: string;
    try {
      ({ password } = await createProvider(this.provider, this.host).resolve(uid));
    } catch (error) {
      throw new Error(String(redactSensitive(error instanceof Error ? error.message : String(error))));
    }
    if (!password) {
      throw new Error(`The ${this.provider} entry at ${this.host} holds no key password`);
    }
    return password;
  }

  async remove(uid: string): Promise<void> {
    this.assertUid(uid);
    await createProvider(this.provider, this.host).remove(uid);
  }

  async verify(uid: string): Promise<boolean> {
    this.assertUid(uid);
    return this.load(uid).then(() => true, () => false);
  }

  private assertUid(uid: string): void {
    if (!uid || !uid.trim()) {
      throw new Error('UID is required for key password storage');
    }
  }
}
