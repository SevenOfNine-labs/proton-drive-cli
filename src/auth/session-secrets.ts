import { PROTON_CREDENTIAL_HOST } from '../constants';
import { createCredentialStore, DEFAULT_CREDENTIAL_STORE, normalizeCredentialStoreName } from '../credentials';
import type { CredentialStoreName } from '../credentials';
import type { SessionSecrets } from '../types/auth';
import { redactSensitive } from '../utils/redaction';

export interface SessionSecretStoreOptions {
  store?: string;
  host?: string;
}

/**
 * Longest serialized entry: CRED_MAX_CREDENTIAL_BLOB_SIZE (2560 bytes,
 * wincred.h) holds 1280 UTF-16 code units, the encoding of Git's wincred helper.
 */
export const MAX_SESSION_ENTRY_LENGTH = 1280;

/**
 * A stored entry: the secrets, the session.json revision written with them
 * and, for a refresh, the revision they replace.
 */
export interface StoredSessionSecrets {
  revision: string;
  previous?: string;
  secrets: SessionSecrets;
}

/**
 * The secrets of a login session: one credential-store entry per session UID
 * (the entry's username) at the credential host, holding the compact JSON
 * object `{uid, revision, previous?, accessToken, refreshToken, keyPassword}`
 * (RFC 8259).
 */
export interface SessionSecretStore {
  readonly name: CredentialStoreName;
  readonly host: string;
  /** Create or replace the entry, then read it back; rejects unless the store returns what was written. */
  save(uid: string, entry: StoredSessionSecrets): Promise<void>;
  /** The stored entry; rejects with the store's redacted reason when it is missing or unreadable. */
  load(uid: string): Promise<StoredSessionSecrets>;
  remove(uid: string): Promise<void>;
  /** Rejects with the store's redacted reason when `save` could not write an entry; writes nothing. */
  checkWritable(): Promise<void>;
}

export function normalizeCredentialStore(store?: string): CredentialStoreName {
  const name = store || DEFAULT_CREDENTIAL_STORE;
  try {
    return normalizeCredentialStoreName(name);
  } catch {
    throw new Error(`Unsupported credential store: ${name}`);
  }
}

export function createSessionSecretStore(options: SessionSecretStoreOptions = {}): SessionSecretStore {
  return new CredentialSessionSecretStore(
    normalizeCredentialStore(options.store),
    options.host || PROTON_CREDENTIAL_HOST,
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function serializeSessionSecrets(uid: string, stored: StoredSessionSecrets): string {
  const { revision, previous } = stored;
  const { accessToken, refreshToken, keyPassword } = stored.secrets;
  if (![revision, accessToken, refreshToken, keyPassword].every(isNonBlankString)) {
    throw new Error('Session secrets need a non-blank revision, access token, refresh token and key password');
  }
  const entry = JSON.stringify({ uid, revision, previous, accessToken, refreshToken, keyPassword });
  if (entry.length > MAX_SESSION_ENTRY_LENGTH) {
    throw new Error(`Session secrets exceed ${MAX_SESSION_ENTRY_LENGTH} characters`);
  }
  return entry;
}

/** Parse an entry; rejects unless it is the serialized secrets of `uid`. */
export function parseSessionSecrets(uid: string, entry: string): StoredSessionSecrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry);
  } catch {
    throw new Error('The session entry is not JSON');
  }
  const candidate = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (candidate.uid !== uid) {
    throw new Error('The session entry belongs to another session');
  }
  const { revision, previous, accessToken, refreshToken, keyPassword } = candidate;
  if (!isNonBlankString(revision) || !isNonBlankString(accessToken) || !isNonBlankString(refreshToken) || !isNonBlankString(keyPassword)) {
    throw new Error('The session entry lacks a revision, access token, refresh token or key password');
  }
  return {
    revision,
    ...(isNonBlankString(previous) ? { previous } : {}),
    secrets: { accessToken, refreshToken, keyPassword },
  };
}

class CredentialSessionSecretStore implements SessionSecretStore {
  constructor(
    public readonly name: CredentialStoreName,
    public readonly host: string,
  ) {}

  async save(uid: string, entry: StoredSessionSecrets): Promise<void> {
    this.assertUid(uid);
    const serialized = serializeSessionSecrets(uid, entry);
    await createCredentialStore(this.name, this.host).store(uid, serialized);
    let stored: StoredSessionSecrets;
    try {
      stored = await this.load(uid);
    } catch (error) {
      throw new Error(`The ${this.name} entry at ${this.host} could not be read back: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (serializeSessionSecrets(uid, stored) !== serialized) {
      throw new Error(`The ${this.name} entry at ${this.host} did not read back as written`);
    }
  }

  async load(uid: string): Promise<StoredSessionSecrets> {
    this.assertUid(uid);
    try {
      const { password } = await createCredentialStore(this.name, this.host).resolve(uid);
      return parseSessionSecrets(uid, password);
    } catch (error) {
      throw new Error(String(redactSensitive(error instanceof Error ? error.message : String(error))));
    }
  }

  async remove(uid: string): Promise<void> {
    this.assertUid(uid);
    await createCredentialStore(this.name, this.host).remove(uid);
  }

  async checkWritable(): Promise<void> {
    try {
      await createCredentialStore(this.name, this.host).checkWritable();
    } catch (error) {
      throw new Error(String(redactSensitive(error instanceof Error ? error.message : String(error))));
    }
  }

  private assertUid(uid: string): void {
    if (!isNonBlankString(uid)) {
      throw new Error('UID is required for session secrets');
    }
  }
}
