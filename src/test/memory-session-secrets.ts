import { PROTON_CREDENTIAL_HOST } from '../constants';
import type { CredentialStoreName } from '../credentials/types';
import type { SessionSecrets } from '../types/auth';
import type { SessionSecretStore, SessionSecretStoreOptions } from '../auth/session-secrets';

/**
 * In-memory stand-in for the credential stores behind
 * createSessionSecretStore: entries keyed by store, host and session UID,
 * each with the session.json revision it was written with and the revision
 * it replaces.
 *
 * Install with
 * `jest.mock('<path>/auth/session-secrets', () => jest.requireActual('<path>/test/memory-session-secrets').mockSessionSecretsModule())`.
 */
export class MemorySessionSecrets {
  readonly entries = new Map<string, SessionSecrets>();
  readonly revisions = new Map<string, string>();
  readonly previous = new Map<string, string>();
  readonly loads: string[] = [];
  readonly saves: string[] = [];
  readonly removes: string[] = [];
  readonly created: { store: CredentialStoreName; host: string }[] = [];
  loadError: Error | null = null;
  saveError: Error | null = null;
  /** Failures of the next saves, one per save; `saveError` applies after them. */
  readonly saveFailures: Error[] = [];
  removeError: Error | null = null;
  /** Rejection of checkWritable; every call is recorded in `checks`. */
  checkError: Error | null = null;
  readonly checks: string[] = [];
  /** Called before an entry is read, with its key. */
  onLoad: ((key: string) => void | Promise<void>) | null = null;
  /** Called before an entry is removed, with its key. */
  onRemove: ((key: string) => void | Promise<void>) | null = null;

  static key(store: string, host: string, uid: string): string {
    return `${store}|${host}|${uid}`;
  }

  reset(): void {
    this.entries.clear();
    this.revisions.clear();
    this.previous.clear();
    this.loads.length = 0;
    this.saves.length = 0;
    this.removes.length = 0;
    this.created.length = 0;
    this.loadError = null;
    this.saveError = null;
    this.saveFailures.length = 0;
    this.removeError = null;
    this.checkError = null;
    this.checks.length = 0;
    this.onLoad = null;
    this.onRemove = null;
  }

  /** Put an entry as another process would. */
  put(
    store: CredentialStoreName,
    host: string,
    uid: string,
    secrets: SessionSecrets,
    revision: string,
    previous?: string,
  ): void {
    const key = MemorySessionSecrets.key(store, host, uid);
    this.entries.set(key, { ...secrets });
    this.revisions.set(key, revision);
    if (previous === undefined) {
      this.previous.delete(key);
    } else {
      this.previous.set(key, previous);
    }
  }

  /** The revision the stored entry replaces, as its writer recorded it. */
  previousOf(store: CredentialStoreName, host: string, uid: string): string | undefined {
    return this.previous.get(MemorySessionSecrets.key(store, host, uid));
  }

  get(store: CredentialStoreName, host: string, uid: string): SessionSecrets | undefined {
    return this.entries.get(MemorySessionSecrets.key(store, host, uid));
  }

  create(name: CredentialStoreName, host: string): SessionSecretStore {
    this.created.push({ store: name, host });
    const key = (uid: string) => MemorySessionSecrets.key(name, host, uid);
    return {
      name,
      host,
      save: async (uid, entry) => {
        this.saves.push(key(uid));
        const failure = this.saveFailures.shift();
        if (failure) throw failure;
        if (this.saveError) throw this.saveError;
        this.put(name, host, uid, entry.secrets, entry.revision, entry.previous);
      },
      load: async (uid) => {
        this.loads.push(key(uid));
        await this.onLoad?.(key(uid));
        if (this.loadError) throw this.loadError;
        const entry = this.entries.get(key(uid));
        if (!entry) throw new Error(`No ${name} entry for this session at ${host}`);
        const previous = this.previous.get(key(uid));
        return {
          revision: this.revisions.get(key(uid)) ?? '',
          ...(previous === undefined ? {} : { previous }),
          secrets: { ...entry },
        };
      },
      remove: async (uid) => {
        this.removes.push(key(uid));
        await this.onRemove?.(key(uid));
        if (this.removeError) throw this.removeError;
        this.entries.delete(key(uid));
        this.revisions.delete(key(uid));
        this.previous.delete(key(uid));
      },
      checkWritable: async () => {
        this.checks.push(`${name}|${host}`);
        if (this.checkError) throw this.checkError;
      },
    };
  }
}

export const memorySessionSecrets = new MemorySessionSecrets();

/** Module factory replacing auth/session-secrets.ts: the real helpers, an in-memory createSessionSecretStore. */
export function mockSessionSecretsModule(): Record<string, unknown> {
  const actual = jest.requireActual('../auth/session-secrets') as typeof import('../auth/session-secrets');
  return {
    ...actual,
    createSessionSecretStore: (options: SessionSecretStoreOptions = {}) =>
      memorySessionSecrets.create(actual.normalizeCredentialStore(options.store), options.host || PROTON_CREDENTIAL_HOST),
  };
}
