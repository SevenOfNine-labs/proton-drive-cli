import { PassCliProvider, passCliSessionActive, listVaults, writableVaultRoles, searchVault, findEntry } from './pass-cli';
import * as childProcess from 'child_process';
import { logger } from '../utils/logger';

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

/** `pass-cli share list --only-vaults true --output json` (SharesList/ShareEntry). */
function shareList(...shares: Array<{ id: string; role: string; type?: string }>) {
  return JSON.stringify({
    shares: shares.map((share) => ({
      id: share.id,
      name: share.id,
      share_type: share.type ?? 'Vault',
      share_role: share.role,
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
            email: '',
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

const KEY_HOST = 'proton-drive-key.proton-lfs-cli.local';
const KEY_TITLE = `Proton ${KEY_HOST}`;
const KEY_URL = `https://${KEY_HOST}`;

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

describe('writableVaultRoles', () => {
  it('keeps the vault shares whose role may create items', async () => {
    simulateExecFile(shareList(
      { id: 'share-own', role: 'Owner' },
      { id: 'share-edit', role: 'Editor' },
      { id: 'share-team', role: 'Viewer' },
      { id: 'share-item', role: 'Owner', type: 'Item' },
    ));

    await expect(writableVaultRoles()).resolves.toEqual(new Map([['share-own', 'Owner'], ['share-edit', 'Editor']]));
    expect(argsOfCall(0)).toEqual(['share', 'list', '--only-vaults', 'true', '--output', 'json']);
  });
});

describe('searchVault', () => {
  it('hydrates title matches through item view and keeps entries with a matching URL', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: KEY_TITLE, id: 'item-123' }, { title: 'GitHub', id: 'item-456' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-123', username: 'uid-123', password: 'pass', urls: [KEY_URL] }) },
    );

    const results = await searchVault(personal, KEY_HOST);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'item-123', shareId: 'share-1', vaultName: 'Personal', title: KEY_TITLE, username: 'uid-123', password: 'pass' });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(argsOfCall(0)).toEqual(['item', 'list', '--share-id', 'share-1', '--filter-type', 'login', '--output', 'json']);
    expect(argsOfCall(1)).toEqual(['item', 'view', '--share-id', 'share-1', '--item-id', 'item-123', '--output', 'json']);
  });

  it('never hydrates items whose title does not contain the host', async () => {
    simulateExecFile(itemList({ title: 'GitHub' }, { title: 'Proton' }));

    const results = await searchVault(personal, KEY_HOST);
    expect(results).toHaveLength(0);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('matches the URL host case-insensitively', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', password: 'pass', urls: [`https://${KEY_HOST.toUpperCase()}/`] }) },
    );

    expect(await searchVault(personal, KEY_HOST)).toHaveLength(1);
  });

  it.each([
    ['another host', 'imap://127.0.0.1:1143'],
    ['a host that only contains the credential host', `https://${KEY_HOST}.attacker.example`],
    ['an unparseable URL', 'not a url'],
  ])('rejects host-titled entries whose URL has %s', async (_case, url) => {
    simulateSequentialCalls(
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', password: 'pass', urls: [url] }) },
    );

    expect(await searchVault(personal, KEY_HOST)).toHaveLength(0);
  });

  it('ignores summaries without ids', async () => {
    simulateExecFile(JSON.stringify({ items: [{ title: KEY_TITLE }] }));
    expect(await searchVault(personal, KEY_HOST)).toEqual([]);
  });
});

describe('findEntry', () => {
  it('finds the entry of the username in the first vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', password: 'pass', urls: [KEY_URL] }) },
    );

    const entry = await findEntry(KEY_HOST, 'uid-123');
    expect(entry).toMatchObject({ username: 'uid-123', password: 'pass' });
  });

  it('filters matches by the exact username', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-1' }, { title: KEY_TITLE, id: 'item-2' }, { title: KEY_TITLE, id: 'item-3' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-1', username: 'uid-other', password: 'other', urls: [KEY_URL] }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-2', username: 'UID-123', password: 'case', urls: [KEY_URL] }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-3', username: 'uid-123', password: 'pass', urls: [KEY_URL] }) },
    );

    const entry = await findEntry(KEY_HOST, 'uid-123');
    expect(entry).toMatchObject({ id: 'item-3', password: 'pass' });
  });

  it('returns null when the host matches but the username does not', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-other', password: 'pass', urls: [KEY_URL] }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toBeNull();
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('searches subsequent vaults by share id', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Work', shareId: 'share-work' }, { name: 'Seven of Nine [dev]', shareId: 'share-dev' }) },
      { stdout: itemList() },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-123', shareId: 'share-dev' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-123', shareId: 'share-dev', username: 'uid-123', password: 'pass', urls: [KEY_URL] }) },
    );

    const entry = await findEntry(KEY_HOST, 'uid-123');
    expect(entry?.vaultName).toBe('Seven of Nine [dev]');
    expect(argsOfCall(1)).toEqual(['item', 'list', '--share-id', 'share-work', '--filter-type', 'login', '--output', 'json']);
    expect(argsOfCall(2)).toEqual(['item', 'list', '--share-id', 'share-dev', '--filter-type', 'login', '--output', 'json']);
    expect(argsOfCall(3)).toEqual(['item', 'view', '--share-id', 'share-dev', '--item-id', 'item-123', '--output', 'json']);
  });

  it('returns null when no vault has a match', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toBeNull();
  });
});

describe('PassCliProvider', () => {
  it('requires a credential host', () => {
    expect(() => new PassCliProvider('')).toThrow('requires a credential host');
  });

  it('resolve returns the password of the username entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', password: 's3cret', urls: [KEY_URL] }) },
    );

    const creds = await new PassCliProvider(KEY_HOST).resolve('uid-123');
    expect(creds).toEqual({ username: 'uid-123', password: 's3cret' });
    expect(argsOfCall(0)).toEqual(['info']);
  });

  it('resolve throws when pass-cli is not logged in', async () => {
    simulateExecFileError('not logged in');
    await expect(new PassCliProvider(KEY_HOST).resolve('uid-123')).rejects.toThrow('pass-cli is not logged in');
  });

  it('resolve throws when no entry is found', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'GitHub', id: 'item-1' }) },
    );

    await expect(new PassCliProvider(KEY_HOST).resolve('uid-123')).rejects.toThrow('No pass-cli key-password entry found');
    expect(mockExecFile.mock.calls.map((c) => c[1][1]).filter((sub: string) => sub === 'view')).toHaveLength(0);
  });

  it('resolve throws when the entry has no password', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', urls: [KEY_URL] }) },
    );

    await expect(new PassCliProvider(KEY_HOST).resolve('uid-123')).rejects.toThrow('No pass-cli key-password entry found');
  });

  it('store creates the entry from a stdin template in the first owned vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }, personal) },
      { stdout: shareList({ id: 'share-team', role: 'Editor' }, { id: 'share-1', role: 'Owner' }) },
      { stdout: itemList() },
      { stdout: itemList() },
      { stdout: '' },
    );

    await new PassCliProvider(KEY_HOST).store('uid-123', 'derived-key-password');

    expect(mockExecFile).toHaveBeenCalledTimes(5);
    expect(argsOfCall(0)).toEqual(['vault', 'list', '--output', 'json']);
    expect(argsOfCall(1)).toEqual(['share', 'list', '--only-vaults', 'true', '--output', 'json']);
    expect(argsOfCall(4)).toEqual(['item', 'create', 'login', '--share-id', 'share-1', '--from-template', '-']);
    expect(mockExecFile.mock.calls.flatMap((call) => call[1]).join(' ')).not.toContain('derived-key-password');
    expect(JSON.parse(stdinWrites[0])).toEqual({
      title: KEY_TITLE,
      username: 'uid-123',
      email: null,
      password: 'derived-key-password',
      totp_uri: null,
      urls: [KEY_URL],
      extra_fields: [],
    });
  });

  it('store replaces an existing entry for the same host and username in its owned vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Work', shareId: 'share-work' }, personal) },
      { stdout: shareList({ id: 'share-work', role: 'Owner' }, { id: 'share-1', role: 'Owner' }) },
      { stdout: itemList() },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-old' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-old', username: 'uid-123', password: 'old-key-password', urls: [KEY_URL] }) },
      { stdout: '' },
      { stdout: '' },
    );

    await new PassCliProvider(KEY_HOST).store('uid-123', 'new-key-password');

    expect(mockExecFile).toHaveBeenCalledTimes(7);
    expect(argsOfCall(5)).toEqual(['item', 'create', 'login', '--share-id', 'share-1', '--from-template', '-']);
    expect(JSON.parse(stdinWrites[0]).password).toBe('new-key-password');
    expect(argsOfCall(6)).toEqual(['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-old']);
  });

  it('store moves an existing entry out of a vault shared with the account', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }, personal) },
      { stdout: shareList({ id: 'share-team', role: 'Manager' }, { id: 'share-1', role: 'Owner' }) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-old', shareId: 'share-team' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-old', shareId: 'share-team', username: 'uid-123', password: 'old', urls: [KEY_URL] }) },
      { stdout: '' },
      { stdout: '' },
    );

    await new PassCliProvider(KEY_HOST).store('uid-123', 'new-key-password');

    expect(argsOfCall(4)).toEqual(['item', 'create', 'login', '--share-id', 'share-1', '--from-template', '-']);
    expect(argsOfCall(5)).toEqual(['item', 'delete', '--share-id', 'share-team', '--item-id', 'item-old']);
  });

  it('store fails without a vault', async () => {
    simulateExecFile(JSON.stringify({ vaults: [] }));
    await expect(new PassCliProvider(KEY_HOST).store('uid-123', 'pw')).rejects.toThrow('no vault');
    expect(stdinWrites).toHaveLength(0);
  });

  it('store uses a vault with Editor role when the account owns none (personal access token)', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Viewer', shareId: 'share-view' }, { name: 'Team', shareId: 'share-team' }) },
      { stdout: shareList({ id: 'share-view', role: 'Viewer' }, { id: 'share-team', role: 'Editor' }) },
      { stdout: itemList() },
      { stdout: itemList() },
      { stdout: '' },
    );

    await new PassCliProvider(KEY_HOST).store('uid-123', 'pw');

    expect(argsOfCall(4)).toEqual(['item', 'create', 'login', '--share-id', 'share-team', '--from-template', '-']);
  });

  it('store fails when the account may edit no vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }) },
      { stdout: shareList({ id: 'share-team', role: 'Viewer' }) },
    );
    await expect(new PassCliProvider(KEY_HOST).store('uid-123', 'pw')).rejects.toThrow('no vault this account owns or may edit');
    expect(stdinWrites).toHaveLength(0);
  });

  /** Simulates a vault whose login items disappear when `item delete` succeeds. */
  function simulateVault(ids: string[]) {
    const present = new Set(ids);
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[1] === 'list') cb(null, itemList(...[...present].map((id) => ({ title: KEY_TITLE, id }))), '');
      else if (args[1] === 'view') {
        const id = args[args.indexOf('--item-id') + 1];
        cb(null, itemView({ title: KEY_TITLE, id, username: 'uid-123', password: 'pw', urls: [KEY_URL] }), '');
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
    simulateVault(['item-old']);

    await new PassCliProvider(KEY_HOST).remove('uid-123');

    expect(deleteCalls()).toEqual([['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-old']]);
  });

  it('remove deletes every duplicate entry for the username', async () => {
    simulateVault(['item-a', 'item-b']);

    await new PassCliProvider(KEY_HOST).remove('uid-123');

    expect(deleteCalls()).toEqual([
      ['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-a'],
      ['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-b'],
    ]);
  });

  it('remove stops when pass-cli keeps listing a deleted item', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[1] === 'list') cb(null, itemList({ title: KEY_TITLE, id: 'item-stuck' }), '');
      else if (args[1] === 'view') cb(null, itemView({ title: KEY_TITLE, id: 'item-stuck', username: 'uid-123', password: 'pw', urls: [KEY_URL] }), '');
      else cb(null, '', '');
      return childStub();
    });

    await expect(new PassCliProvider(KEY_HOST).remove('uid-123')).rejects.toThrow('as deleted but still lists it');
  });

  it('store keeps the new entry and reports a failed deletion of the old one', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[0] === 'share') cb(null, shareList({ id: 'share-1', role: 'Owner' }), '');
      else if (args[1] === 'list') cb(null, itemList({ title: KEY_TITLE, id: 'item-old' }), '');
      else if (args[1] === 'view') cb(null, itemView({ title: KEY_TITLE, id: 'item-old', username: 'uid-123', password: 'old', urls: [KEY_URL] }), '');
      else if (args[1] === 'create') cb(null, '', '');
      else if (args[1] === 'delete') cb(new Error('exit 1'), '', 'item is locked');
      return childStub();
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(new PassCliProvider(KEY_HOST).store('uid-123', 'new')).resolves.toBeUndefined();
    expect(JSON.parse(stdinWrites[0]).password).toBe('new');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be deleted'));
    warn.mockRestore();
  });

  it('remove throws when no entry matches', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
    );

    await expect(new PassCliProvider(KEY_HOST).remove('uid-123')).rejects.toThrow('No pass-cli key-password entry found');
  });
});
