import { PROTON_KEY_PASSWORD_CREDENTIAL_HOST } from '../constants';
import { createProvider, normalizeProviderName } from '../credentials';
import type { ProviderName } from '../credentials';

export type KeyPasswordProviderName = Extract<ProviderName, 'git-credential' | 'pass-cli'>;

export interface KeyPasswordStoreOptions {
  provider?: string;
  host?: string;
}

export interface KeyPasswordStore {
  readonly provider: KeyPasswordProviderName;
  readonly host: string;
  store(uid: string, keyPassword: string): Promise<void>;
  load(uid: string): Promise<string | undefined>;
  remove(uid: string): Promise<void>;
  verify(uid: string): Promise<boolean>;
}

export function normalizeKeyPasswordProvider(provider?: string): KeyPasswordProviderName {
  const normalized = normalizeProviderName(provider || 'git-credential');
  if (normalized !== 'git-credential' && normalized !== 'pass-cli') {
    throw new Error(`Unsupported key password provider: ${provider}`);
  }
  return normalized;
}

export function createKeyPasswordStore(options: KeyPasswordStoreOptions = {}): KeyPasswordStore {
  return new ProviderBackedKeyPasswordStore(
    normalizeKeyPasswordProvider(options.provider),
    options.host || PROTON_KEY_PASSWORD_CREDENTIAL_HOST,
  );
}

class ProviderBackedKeyPasswordStore implements KeyPasswordStore {
  constructor(
    public readonly provider: KeyPasswordProviderName,
    public readonly host: string,
  ) {}

  async store(uid: string, keyPassword: string): Promise<void> {
    this.assertUid(uid);
    if (!keyPassword) {
      throw new Error('Cannot store an empty key password');
    }
    const provider = createProvider(this.provider, { host: this.host });
    if (!provider.store) {
      throw new Error(`Provider ${this.provider} cannot store key passwords`);
    }
    await provider.store(uid, keyPassword);
  }

  async load(uid: string): Promise<string | undefined> {
    this.assertUid(uid);
    try {
      const provider = createProvider(this.provider, { host: this.host });
      const credentials = await provider.resolve({ username: uid });
      return credentials.password || undefined;
    } catch {
      return undefined;
    }
  }

  async remove(uid: string): Promise<void> {
    this.assertUid(uid);
    const provider = createProvider(this.provider, { host: this.host });
    if (!provider.remove) {
      throw new Error(`Provider ${this.provider} cannot remove key passwords`);
    }
    await provider.remove(uid);
  }

  async verify(uid: string): Promise<boolean> {
    return Boolean(await this.load(uid));
  }

  private assertUid(uid: string): void {
    if (!uid || !uid.trim()) {
      throw new Error('UID is required for key password storage');
    }
  }
}
