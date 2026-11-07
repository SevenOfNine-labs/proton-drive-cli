import { createCredentialStore } from '../credentials';
import type { CredentialStore } from '../credentials';
import {
  createSessionSecretStore,
  MAX_SESSION_ENTRY_LENGTH,
  normalizeCredentialStore,
  parseSessionSecrets,
  serializeSessionSecrets,
} from './session-secrets';

jest.mock('../credentials', () => {
  const actual = jest.requireActual('../credentials');
  return { ...actual, createCredentialStore: jest.fn() };
});

const mockCreateCredentialStore = createCredentialStore as jest.MockedFunction<typeof createCredentialStore>;

const secrets = { accessToken: 'access', refreshToken: 'refresh', keyPassword: 'key-password' };
const REV = 'rev-1';

function memoryStore(): CredentialStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    name: 'git-credential',
    entries,
    resolve: jest.fn(async (username: string) => {
      const password = entries.get(username);
      if (password === undefined) throw new Error('git credential fill returned no entry for this session');
      return { username, password };
    }),
    store: jest.fn(async (username: string, password: string) => {
      entries.set(username, password);
    }),
    remove: jest.fn(async (username: string) => {
      entries.delete(username);
    }),
  };
}

describe('session secret serialization', () => {
  it('round-trips the secrets and revision of a session UID as compact JSON (RFC 8259)', () => {
    const entry = serializeSessionSecrets('uid-1', { revision: REV, secrets });

    expect(entry).toBe(
      '{"uid":"uid-1","revision":"rev-1","accessToken":"access","refreshToken":"refresh","keyPassword":"key-password"}',
    );
    expect(entry).not.toMatch(/[\r\n]/);
    expect(parseSessionSecrets('uid-1', entry)).toEqual({ revision: REV, secrets });
  });

  it('round-trips the revision an entry replaces and omits it when there is none', () => {
    const entry = serializeSessionSecrets('uid-1', { revision: 'rev-2', previous: REV, secrets });

    expect(entry).toBe(
      '{"uid":"uid-1","revision":"rev-2","previous":"rev-1","accessToken":"access","refreshToken":"refresh","keyPassword":"key-password"}',
    );
    expect(parseSessionSecrets('uid-1', entry)).toEqual({ revision: 'rev-2', previous: REV, secrets });
    expect(serializeSessionSecrets('uid-1', { revision: REV, previous: undefined, secrets })).not.toContain('previous');
    expect(parseSessionSecrets('uid-1', JSON.stringify({ uid: 'uid-1', revision: REV, previous: ' ', ...secrets }))).toEqual({
      revision: REV,
      secrets,
    });
  });

  it('escapes line breaks so the entry stays one git-credential(1) attribute line', () => {
    const entry = serializeSessionSecrets('uid-1', { revision: REV, secrets: { ...secrets, keyPassword: 'line\nbreak\r' } });

    expect(entry).not.toMatch(/[\r\n]/);
    expect(parseSessionSecrets('uid-1', entry).secrets.keyPassword).toBe('line\nbreak\r');
  });

  it('rejects the entry of another session UID', () => {
    expect(() => parseSessionSecrets('uid-2', serializeSessionSecrets('uid-1', { revision: REV, secrets }))).toThrow(
      'The session entry belongs to another session',
    );
  });

  it.each(['accessToken', 'refreshToken', 'keyPassword'] as const)('rejects a blank or missing %s', (field) => {
    expect(() => serializeSessionSecrets('uid-1', { revision: REV, secrets: { ...secrets, [field]: ' ' } })).toThrow('non-blank');
    const { [field]: _omitted, ...partial } = secrets;
    expect(() => parseSessionSecrets('uid-1', JSON.stringify({ uid: 'uid-1', revision: REV, ...partial }))).toThrow(
      'lacks a revision, access token, refresh token or key password',
    );
    expect(() => parseSessionSecrets('uid-1', JSON.stringify({ uid: 'uid-1', revision: REV, ...secrets, [field]: 7 }))).toThrow();
  });

  it('rejects an entry without a revision and refuses to write a blank one', () => {
    expect(() => serializeSessionSecrets('uid-1', { revision: ' ', secrets })).toThrow('non-blank revision');
    expect(() => parseSessionSecrets('uid-1', JSON.stringify({ uid: 'uid-1', ...secrets }))).toThrow(
      'lacks a revision, access token, refresh token or key password',
    );
    expect(() => parseSessionSecrets('uid-1', JSON.stringify({ uid: 'uid-1', revision: 7, ...secrets }))).toThrow(
      'lacks a revision',
    );
  });

  it('rejects an entry that is not JSON or not an object', () => {
    expect(() => parseSessionSecrets('uid-1', 'key-password')).toThrow('The session entry is not JSON');
    expect(() => parseSessionSecrets('uid-1', 'null')).toThrow('belongs to another session');
  });

  it(`rejects an entry longer than ${MAX_SESSION_ENTRY_LENGTH} characters (CRED_MAX_CREDENTIAL_BLOB_SIZE in UTF-16)`, () => {
    const overhead = serializeSessionSecrets('uid-1', { revision: REV, secrets: { ...secrets, keyPassword: 'k' } }).length - 1;
    const fits = 'k'.repeat(MAX_SESSION_ENTRY_LENGTH - overhead);

    expect(serializeSessionSecrets('uid-1', { revision: REV, secrets: { ...secrets, keyPassword: fits } })).toHaveLength(MAX_SESSION_ENTRY_LENGTH);
    expect(() => serializeSessionSecrets('uid-1', { revision: REV, secrets: { ...secrets, keyPassword: `${fits}k` } })).toThrow(
      `exceed ${MAX_SESSION_ENTRY_LENGTH} characters`,
    );
  });
});

describe('normalizeCredentialStore', () => {
  it('defaults to pass-cli and accepts the aliases', () => {
    expect(normalizeCredentialStore()).toBe('pass-cli');
    expect(normalizeCredentialStore('git')).toBe('git-credential');
    expect(normalizeCredentialStore('PASS')).toBe('pass-cli');
  });

  it('rejects an unknown store', () => {
    expect(() => normalizeCredentialStore('keychain')).toThrow('Unsupported credential store: keychain');
  });
});

describe('createSessionSecretStore', () => {
  beforeEach(() => {
    mockCreateCredentialStore.mockReset();
  });

  it('addresses one entry per session UID at the default credential host', async () => {
    const store = memoryStore();
    mockCreateCredentialStore.mockReturnValue(store);

    const sessionStore = createSessionSecretStore({ store: 'git-credential' });
    await sessionStore.save('uid-1', { revision: REV, secrets });

    expect(sessionStore.name).toBe('git-credential');
    expect(sessionStore.host).toBe('proton-drive-cli.invalid');
    expect(mockCreateCredentialStore).toHaveBeenCalledWith('git-credential', 'proton-drive-cli.invalid');
    expect(store.entries.get('uid-1')).toBe(serializeSessionSecrets('uid-1', { revision: REV, secrets }));
    await expect(sessionStore.load('uid-1')).resolves.toEqual({ revision: REV, secrets });
    await sessionStore.remove('uid-1');
    expect(store.entries.has('uid-1')).toBe(false);
  });

  it('saves and loads the revision the entry replaces', async () => {
    const store = memoryStore();
    mockCreateCredentialStore.mockReturnValue(store);
    const sessionStore = createSessionSecretStore({ store: 'git-credential' });

    await sessionStore.save('uid-1', { revision: 'rev-2', previous: REV, secrets });

    await expect(sessionStore.load('uid-1')).resolves.toEqual({ revision: 'rev-2', previous: REV, secrets });
  });

  it('reads the entry back after saving it', async () => {
    const store = memoryStore();
    mockCreateCredentialStore.mockReturnValue(store);

    await createSessionSecretStore({ store: 'git-credential', host: 'h.invalid' }).save('uid-1', { revision: REV, secrets });

    expect(store.store).toHaveBeenCalledTimes(1);
    expect(store.resolve).toHaveBeenCalledWith('uid-1');
  });

  it('rejects a save the store does not return as written', async () => {
    const store = memoryStore();
    (store.resolve as jest.Mock).mockResolvedValue({
      username: 'uid-1',
      password: serializeSessionSecrets('uid-1', { revision: REV, secrets: { ...secrets, refreshToken: 'stale' } }),
    });
    mockCreateCredentialStore.mockReturnValue(store);

    await expect(createSessionSecretStore({ store: 'git-credential', host: 'h.invalid' }).save('uid-1', { revision: REV, secrets })).rejects.toThrow(
      'The git-credential entry at h.invalid did not read back as written',
    );
  });

  it('rejects a save that reads back with another revision', async () => {
    const store = memoryStore();
    (store.resolve as jest.Mock).mockResolvedValue({
      username: 'uid-1',
      password: serializeSessionSecrets('uid-1', { revision: 'rev-older', secrets }),
    });
    mockCreateCredentialStore.mockReturnValue(store);

    await expect(createSessionSecretStore({ store: 'git-credential', host: 'h.invalid' }).save('uid-1', { revision: REV, secrets })).rejects.toThrow(
      'did not read back as written',
    );
  });

  it('rejects a save the store cannot read back and keeps the reason', async () => {
    const store = memoryStore();
    (store.resolve as jest.Mock).mockRejectedValue(new Error('pass-cli is not logged in. Run: pass-cli login'));
    mockCreateCredentialStore.mockReturnValue(store);

    await expect(createSessionSecretStore({ store: 'git-credential', host: 'h.invalid' }).save('uid-1', { revision: REV, secrets })).rejects.toThrow(
      'The git-credential entry at h.invalid could not be read back: pass-cli is not logged in. Run: pass-cli login',
    );
  });

  it('redacts secrets in the reason of a failed load', async () => {
    const store = memoryStore();
    (store.resolve as jest.Mock).mockRejectedValue(new Error('helper said password=hunter2 and Bearer abc.def'));
    mockCreateCredentialStore.mockReturnValue(store);

    const failure = await createSessionSecretStore({ store: 'git-credential' }).load('uid-1').then(
      () => { throw new Error('load resolved'); },
      (error: Error) => error,
    );

    expect(failure.message).not.toContain('hunter2');
    expect(failure.message).not.toContain('abc.def');
    expect(failure.message).toContain('[redacted]');
  });

  it('rejects an entry of another session as unreadable', async () => {
    const store = memoryStore();
    store.entries.set('uid-1', serializeSessionSecrets('uid-other', { revision: REV, secrets }));
    mockCreateCredentialStore.mockReturnValue(store);

    await expect(createSessionSecretStore({ store: 'git-credential' }).load('uid-1')).rejects.toThrow('belongs to another session');
  });

  it('requires a session UID', async () => {
    mockCreateCredentialStore.mockReturnValue(memoryStore());
    const sessionStore = createSessionSecretStore({ store: 'pass-cli' });

    await expect(sessionStore.save(' ', { revision: REV, secrets })).rejects.toThrow('UID is required');
    await expect(sessionStore.load('')).rejects.toThrow('UID is required');
    await expect(sessionStore.remove('')).rejects.toThrow('UID is required');
  });
});
