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

function makePassCliMetadataItem(opts: {
  title: string;
  id?: string;
  shareId?: string;
  vaultId?: string;
}) {
  return {
    id: opts.id || 'item-id',
    share_id: opts.shareId || 'share-id',
    vault_id: opts.vaultId || 'vault-id',
    title: opts.title,
    item_type: 'login',
    state: 'Active',
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

  it('preserves vault share ids for stable all-vault item lookup', async () => {
    simulateExecFile(JSON.stringify({
      vaults: [{
        vault_id: 'vid1',
        share_id: 'share1',
        name: 'Seven of Nine [dev]',
      }],
    }));

    const vaults = await listVaults();
    expect(vaults).toEqual([{
      id: 'vid1',
      shareId: 'share1',
      name: 'Seven of Nine [dev]',
    }]);
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

  it('rejects Proton-titled entries with non-matching URLs', async () => {
    simulateExecFile(wrapItems([
      makePassCliItem({
        title: 'Proton Mail Bridge (assistant@example.test)',
        username: 'assistant@example.test',
        password: 'bridge-password',
        urls: ['imap://127.0.0.1:1143', 'smtps://127.0.0.1:1025'],
      }),
    ]));

    const results = await searchVault('Personal');
    expect(results).toHaveLength(0);
  });

  it('handles bare array response (backward compat)', async () => {
    simulateExecFile(JSON.stringify([
      makePassCliItem({ title: 'Proton', email: 'u@proton.me', password: 'p', urls: ['https://proton.me'] }),
    ]));

    const results = await searchVault('Personal');
    expect(results).toHaveLength(1);
  });

  it('lists a vault by share id when available', async () => {
    simulateExecFile(wrapItems([
      makePassCliItem({ title: 'Proton', username: 'user', password: 'pass', urls: ['https://proton.me'] }),
    ]));

    const results = await searchVault({ name: 'Seven of Nine [dev]', shareId: 'share-dev' });
    expect(results).toHaveLength(1);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      'pass-cli',
      ['item', 'list', '--share-id', 'share-dev', '--filter-type', 'login', '--output', 'json'],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it('hydrates metadata-only proton title matches through item view', async () => {
    simulateSequentialCalls(
      { stdout: wrapItems([
        makePassCliMetadataItem({ title: 'proton.me', id: 'item-123', shareId: 'share-456' }),
        makePassCliMetadataItem({ title: 'github.com' }),
      ]) },
      { stdout: JSON.stringify({
        item: makePassCliItem({
          title: 'proton.me',
          email: 'user@proton.me',
          password: 'pass',
          urls: ['https://proton.me/'],
        }),
      }) },
    );

    const results = await searchVault('Seven of Nine [dev]');
    expect(results).toHaveLength(1);
    expect(results[0].email).toBe('user@proton.me');
    expect(results[0].password).toBe('pass');
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      'pass-cli',
      ['item', 'view', '--output', 'json', '--share-id', 'share-456', '--item-id', 'item-123'],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it('rejects hydrated Proton title matches when detailed URLs do not match', async () => {
    simulateSequentialCalls(
      { stdout: wrapItems([
        makePassCliMetadataItem({ title: 'Proton Mail Bridge (assistant@example.test)', id: 'bridge-123', shareId: 'share-456' }),
        makePassCliMetadataItem({ title: 'Proton', id: 'login-123', shareId: 'share-456' }),
      ]) },
      { stdout: JSON.stringify({
        item: makePassCliItem({
          title: 'Proton Mail Bridge (assistant@example.test)',
          username: 'assistant@example.test',
          password: 'bridge-password',
          urls: ['imap://127.0.0.1:1143', 'smtps://127.0.0.1:1025'],
        }),
      }) },
      { stdout: JSON.stringify({
        item: makePassCliItem({
          title: 'Proton',
          username: 'agent.van-driesten',
          password: 'login-password',
          urls: ['https://proton.me'],
        }),
      }) },
    );

    const results = await searchVault('Personal');
    expect(results).toHaveLength(1);
    expect(results[0].username).toBe('agent.van-driesten');
    expect(results[0].password).toBe('login-password');
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

  it('filters matches by exact requested username', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({ title: 'Other Proton', email: 'other@proton.me', password: 'other', urls: ['https://proton.me'] }),
        makePassCliItem({ title: 'Requested Proton', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const entry = await searchProtonEntry(undefined, 'user@proton.me');
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe('user@proton.me');
    expect(entry!.password).toBe('pass');
  });

  it('returns null when host matches but requested username does not', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'other@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    await expect(searchProtonEntry(undefined, 'user@proton.me')).resolves.toBeNull();
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

  it('searches every vault by share id and hydrates a later metadata-only match', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({
        vaults: [
          { vault_id: 'v1', share_id: 'share-work', name: 'Work' },
          { vault_id: 'v2', share_id: 'share-dev', name: 'Seven of Nine [dev]' },
        ],
      }) },
      { stdout: wrapItems([]) },
      { stdout: wrapItems([
        makePassCliMetadataItem({ title: 'proton.me', id: 'item-123', shareId: 'share-dev' }),
      ]) },
      { stdout: JSON.stringify({
        item: makePassCliItem({
          title: 'proton.me',
          email: 'user@proton.me',
          password: 'pass',
          urls: ['https://proton.me/'],
        }),
      }) },
    );

    const entry = await searchProtonEntry();
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe('user@proton.me');
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      'pass-cli',
      ['item', 'list', '--share-id', 'share-work', '--filter-type', 'login', '--output', 'json'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      'pass-cli',
      ['item', 'list', '--share-id', 'share-dev', '--filter-type', 'login', '--output', 'json'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('falls back to hydrating metadata-only items to match hidden proton.me URLs', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({
        vaults: [{ vault_id: 'v1', share_id: 'share-personal', name: 'Personal' }],
      }) },
      { stdout: wrapItems([
        makePassCliMetadataItem({ title: 'Primary Account', id: 'item-123', shareId: 'share-personal' }),
      ]) },
      { stdout: wrapItems([
        makePassCliMetadataItem({ title: 'Primary Account', id: 'item-123', shareId: 'share-personal' }),
      ]) },
      { stdout: JSON.stringify({
        item: makePassCliItem({
          title: 'Primary Account',
          username: 'agent.van-driesten',
          password: 'pass',
          urls: ['https://proton.me/'],
        }),
      }) },
    );

    const entry = await searchProtonEntry();
    expect(entry).not.toBeNull();
    expect(entry!.username).toBe('agent.van-driesten');
    expect(mockExecFile).toHaveBeenNthCalledWith(
      4,
      'pass-cli',
      ['item', 'view', '--output', 'json', '--share-id', 'share-personal', '--item-id', 'item-123'],
      expect.any(Object),
      expect.any(Function),
    );
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

  it('resolve can use a custom credential host for data password entries', async () => {
    simulateSequentialCalls(
      // passCliTest
      { stdout: '' },
      // listVaults
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      // searchVault
      { stdout: wrapItems([
        makePassCliItem({
          title: 'Proton Login',
          email: 'user@proton.me',
          password: 'login-password',
          urls: ['https://proton.me'],
        }),
        makePassCliItem({
          title: 'Proton Data Password',
          email: 'user@proton.me',
          password: 'mailbox-password',
          urls: ['https://proton-data.proton-lfs-cli.local'],
        }),
      ]) },
    );

    const provider = new PassCliProvider('proton-data.proton-lfs-cli.local');
    const creds = await provider.resolve();
    expect(creds).toEqual({ username: 'user@proton.me', password: 'mailbox-password' });
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

  it('resolve requires username options to match a vault entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'override@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const provider = new PassCliProvider();
    const creds = await provider.resolve({ username: 'override@proton.me' });
    expect(creds.username).toBe('override@proton.me');
  });

  it('resolve throws when username options do not match a vault entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({ title: 'Proton', email: 'vault@proton.me', password: 'pass', urls: ['https://proton.me'] }),
      ]) },
    );

    const provider = new PassCliProvider();
    await expect(provider.resolve({ username: 'override@proton.me' })).rejects.toThrow(
      'No Proton login entry found',
    );
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
      // searchProtonEntry -> listVaults
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      // searchProtonEntry -> heuristic searchVault
      { stdout: wrapItems([]) },
      // searchProtonEntry -> exhaustive searchVault
      { stdout: wrapItems([]) },
      // listVaults
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      // item create
      { stdout: '' },
    );
    const provider = new PassCliProvider();
    await provider.store('user@proton.me', 'password123');

    const createCall = mockExecFile.mock.calls[4];
    expect(createCall[1]).toEqual([
      'item', 'create', 'login',
      '--vault-name', 'Personal',
      '--title', 'Proton',
      '--email', 'user@proton.me',
      '--username', 'user@proton.me',
      '--password', 'password123',
      '--url', 'https://proton.me',
    ]);
  });

  it('store creates custom-host entries with host-specific title and URL', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([]) },
      { stdout: wrapItems([]) },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: '' },
    );

    const provider = new PassCliProvider('proton-drive-key.proton-lfs-cli.local');
    await provider.store('uid-123', 'derived-key-password');

    const createCall = mockExecFile.mock.calls[4];
    expect(createCall[1]).toEqual([
      'item', 'create', 'login',
      '--vault-name', 'Personal',
      '--title', 'Proton proton-drive-key.proton-lfs-cli.local',
      '--email', 'uid-123',
      '--username', 'uid-123',
      '--password', 'derived-key-password',
      '--url', 'https://proton-drive-key.proton-lfs-cli.local',
    ]);
  });

  it('store updates an existing matching host and username entry', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({
          title: 'Proton proton-drive-key.proton-lfs-cli.local',
          email: 'uid-123',
          password: 'old-key-password',
          urls: ['https://proton-drive-key.proton-lfs-cli.local'],
        }),
      ]) },
      { stdout: '' },
    );

    const provider = new PassCliProvider('proton-drive-key.proton-lfs-cli.local');
    await provider.store('uid-123', 'new-key-password');

    const updateCall = mockExecFile.mock.calls[2];
    expect(updateCall[1]).toEqual([
      'item', 'update',
      '--share-id', 'share-id',
      '--item-id', 'item-id',
      '--field', 'username=uid-123',
      '--field', 'email=uid-123',
      '--field', 'password=new-key-password',
      '--field', 'url=https://proton-drive-key.proton-lfs-cli.local',
    ]);
  });

  it('store can skip exhaustive all-vault lookup before creating generated entries', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([]) },
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: '' },
    );

    const provider = new PassCliProvider('proton-drive-key.proton-lfs-cli.local');
    await provider.store('uid-123', 'derived-key-password', { exhaustiveLookup: false });

    expect(mockExecFile.mock.calls).toHaveLength(4);
    expect(mockExecFile.mock.calls[0][1]).toEqual(['vault', 'list', '--output', 'json']);
    expect(mockExecFile.mock.calls[1][1]).toContain('list');
    expect(mockExecFile.mock.calls[2][1]).toEqual(['vault', 'list', '--output', 'json']);
    expect(mockExecFile.mock.calls[3][1]).toEqual(expect.arrayContaining([
      'item',
      'create',
      'login',
      '--url',
      'https://proton-drive-key.proton-lfs-cli.local',
    ]));
  });

  it('remove deletes an existing matching host and username entry by metadata', async () => {
    simulateSequentialCalls(
      { stdout: JSON.stringify({ vaults: [{ vault_id: 'v1', name: 'Personal' }] }) },
      { stdout: wrapItems([
        makePassCliItem({
          title: 'Proton proton-drive-key.proton-lfs-cli.local',
          email: 'uid-123',
          password: 'key-password',
          urls: ['https://proton-drive-key.proton-lfs-cli.local'],
        }),
      ]) },
      { stdout: '' },
    );

    const provider = new PassCliProvider('proton-drive-key.proton-lfs-cli.local');
    await provider.remove('uid-123');

    const deleteCall = mockExecFile.mock.calls[2];
    expect(deleteCall[1]).toEqual([
      'item', 'delete',
      '--share-id', 'share-id',
      '--item-id', 'item-id',
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
