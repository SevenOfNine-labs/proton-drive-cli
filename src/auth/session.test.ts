import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

// We need to mock the module-level constants before importing SessionManager
let mockSessionDir: string;
let mockSessionFile: string;

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: () => mockSessionDir,
  };
});

// Re-require after mock so module-level constants use mocked homedir
// We need to isolate the module to pick up the mock
let SessionManager: any;

beforeAll(() => {
  // Clear the module cache so the mock takes effect
  jest.resetModules();
});

beforeEach(async () => {
  // Create a unique temp dir for each test
  mockSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-test-'));
  mockSessionFile = path.join(mockSessionDir, '.proton-drive-cli', 'session.json');

  // Re-require with fresh module to pick up new mockSessionDir
  jest.resetModules();
  const mod = require('./session');
  SessionManager = mod.SessionManager;
});

afterEach(async () => {
  await fs.remove(mockSessionDir);
});

const VALID_SESSION = {
  sessionId: 'test-session-id',
  uid: 'test-uid-123',
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo5OTk5OTk5OTk5fQ.K3DEMO',
  refreshToken: 'refresh-token-abc',
  scopes: ['self', 'drive'],
  passwordMode: 1,
};

describe('SessionManager.saveSession', () => {
  it('creates directory and file', async () => {
    await SessionManager.saveSession(VALID_SESSION);

    const sessionDir = path.join(mockSessionDir, '.proton-drive-cli');
    expect(await fs.pathExists(sessionDir)).toBe(true);
    expect(await fs.pathExists(path.join(sessionDir, 'session.json'))).toBe(true);
  });

  it('writes valid JSON that can be read back', async () => {
    await SessionManager.saveSession(VALID_SESSION);

    const sessionFile = path.join(mockSessionDir, '.proton-drive-cli', 'session.json');
    const data = await fs.readJson(sessionFile);
    expect(data.sessionId).toBe(VALID_SESSION.sessionId);
    expect(data.uid).toBe(VALID_SESSION.uid);
  });

  it('strips mailboxPassword from disk', async () => {
    const sessionWithPassword = {
      ...VALID_SESSION,
      mailboxPassword: 'super-secret-password',
    };
    await SessionManager.saveSession(sessionWithPassword);

    const sessionFile = path.join(mockSessionDir, '.proton-drive-cli', 'session.json');
    const raw = await fs.readJson(sessionFile);
    expect(raw).not.toHaveProperty('mailboxPassword');
  });

  it('preserves all other session fields when stripping password', async () => {
    const sessionWithPassword = {
      ...VALID_SESSION,
      mailboxPassword: 'super-secret-password',
    };
    await SessionManager.saveSession(sessionWithPassword);

    const sessionFile = path.join(mockSessionDir, '.proton-drive-cli', 'session.json');
    const raw = await fs.readJson(sessionFile);
    expect(raw.sessionId).toBe(VALID_SESSION.sessionId);
    expect(raw.uid).toBe(VALID_SESSION.uid);
    expect(raw.accessToken).toBe(VALID_SESSION.accessToken);
    expect(raw.refreshToken).toBe(VALID_SESSION.refreshToken);
    expect(raw.scopes).toEqual(VALID_SESSION.scopes);
    expect(raw.passwordMode).toBe(VALID_SESSION.passwordMode);
  });
});

describe('SessionManager.loadSession', () => {
  it('returns valid session', async () => {
    await SessionManager.saveSession(VALID_SESSION);
    const loaded = await SessionManager.loadSession();
    expect(loaded).toBeTruthy();
    expect(loaded.uid).toBe(VALID_SESSION.uid);
  });

  it('returns null for missing file', async () => {
    const loaded = await SessionManager.loadSession();
    expect(loaded).toBeNull();
  });

  it('returns null for corrupted JSON', async () => {
    const sessionDir = path.join(mockSessionDir, '.proton-drive-cli');
    await fs.ensureDir(sessionDir);
    await fs.writeFile(path.join(sessionDir, 'session.json'), '{invalid json');
    const loaded = await SessionManager.loadSession();
    expect(loaded).toBeNull();
  });

  it('returns null for invalid session (missing fields)', async () => {
    const sessionDir = path.join(mockSessionDir, '.proton-drive-cli');
    await fs.ensureDir(sessionDir);
    await fs.writeJson(path.join(sessionDir, 'session.json'), { uid: 'only-uid' });
    const loaded = await SessionManager.loadSession();
    expect(loaded).toBeNull();
  });
});

describe('SessionManager.clearSession', () => {
  it('removes session file', async () => {
    await SessionManager.saveSession(VALID_SESSION);
    await SessionManager.clearSession();

    const sessionFile = path.join(mockSessionDir, '.proton-drive-cli', 'session.json');
    expect(await fs.pathExists(sessionFile)).toBe(false);
  });

  it('does not throw if file is already missing', async () => {
    await expect(SessionManager.clearSession()).resolves.not.toThrow();
  });
});

describe('SessionManager.hasValidSession', () => {
  it('returns true when valid session exists', async () => {
    await SessionManager.saveSession(VALID_SESSION);
    expect(await SessionManager.hasValidSession()).toBe(true);
  });

  it('returns false when no session exists', async () => {
    expect(await SessionManager.hasValidSession()).toBe(false);
  });
});

describe('SessionManager.hashUsername', () => {
  it('produces consistent hash', () => {
    const h1 = SessionManager.hashUsername('test@example.com');
    const h2 = SessionManager.hashUsername('test@example.com');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });

  it('normalizes case and whitespace', () => {
    expect(SessionManager.hashUsername('Test@Example.COM')).toBe(
      SessionManager.hashUsername('test@example.com')
    );
    expect(SessionManager.hashUsername('  test@example.com  ')).toBe(
      SessionManager.hashUsername('test@example.com')
    );
  });

  it('produces different hashes for different users', () => {
    expect(SessionManager.hashUsername('alice@example.com')).not.toBe(
      SessionManager.hashUsername('bob@example.com')
    );
  });
});

describe('SessionManager.isSessionForUser', () => {
  it('returns true when session has matching userHash', async () => {
    const sessionWithHash = {
      ...VALID_SESSION,
      userHash: SessionManager.hashUsername('test@example.com'),
    };
    await SessionManager.saveSession(sessionWithHash);
    expect(await SessionManager.isSessionForUser('test@example.com')).toBe(true);
  });

  it('returns false when session has different userHash', async () => {
    const sessionWithHash = {
      ...VALID_SESSION,
      userHash: SessionManager.hashUsername('alice@example.com'),
    };
    await SessionManager.saveSession(sessionWithHash);
    expect(await SessionManager.isSessionForUser('bob@example.com')).toBe(false);
  });

  it('returns true for legacy sessions without userHash', async () => {
    await SessionManager.saveSession(VALID_SESSION);
    expect(await SessionManager.isSessionForUser('anyone@example.com')).toBe(true);
  });

  it('returns false when no session exists', async () => {
    expect(await SessionManager.isSessionForUser('test@example.com')).toBe(false);
  });
});
