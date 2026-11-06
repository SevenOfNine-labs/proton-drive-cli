import { PassCliProvider, passCliSessionActive, listVaults, searchVault, searchProtonEntry } from './pass-cli';
import * as childProcess from 'child_process';

jest.mock('child_process');

const mockExecFile = childProcess.execFile as unknown as jest.Mock;

/** Captured stdin payloads, one per execFile call that received stdin. */
let stdinWrites: string[] = [];

function childStub() {
  return {
    stdin: {
      on: () => undefined,
      end: (data?: string) => { if (data !== undefined) stdinWrites.push(data); },
    },
  };
}

function simulateExecFile(stdout: string, stderr = '', exitCode = 0) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    if (exitCode !== 0) {
      const error = new Error(`exit code ${exitCode}`) as any;
      error.code = exitCode;
      cb(error, stdout, stderr);
    } else {
      cb(null, stdout, stderr);
    }
    return childStub();
  });
}

function simulateExecFileError(message: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(new Error(message), '', '');
    return childStub();
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
    return childStub();
  });
}

function argsOfCall(index: number): string[] {
  return mockExecFile.mock.calls[index][1];
}

/** `pass-cli vault list --output json` (VaultList/VaultEntry). */
function vaultList(...vaults: Array<{ name: string; shareId?: string; vaultId?: string }>) {
  return JSON.stringify({
    vaults: vaults.map((vault, index) => ({
      name: vault.name,
      vault_id: vault.vaultId || `vault-${index + 1}`,
      share_id: vault.shareId || `share-${index + 1}`,
    })),
  });
}

/** `pass-cli item list --filter-type login --output json` (ItemsList/ItemSummary). */
function itemList(...items: Array<{ title: string; id?: string; shareId?: string }>) {
  return JSON.stringify({
    items: items.map((item, index) => ({
      id: item.id || `item-${index + 1}`,
      share_id: item.shareId || 'share-1',
      vault_id: 'vault-1',
      state: 'active',
      flags: [],
      create_time: '2026-01-01T00:00:00',
      modify_time: '2026-01-01T00:00:00',
      title: item.title,
      item_type: 'login',
    })),
    folders: [],
  });
}

/** `pass-cli item view --output json` (ItemDetails with an externally tagged Login content). */
function itemView(opts: {
  title: string;
  id?: string;
  shareId?: string;
  email?: string;
  username?: string;
  password?: string;
  urls?: string[];
}) {
  return JSON.stringify({
    item: {
      id: opts.id || 'item-1',
      share_id: opts.shareId || 'share-1',
      vault_id: 'vault-1',
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
      state: 'active',
      flags: [],
      create_time: '2026-01-01T00:00:00',
      modify_time: '2026-01-01T00:00:00',
    },
    attachments: [],
  });
}

const personal = { name: 'Personal', vaultId: 'vault-1', shareId: 'share-1' };

beforeEach(() => {
  jest.resetAllMocks();
  stdinWrites = [];
});

describe('passCliSessionActive', () => {
  it('returns true when pass-cli info succeeds', async () => {
    simulateExecFile('- Username: user\n');
    expect(await passCliSessionActive()).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'pass-cli',
      ['info'],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it('returns false when pass-cli info fails', async () => {
    simulateExecFileError('not logged in');
    expect(await passCliSessionActive()).toBe(false);
  });

  it('respects PROTON_PASS_CLI_BIN env var', async () => {
    const originalEnv = process.env.PROTON_PASS_CLI_BIN;
    process.env.PROTON_PASS_CLI_BIN = '/custom/pass-cli';
    simulateExecFile('');

    await passCliSessionActive();

    expect(mockExecFile).toHaveBeenCalledWith(
      '/custom/pass-cli',
      ['info'],
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
  it('parses name, vault id and share id', async () => {
    simulateExecFile(vaultList({ name: 'Personal', vaultId: 'vid1', shareId: 'share1' }, { name: 'Work', vaultId: 'vid2', shareId: 'share2' }));

    const vaults = await listVaults();
    expect(vaults).toEqual([
      { name: 'Personal', vaultId: 'vid1', shareId: 'share1' },
      { name: 'Work', vaultId: 'vid2', shareId: 'share2' },
    ]);
    expect(argsOfCall(0)).toEqual(['vault', 'list', '--output', 'json']);
  });

  it('skips entries without a share id', async () => {
    simulateExecFile(JSON.stringify({ vaults: [{ name: 'Broken', vault_id: 'vid1' }] }));
    expect(await listVaults()).toEqual([]);
  });

  it('throws on invalid JSON', async () => {
    simulateExecFile('not json');
    await expect(listVaults()).rejects.toThrow();
  });

  it('throws when the output is not an object', async () => {
    simulateExecFile('[]');
    await expect(listVaults()).rejects.toThrow('did not return a JSON object');
  });
});

describe('searchVault', () => {
  it('hydrates title matches through item view and keeps entries with a matching URL', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: 'Proton', id: 'item-123' }, { title: 'GitHub', id: 'item-456' }) },
      { stdout: itemView({ title: 'Proton', id: 'item-123', username: 'user', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
    );

    const results = await searchVault(personal);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'item-123', shareId: 'share-1', vaultName: 'Personal', title: 'Proton', password: 'pass' });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(argsOfCall(0)).toEqual(['item', 'list', '--share-id', 'share-1', '--filter-type', 'login', '--output', 'json']);
    expect(argsOfCall(1)).toEqual(['item', 'view', '--share-id', 'share-1', '--item-id', 'item-123', '--output', 'json']);
  });

  it('returns an empty array when no title matches', async () => {
    simulateExecFile(itemList({ title: 'GitHub' }));

    const results = await searchVault(personal);
    expect(results).toHaveLength(0);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('matches the credential host URL case-insensitively', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', username: 'user', password: 'pass', urls: ['https://PROTON.ME/login'] }) },
    );

    const results = await searchVault(personal);
    expect(results).toHaveLength(1);
  });

  it('rejects Proton-titled entries whose URLs do not match', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: 'Proton Mail Bridge (assistant@example.test)' }) },
      { stdout: itemView({
        title: 'Proton Mail Bridge (assistant@example.test)',
        username: 'assistant@example.test',
        password: 'bridge-password',
        urls: ['imap://127.0.0.1:1143', 'smtps://127.0.0.1:1025'],
      }) },
    );

    const results = await searchVault(personal);
    expect(results).toHaveLength(0);
  });

  it('hydrates every login item in exhaustive mode', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: 'Primary Account', id: 'item-123' }) },
      { stdout: itemView({ title: 'Primary Account', id: 'item-123', username: 'agent.user', password: 'pass', urls: ['https://proton.me/'] }) },
    );

    const results = await searchVault(personal, undefined, undefined, { exhaustive: true });
    expect(results).toHaveLength(1);
    expect(results[0].username).toBe('agent.user');
  });

  it('ignores summaries without ids', async () => {
    simulateExecFile(JSON.stringify({ items: [{ title: 'Proton' }] }));
    expect(await searchVault(personal)).toEqual([]);
  });
});

describe('searchProtonEntry', () => {
  it('finds the entry in the first vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
    );

    const entry = await searchProtonEntry();
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe('user@proton.me');
  });

  it('filters matches by the requested username', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Other Proton', id: 'item-1' }, { title: 'Requested Proton', id: 'item-2' }) },
      { stdout: itemView({ title: 'Other Proton', id: 'item-1', email: 'other@proton.me', password: 'other', urls: ['https://proton.me'] }) },
      { stdout: itemView({ title: 'Requested Proton', id: 'item-2', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
    );

    const entry = await searchProtonEntry(undefined, 'user@proton.me');
    expect(entry).not.toBeNull();
    expect(entry!.password).toBe('pass');
  });

  it('returns null when the host matches but the requested username does not', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'other@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
      // exhaustive pass over the same vault
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'other@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
    );

    await expect(searchProtonEntry(undefined, 'user@proton.me')).resolves.toBeNull();
  });

  it('searches subsequent vaults by share id', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Work', shareId: 'share-work' }, { name: 'Seven of Nine [dev]', shareId: 'share-dev' }) },
      { stdout: itemList() },
      { stdout: itemList({ title: 'proton.me', id: 'item-123', shareId: 'share-dev' }) },
      { stdout: itemView({ title: 'proton.me', id: 'item-123', shareId: 'share-dev', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me/'] }) },
    );

    const entry = await searchProtonEntry();
    expect(entry).not.toBeNull();
    expect(entry!.vaultName).toBe('Seven of Nine [dev]');
    expect(argsOfCall(1)).toEqual(['item', 'list', '--share-id', 'share-work', '--filter-type', 'login', '--output', 'json']);
    expect(argsOfCall(2)).toEqual(['item', 'list', '--share-id', 'share-dev', '--filter-type', 'login', '--output', 'json']);
    expect(argsOfCall(3)).toEqual(['item', 'view', '--share-id', 'share-dev', '--item-id', 'item-123', '--output', 'json']);
  });

  it('falls back to hydrating every login item when no title matches', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Primary Account', id: 'item-123' }) },
      { stdout: itemList({ title: 'Primary Account', id: 'item-123' }) },
      { stdout: itemView({ title: 'Primary Account', id: 'item-123', username: 'agent.user', password: 'pass', urls: ['https://proton.me/'] }) },
    );

    const entry = await searchProtonEntry();
    expect(entry).not.toBeNull();
    expect(entry!.username).toBe('agent.user');
    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(argsOfCall(3)).toEqual(['item', 'view', '--share-id', 'share-1', '--item-id', 'item-123', '--output', 'json']);
  });

  it('skips the exhaustive pass when disabled', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Primary Account' }) },
    );

    await expect(searchProtonEntry(undefined, undefined, undefined, { exhaustiveLookup: false })).resolves.toBeNull();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('returns null when no vault has a match', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
    );

    await expect(searchProtonEntry()).resolves.toBeNull();
  });
});

describe('PassCliProvider', () => {
  it('isAvailable mirrors the pass-cli session check', async () => {
    simulateExecFile('');
    expect(await new PassCliProvider().isAvailable()).toBe(true);

    simulateExecFileError('not installed');
    expect(await new PassCliProvider().isAvailable()).toBe(false);
  });

  it('resolve returns credentials from the vault entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'user@proton.me', password: 's3cret', urls: ['https://proton.me'] }) },
    );

    const creds = await new PassCliProvider().resolve();
    expect(creds).toEqual({ username: 'user@proton.me', password: 's3cret' });
  });

  it('resolve uses the configured credential host for data password entries', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      // title pass: no title contains the data host, nothing is hydrated
      { stdout: itemList({ title: 'Proton Login', id: 'item-1' }, { title: 'Proton Data Password', id: 'item-2' }) },
      // exhaustive pass hydrates every login item
      { stdout: itemList({ title: 'Proton Login', id: 'item-1' }, { title: 'Proton Data Password', id: 'item-2' }) },
      { stdout: itemView({ title: 'Proton Login', id: 'item-1', email: 'user@proton.me', password: 'login-password', urls: ['https://proton.me'] }) },
      { stdout: itemView({ title: 'Proton Data Password', id: 'item-2', email: 'user@proton.me', password: 'mailbox-password', urls: ['https://proton-data.proton-lfs-cli.local'] }) },
    );

    const creds = await new PassCliProvider('proton-data.proton-lfs-cli.local').resolve();
    expect(creds).toEqual({ username: 'user@proton.me', password: 'mailbox-password' });
    expect(mockExecFile).toHaveBeenCalledTimes(6);
  });

  it('resolve prefers the username field when email is empty', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', username: 'agent.user', password: 'pass', urls: ['https://proton.me'] }) },
    );

    const creds = await new PassCliProvider().resolve();
    expect(creds.username).toBe('agent.user');
  });

  it('resolve keeps the requested username when it matches a vault entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'override@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
    );

    const creds = await new PassCliProvider().resolve({ username: 'override@proton.me' });
    expect(creds.username).toBe('override@proton.me');
  });

  it('resolve throws when the requested username matches no vault entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'vault@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'vault@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
    );

    await expect(new PassCliProvider().resolve({ username: 'override@proton.me' })).rejects.toThrow('No Proton login entry found');
  });

  it('resolve throws when pass-cli is not logged in', async () => {
    simulateExecFileError('not logged in');
    await expect(new PassCliProvider().resolve()).rejects.toThrow('pass-cli is not logged in');
  });

  it('resolve throws when no entry is found', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList() },
    );

    await expect(new PassCliProvider().resolve()).rejects.toThrow('No Proton login entry found');
  });

  it('store creates the entry from a stdin template in the first vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
      { stdout: itemList() },
      { stdout: '' },
    );

    await new PassCliProvider().store('user@proton.me', 'password123');

    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(argsOfCall(3)).toEqual(['item', 'create', 'login', '--share-id', 'share-1', '--from-template', '-']);
    expect(argsOfCall(3).join(' ')).not.toContain('password123');
    expect(JSON.parse(stdinWrites[0])).toEqual({
      title: 'Proton',
      username: 'user@proton.me',
      email: null,
      password: 'password123',
      totp_uri: null,
      urls: ['https://proton.me'],
      extra_fields: [],
    });
  });

  it('store creates custom-host entries with a host-specific title and URL', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
      { stdout: itemList() },
      { stdout: '' },
    );

    await new PassCliProvider('proton-drive-key.proton-lfs-cli.local').store('uid-123', 'derived-key-password');

    expect(JSON.parse(stdinWrites[0])).toMatchObject({
      title: 'Proton proton-drive-key.proton-lfs-cli.local',
      username: 'uid-123',
      password: 'derived-key-password',
      urls: ['https://proton-drive-key.proton-lfs-cli.local'],
    });
  });

  it('store replaces an existing entry for the same host and username', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Work', shareId: 'share-work' }, personal) },
      { stdout: itemList() },
      { stdout: itemList({ title: 'Proton proton-drive-key.proton-lfs-cli.local', id: 'item-old' }) },
      { stdout: itemView({ title: 'Proton proton-drive-key.proton-lfs-cli.local', id: 'item-old', username: 'uid-123', password: 'old-key-password', urls: ['https://proton-drive-key.proton-lfs-cli.local'] }) },
      { stdout: '' },
      { stdout: '' },
    );

    await new PassCliProvider('proton-drive-key.proton-lfs-cli.local').store('uid-123', 'new-key-password');

    expect(mockExecFile).toHaveBeenCalledTimes(6);
    expect(argsOfCall(4)).toEqual(['item', 'create', 'login', '--share-id', 'share-1', '--from-template', '-']);
    expect(JSON.parse(stdinWrites[0]).password).toBe('new-key-password');
    expect(argsOfCall(5)).toEqual(['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-old']);
  });

  it('store can skip the exhaustive lookup before creating generated entries', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
      { stdout: '' },
    );

    await new PassCliProvider('proton-drive-key.proton-lfs-cli.local').store('uid-123', 'derived-key-password', { exhaustiveLookup: false });

    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(argsOfCall(0)).toEqual(['vault', 'list', '--output', 'json']);
    expect(argsOfCall(1)).toContain('list');
    expect(argsOfCall(2)).toEqual(['item', 'create', 'login', '--share-id', 'share-1', '--from-template', '-']);
  });

  it('store fails without a vault', async () => {
    simulateExecFile(JSON.stringify({ vaults: [] }));
    await expect(new PassCliProvider().store('user', 'pw')).rejects.toThrow('no vault');
    expect(stdinWrites).toHaveLength(0);
  });

  /** Simulates a vault whose login items disappear when `item delete` succeeds. */
  function simulateVault(keyHost: string, ids: string[]) {
    const present = new Set(ids);
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[1] === 'list') cb(null, itemList(...[...present].map((id) => ({ title: `Proton ${keyHost}`, id }))), '');
      else if (args[1] === 'view') {
        const id = args[args.indexOf('--item-id') + 1];
        cb(null, itemView({ title: `Proton ${keyHost}`, id, username: 'uid-123', password: 'pw', urls: [`https://${keyHost}`] }), '');
      } else if (args[1] === 'delete') {
        present.delete(args[args.indexOf('--item-id') + 1]);
        cb(null, '', '');
      } else cb(null, '', '');
      return childStub();
    });
  }

  function deleteCalls(): string[][] {
    return mockExecFile.mock.calls.map((call) => call[1]).filter((args: string[]) => args[1] === 'delete');
  }

  it('remove deletes the matching entry by share and item id', async () => {
    const keyHost = 'proton-drive-key.proton-lfs-cli.local';
    simulateVault(keyHost, ['item-old']);

    await new PassCliProvider(keyHost).remove('uid-123');

    expect(deleteCalls()).toEqual([['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-old']]);
  });

  it('remove deletes every duplicate entry for the username', async () => {
    const keyHost = 'proton-drive-key.proton-lfs-cli.local';
    simulateVault(keyHost, ['item-a', 'item-b']);

    await new PassCliProvider(keyHost).remove('uid-123', { exhaustiveLookup: false });

    expect(deleteCalls()).toEqual([
      ['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-a'],
      ['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-b'],
    ]);
  });

  it('store keeps the new entry and reports a failed deletion of the old one', async () => {
    const keyHost = 'proton-drive-key.proton-lfs-cli.local';
    let call = 0;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      call++;
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[1] === 'list') cb(null, itemList({ title: `Proton ${keyHost}`, id: 'item-old' }), '');
      else if (args[1] === 'view') cb(null, itemView({ title: `Proton ${keyHost}`, id: 'item-old', username: 'uid-123', password: 'old', urls: [`https://${keyHost}`] }), '');
      else if (args[1] === 'create') cb(null, '', '');
      else if (args[1] === 'delete') cb(new Error('exit 1'), '', 'item is locked');
      return childStub();
    });

    await expect(new PassCliProvider(keyHost).store('uid-123', 'new', { exhaustiveLookup: false })).resolves.toBeUndefined();
    expect(call).toBeGreaterThan(0);
    expect(JSON.parse(stdinWrites[0]).password).toBe('new');
  });

  it('resolve with exhaustiveLookup false never hydrates entries whose title does not match', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'GitHub', id: 'item-1' }, { title: 'Bank', id: 'item-2' }) },
    );

    await expect(new PassCliProvider('proton-drive-key.proton-lfs-cli.local').resolve({ username: 'uid-123', exhaustiveLookup: false }))
      .rejects.toThrow('No Proton login entry found');
    expect(mockExecFile.mock.calls.map((c) => c[1][1]).filter((sub: string) => sub === 'view')).toHaveLength(0);
  });

  it('remove throws when no entry matches', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
    );

    await expect(new PassCliProvider().remove('uid-123')).rejects.toThrow('No Proton entry found');
  });

  it('verify returns true when an entry with a password exists', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'Proton' }) },
      { stdout: itemView({ title: 'Proton', email: 'user@proton.me', password: 'pass', urls: ['https://proton.me'] }) },
    );

    expect(await new PassCliProvider().verify()).toBe(true);
  });

  it('verify returns false when not logged in', async () => {
    simulateExecFileError('not logged in');
    expect(await new PassCliProvider().verify()).toBe(false);
  });
});
