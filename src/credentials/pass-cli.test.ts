import { PassCliProvider, passCliTest, listVaults, searchVault, searchProtonEntry } from './pass-cli';
import * as childProcess from 'child_process';

jest.mock('child_process');

const mockExecFile = childProcess.execFile as unknown as jest.Mock;

function simulateExecFile(stdout: string, stderr = '', exitCode = 0) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    if (exitCode !== 0) {
      const error = new Error(`exit code ${exitCode}`) as any;
      error.code = exitCode;
      cb(error, stdout, stderr);
    } else {
      cb(null, stdout, stderr);
    }
  });
}

function simulateExecFileError(message: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(new Error(message), '', '');
  });
}

/** Simulate sequential calls with different responses. */
function simulateSequentialCalls(...responses: Array<{ stdout: string; error?: string }>) {
  let callIdx = 0;
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    const resp = responses[callIdx] || responses[responses.length - 1];
    callIdx++;
    if (resp.error) {
      cb(new Error(resp.error), '', '');
    } else {
      cb(null, resp.stdout, '');
    }
  });
}

/** Helper: build a pass-cli login item in the real nested JSON structure. */
function makePassCliItem(opts: {
  title: string;
  email?: string;
  username?: string;
  password?: string;
  urls?: string[];
  state?: string;
}) {
  return {
    id: 'item-id',
    share_id: 'share-id',
    vault_id: 'vault-id',
    content: {
      title: opts.title,
      note: '',
      item_uuid: 'uuid',
      content: {
        Login: {
          email: opts.email || '',
          username: opts.username || '',
          password: opts.password || '',
          urls: opts.urls || [],
          totp_uri: '',
          passkeys: [],
        },
      },
      extra_fields: [],
    },
    state: opts.state || 'Active',
    flags: [],
  };
}

/** Wrap items in { items: [...] } like real pass-cli output. */
function wrapItems(items: any[]) {
  return JSON.stringify({ items });
}

describe('passCliTest', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns true when pass-cli test succeeds', async () => {
    simulateExecFile('');
    expect(await passCliTest()).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'pass-cli',
      ['test'],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it('returns false when pass-cli test fails', async () => {
    simulateExecFileError('not logged in');
    expect(await passCliTest()).toBe(false);
  });

  it('respects PROTON_PASS_CLI_BIN env var', async () => {
    const originalEnv = process.env.PROTON_PASS_CLI_BIN;
    process.env.PROTON_PASS_CLI_BIN = '/custom/pass-cli';
    simulateExecFile('');

    await passCliTest();

    expect(mockExecFile).toHaveBeenCalledWith(
      '/custom/pass-cli',
      ['test'],
      expect.any(Object),
      expect.any(Function),
    );

    if (originalEnv === undefined) {
      delete process.env.PROTON_PASS_CLI_BIN;
    } else {
      process.env.PROTON_PASS_CLI_BIN = originalEnv;
    }
  });
});

describe('listVaults', () => {
  beforeEach(() => jest.resetAllMocks());

  it('parses vault list from array response', async () => {
    simulateExecFile(JSON.stringify([
      { id: 'v1', name: 'Personal' },
      { id: 'v2', name: 'Work' },
    ]));

    const vaults = await listVaults();
    expect(vaults).toEqual([
      { id: 'v1', name: 'Personal' },
      { id: 'v2', name: 'Work' },
    ]);
  });

  it('parses vault list from object response with vault_id', async () => {
    simulateExecFile(JSON.stringify({
      vaults: [{ vault_id: 'vid1', name: 'Personal' }],
    }));

    const vaults = await listVaults();
    expect(vaults).toEqual([{ id: 'vid1', name: 'Personal' }]);
  });

  it('parses vault list from object response with id', async () => {
    simulateExecFile(JSON.stringify({
      vaults: [{ id: 'v1', name: 'Personal' }],
    }));

    const vaults = await listVaults();
    expect(vaults).toEqual([{ id: 'v1', name: 'Personal' }]);
  });

  it('throws on invalid JSON', async () => {
    simulateExecFile('not json');
    await expect(listVaults()).rejects.toThrow();
  });
});

describe('searchVault', () => {
  beforeEach(() => jest.resetAllMocks());

  it('finds login items with proton.me URL', async () => {
    simulateExecFile(wrapItems([
      makePassCliItem({ title: 'Proton', username: 'user', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      makePassCliItem({ title: 'GitHub', username: 'other', password: 'pw', urls: ['https://github.com'] }),
    ]));

    const results = await searchVault('Personal');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Proton');
    expect(results[0].password).toBe('pass');
  });

  it('returns empty array when no matches', async () => {
    simulateExecFile(wrapItems([
      makePassCliItem({ title: 'Other', username: 'other', password: 'pw', urls: ['https://github.com'] }),
    ]));

    const results = await searchVault('Personal');
    expect(results).toHaveLength(0);
  });

  it('matches proton.me URL case-insensitively', async () => {
    simulateExecFile(wrapItems([
      makePassCliItem({ title: 'Proton', username: 'user', password: 'pass', urls: ['https://PROTON.ME/login'] }),
    ]));

    const results = await searchVault('Personal');
    expect(results).toHaveLength(1);
  });

  it('handles bare array response (backward compat)', async () => {
    simulateExecFile(JSON.stringify([
      makePassCliItem({ title: 'Proton', email: 'u@proton.me', password: 'p', urls: ['https://proton.me'] }),
    ]));

    const results = await searchVault('Personal');
    expect(results).toHaveLength(1);
  });
});

describe('searchProtonEntry', () => {
  beforeEach(() => jest.resetAllMocks());

  it('finds entry in first vault', async () => {
    simulateSequentialCalls(
      // listVaults
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      // searchVault('Personal')
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const entry = await searchProtonEntry();
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe('user@proton.me');
  });

  it('searches subsequent vaults if first has no match', async () => {
    simulateSequentialCalls(
      // listVaults
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Work' }, { vault_id: 'v2', name: 'Personal' }] }) },
      // searchVault('Work') — no match
      { stdout: wrapItems([]) },
      // searchVault('Personal') — match
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const entry = await searchProtonEntry();
    expect(entry).not.toBeNull();
  });

  it('returns null when no vaults have a match', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([]) },
    );

    const entry = await searchProtonEntry();
    expect(entry).toBeNull();
  });
});

describe('PassCliProvider', () => {
  beforeEach(() => jest.resetAllMocks());

  it('isAvailable returns true when pass-cli test succeeds', async () => {
    simulateExecFile('');
    const provider = new PassCliProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when pass-cli test fails', async () => {
    simulateExecFileError('not installed');
    const provider = new PassCliProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('resolve returns credentials from vault entry', async () => {
    simulateSequentialCalls(
      // passCliTest
      { stdout: '' },
      // listVaults
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      // searchVault
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'user@proton.me', password: 's3cret', urls: ['https://proton.me'] }),
      ]) },
    );

    const provider = new PassCliProvider();
    const creds = await provider.resolve();
    expect(creds).toEqual({ username: 'user@proton.me', password: 's3cret' });
  });

  it('resolve prefers username field when email is empty', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', username: 'agent.user', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const provider = new PassCliProvider();
    const creds = await provider.resolve();
    expect(creds.username).toBe('agent.user');
  });

  it('resolve uses username from options over entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'vault@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const provider = new PassCliProvider();
    const creds = await provider.resolve({ username: 'override@proton.me' });
    expect(creds.username).toBe('override@proton.me');
  });

  it('resolve throws when pass-cli is not logged in', async () => {
    simulateExecFileError('not logged in');
    const provider = new PassCliProvider();
    await expect(provider.resolve()).rejects.toThrow('pass-cli is not logged in');
  });

  it('resolve throws when no entry found', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([]) },
    );

    const provider = new PassCliProvider();
    await expect(provider.resolve()).rejects.toThrow('No Proton login entry found');
  });

  it('store calls pass-cli item create with vault name', async () => {
    simulateSequentialCalls(
      // listVaults
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      // item create
      { stdout: '' },
    );
    const provider = new PassCliProvider();
    await provider.store('user@proton.me', 'password123');

    // Second call should be the item create
    const createCall = mockExecFile.mock.calls[1];
    expect(createCall[1]).toEqual([
      'item', 'create', 'login',
      '--vault-name', 'Personal',
      '--title', 'Proton',
      '--email', 'user@proton.me',
      '--password', 'password123',
      '--url', 'https://proton.me',
    ]);
  });

  it('verify returns true when entry exists with password', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const provider = new PassCliProvider();
    expect(await provider.verify()).toBe(true);
  });

  it('verify returns false when not logged in', async () => {
    simulateExecFileError('not logged in');
    const provider = new PassCliProvider();
    expect(await provider.verify()).toBe(false);
  });
});
