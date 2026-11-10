import { PassCliStore, passCliSessionActive, listVaults, writableVaultRoles, findEntry, findEntries } from './pass-cli';
import * as childProcess from 'child_process';
import { logger } from '../utils/logger';

jest.mock('child_process');
jest.mock('../utils/logger');

/** `pass-cli item list` of a vault: active login items, newest first (item.md, list.rs). */
function listArgs(shareId: string): string[] {
  return [
    'item', 'list',
    '--share-id', shareId,
    '--filter-type', 'login',
    '--filter-state', 'active',
    '--sort-by', 'created-desc',
    '--output', 'json',
  ];
}

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

/** `pass-cli item list` output (ItemsList/ItemSummary). */
function itemList(...items: Array<{ title: string; id?: string; shareId?: string; createTime?: string }>) {
  return JSON.stringify({
    items: items.map((item, index) => ({
      id: item.id || `item-${index + 1}`,
      share_id: item.shareId || 'share-1',
      vault_id: 'vault-1',
      state: 'active',
      flags: [],
      create_time: item.createTime ?? '2026-01-01T00:00:00',
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

const KEY_HOST = 'proton-drive-cli.invalid';
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

describe('findEntry candidate selection', () => {
  it('hydrates title matches through item view and returns the entry with a matching URL', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-123' }, { title: 'GitHub', id: 'item-456' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-123', username: 'uid-123', password: 'pass', urls: [KEY_URL] }) },
    );

    const entry = await findEntry(KEY_HOST, 'uid-123');
    expect(entry).toMatchObject({ id: 'item-123', shareId: 'share-1', vaultName: 'Personal', title: KEY_TITLE, username: 'uid-123', password: 'pass' });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(argsOfCall(1)).toEqual(listArgs('share-1'));
    expect(argsOfCall(2)).toEqual(['item', 'view', '--share-id', 'share-1', '--item-id', 'item-123', '--output', 'json']);
  });

  it('never hydrates items whose title does not contain the host', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'GitHub' }, { title: 'Proton' }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toBeNull();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('matches the URL host case-insensitively', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', password: 'pass', urls: [`https://${KEY_HOST.toUpperCase()}/`] }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toMatchObject({ password: 'pass' });
  });

  it.each([
    ['another host', 'imap://127.0.0.1:1143'],
    ['a host that only contains the credential host', `https://${KEY_HOST}.attacker.example`],
    ['an unparseable URL', 'not a url'],
  ])('rejects host-titled entries whose URL has %s', async (_case, url) => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', password: 'pass', urls: [url] }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toBeNull();
  });

  it('ignores summaries without ids', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: JSON.stringify({ items: [{ title: KEY_TITLE }] }) },
    );
    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toBeNull();
  });

  it('returns the newest entry without viewing an older item a concurrent save may have deleted', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-new' }, { title: KEY_TITLE, id: 'item-replaced' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-new', username: 'uid-123', password: 'new', urls: [KEY_URL] }) },
      { stdout: '', error: 'pass-cli item failed: item not found' },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toMatchObject({ id: 'item-new', password: 'new' });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('fails the read when the newest item cannot be viewed, after one more search, instead of returning an older item', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-newest' }, { title: KEY_TITLE, id: 'item-older' }) },
      { stdout: '', error: 'pass-cli item failed: network unreachable' },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-newest' }, { title: KEY_TITLE, id: 'item-older' }) },
      { stdout: '', error: 'pass-cli item failed: still unreachable' },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-older', username: 'uid-123', password: 'older', urls: [KEY_URL] }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).rejects.toThrow('still unreachable');
    const views = mockExecFile.mock.calls.map((call) => call[1]).filter((args: string[]) => args[1] === 'view');
    expect(views.map((args: string[]) => args[args.indexOf('--item-id') + 1])).toEqual(['item-newest', 'item-newest']);
    expect(argsOfCall(3)).toEqual(listArgs('share-1'));
  });

  it('returns the entry the second search finds after a save replaced the item the first search listed', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-replaced' }) },
      { stdout: '', error: 'pass-cli item failed: item not found' },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-new' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-new', username: 'uid-123', password: 'new', urls: [KEY_URL] }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toMatchObject({ id: 'item-new', password: 'new' });
  });

  it('views the newest item across all vaults first, by create_time', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }, personal) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-team-old', shareId: 'share-team', createTime: '2026-01-01T00:00:00' }) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-personal-new', createTime: '2026-03-01T12:00:00' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-personal-new', username: 'uid-123', password: 'new', urls: [KEY_URL] }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-team-old', shareId: 'share-team', username: 'uid-123', password: 'old', urls: [KEY_URL] }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toMatchObject({ id: 'item-personal-new', password: 'new', vaultName: 'Personal' });
    expect(argsOfCall(1)).toEqual(listArgs('share-team'));
    expect(argsOfCall(2)).toEqual(listArgs('share-1'));
    expect(argsOfCall(3)).toEqual(['item', 'view', '--share-id', 'share-1', '--item-id', 'item-personal-new', '--output', 'json']);
    expect(mockExecFile).toHaveBeenCalledTimes(4);
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
    expect(argsOfCall(1)).toEqual(listArgs('share-work'));
    expect(argsOfCall(2)).toEqual(listArgs('share-dev'));
    expect(argsOfCall(3)).toEqual(['item', 'view', '--share-id', 'share-dev', '--item-id', 'item-123', '--output', 'json']);
  });

  it('returns null when no vault has a match', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toBeNull();
  });

  it('returns the newest entry of the username, the first that the newest-first listing hydrates', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-newest' }, { title: KEY_TITLE, id: 'item-older' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-newest', username: 'uid-123', password: 'newest', urls: [KEY_URL] }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-older', username: 'uid-123', password: 'older', urls: [KEY_URL] }) },
    );

    await expect(findEntry(KEY_HOST, 'uid-123')).resolves.toMatchObject({ id: 'item-newest', password: 'newest' });
    expect(argsOfCall(1)).toEqual(listArgs('share-1'));
  });
});

describe('findEntries', () => {
  it('collects every entry of the username across the given vaults', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: KEY_TITLE, id: 'item-a', shareId: 'share-work' }) },
      { stdout: itemList({ title: KEY_TITLE, id: 'item-b' }, { title: KEY_TITLE, id: 'item-c' }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-a', shareId: 'share-work', username: 'uid-123', password: 'a', urls: [KEY_URL] }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-b', username: 'uid-other', password: 'b', urls: [KEY_URL] }) },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-c', username: 'uid-123', password: 'c', urls: [KEY_URL] }) },
    );

    const entries = await findEntries(KEY_HOST, 'uid-123', [{ name: 'Work', vaultId: 'vault-w', shareId: 'share-work' }, personal]);
    expect(entries.map((entry) => entry.id)).toEqual(['item-a', 'item-c']);
  });

  it('skips an item that cannot be viewed and keeps the others', async () => {
    simulateSequentialCalls(
      { stdout: itemList({ title: KEY_TITLE, id: 'item-gone' }, { title: KEY_TITLE, id: 'item-c' }) },
      { stdout: '', error: 'pass-cli item failed: item not found' },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-c', username: 'uid-123', password: 'c', urls: [KEY_URL] }) },
    );

    const entries = await findEntries(KEY_HOST, 'uid-123', [personal]);
    expect(entries.map((entry) => entry.id)).toEqual(['item-c']);
  });
});

describe('PassCliStore', () => {
  it('requires a credential host', () => {
    expect(() => new PassCliStore('')).toThrow('requires a credential host');
  });

  it('resolve returns the password of the username entry', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', password: 's3cret', urls: [KEY_URL] }) },
    );

    const creds = await new PassCliStore(KEY_HOST).resolve('uid-123');
    expect(creds).toEqual({ username: 'uid-123', password: 's3cret' });
    expect(argsOfCall(0)).toEqual(['info']);
  });

  it('resolve throws when pass-cli is not logged in', async () => {
    simulateExecFileError('not logged in');
    await expect(new PassCliStore(KEY_HOST).resolve('uid-123')).rejects.toThrow('pass-cli is not logged in');
  });

  it('resolve throws when no entry is found', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: 'GitHub', id: 'item-1' }) },
    );

    await expect(new PassCliStore(KEY_HOST).resolve('uid-123')).rejects.toThrow('No pass-cli session entry found');
    expect(mockExecFile.mock.calls.map((c) => c[1][1]).filter((sub: string) => sub === 'view')).toHaveLength(0);
  });

  it('resolve throws when the entry has no password', async () => {
    simulateSequentialCalls(
      { stdout: '' },
      { stdout: vaultList(personal) },
      { stdout: itemList({ title: KEY_TITLE }) },
      { stdout: itemView({ title: KEY_TITLE, username: 'uid-123', urls: [KEY_URL] }) },
    );

    await expect(new PassCliStore(KEY_HOST).resolve('uid-123')).rejects.toThrow('No pass-cli session entry found');
  });

  it('store creates the entry from a stdin template in the first owned vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }, personal) },
      { stdout: shareList({ id: 'share-team', role: 'Editor' }, { id: 'share-1', role: 'Owner' }) },
      { stdout: itemList() },
      { stdout: itemList() },
      { stdout: '' },
    );

    await new PassCliStore(KEY_HOST).store('uid-123', 'derived-key-password');

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

    await new PassCliStore(KEY_HOST).store('uid-123', 'new-key-password');

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
      { stdout: itemList() },
      { stdout: itemView({ title: KEY_TITLE, id: 'item-old', shareId: 'share-team', username: 'uid-123', password: 'old', urls: [KEY_URL] }) },
      { stdout: '' },
      { stdout: '' },
    );

    await new PassCliStore(KEY_HOST).store('uid-123', 'new-key-password');

    expect(argsOfCall(3)).toEqual(listArgs('share-1'));
    expect(argsOfCall(5)).toEqual(['item', 'create', 'login', '--share-id', 'share-1', '--from-template', '-']);
    expect(argsOfCall(6)).toEqual(['item', 'delete', '--share-id', 'share-team', '--item-id', 'item-old']);
  });

  it('store fails without a vault', async () => {
    simulateExecFile(JSON.stringify({ vaults: [] }));
    await expect(new PassCliStore(KEY_HOST).store('uid-123', 'pw')).rejects.toThrow('no vault');
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

    await new PassCliStore(KEY_HOST).store('uid-123', 'pw');

    expect(argsOfCall(4)).toEqual(['item', 'create', 'login', '--share-id', 'share-team', '--from-template', '-']);
  });

  it('store fails when the account may edit no vault', async () => {
    simulateSequentialCalls(
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }) },
      { stdout: shareList({ id: 'share-team', role: 'Viewer' }) },
    );
    await expect(new PassCliStore(KEY_HOST).store('uid-123', 'pw')).rejects.toThrow('no vault this account owns or may edit');
    expect(stdinWrites).toHaveLength(0);
  });

  it('checkWritable lists vaults and roles of a logged-in pass-cli and writes nothing', async () => {
    simulateSequentialCalls(
      { stdout: '{}' },
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }) },
      { stdout: shareList({ id: 'share-team', role: 'Editor' }) },
    );

    await new PassCliStore(KEY_HOST).checkWritable();

    expect(mockExecFile.mock.calls.map((call) => call[1].slice(0, 2))).toEqual([
      ['info'],
      ['vault', 'list'],
      ['share', 'list'],
    ]);
    expect(stdinWrites).toHaveLength(0);
  });

  it('checkWritable fails when pass-cli is not logged in, before listing vaults', async () => {
    simulateExecFileError('not logged in');

    await expect(new PassCliStore(KEY_HOST).checkWritable()).rejects.toThrow(
      'pass-cli has no usable session (pass-cli info failed: not logged in). Run: pass-cli login',
    );
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('checkWritable fails as store does when the account may edit no vault', async () => {
    simulateSequentialCalls(
      { stdout: '{}' },
      { stdout: vaultList({ name: 'Team', shareId: 'share-team' }) },
      { stdout: shareList({ id: 'share-team', role: 'Viewer' }) },
    );

    await expect(new PassCliStore(KEY_HOST).checkWritable()).rejects.toThrow('no vault this account owns or may edit');
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

    await new PassCliStore(KEY_HOST).remove('uid-123');

    expect(deleteCalls()).toEqual([['item', 'delete', '--share-id', 'share-1', '--item-id', 'item-old']]);
  });

  it('remove deletes every duplicate entry for the username', async () => {
    simulateVault(['item-a', 'item-b']);

    await new PassCliStore(KEY_HOST).remove('uid-123');

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

    await expect(new PassCliStore(KEY_HOST).remove('uid-123')).rejects.toThrow('as deleted but still lists it');
  });

  it('store logs and resolves when an entry it replaces cannot be deleted, after creating the new one', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[0] === 'share') cb(null, shareList({ id: 'share-1', role: 'Owner' }), '');
      else if (args[1] === 'list') cb(null, itemList({ title: KEY_TITLE, id: 'item-old' }), '');
      else if (args[1] === 'view') cb(null, itemView({ title: KEY_TITLE, id: 'item-old', username: 'uid-123', password: 'old', urls: [KEY_URL] }), '');
      else if (args[1] === 'create') cb(null, '', '');
      else if (args[1] === 'delete') cb(new Error('exit 1'), '', 'item is locked');
      return childStub();
    });

    await expect(new PassCliStore(KEY_HOST).store('uid-123', 'new')).resolves.toBeUndefined();
    expect(JSON.parse(stdinWrites[0]).password).toBe('new');
    expect(logger.warn).toHaveBeenCalledWith(
      `pass-cli: a replaced session entry at ${KEY_HOST} could not be deleted: pass-cli item failed: item is locked`,
    );
  });

  it('store deletes every entry of the username across vaults once the new entry exists', async () => {
    const team = { name: 'Team', shareId: 'share-team' };
    const entries: Record<string, Array<{ id: string; username: string }>> = {
      'share-team': [{ id: 'item-team', username: 'uid-123' }],
      'share-1': [{ id: 'item-a', username: 'uid-123' }, { id: 'item-other', username: 'uid-other' }, { id: 'item-b', username: 'uid-123' }],
    };
    const order: string[] = [];
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      const shareId = args[args.indexOf('--share-id') + 1];
      const itemId = args[args.indexOf('--item-id') + 1];
      if (args[0] === 'vault') cb(null, vaultList(team, personal), '');
      else if (args[0] === 'share') cb(null, shareList({ id: 'share-team', role: 'Manager' }, { id: 'share-1', role: 'Owner' }), '');
      else if (args[1] === 'list') cb(null, itemList(...entries[shareId].map(({ id }) => ({ title: KEY_TITLE, id, shareId }))), '');
      else if (args[1] === 'view') {
        const entry = entries[shareId].find(({ id }) => id === itemId)!;
        cb(null, itemView({ title: KEY_TITLE, id: itemId, shareId, username: entry.username, password: 'old', urls: [KEY_URL] }), '');
      } else {
        order.push(`${args[1]} ${shareId}${args[1] === 'delete' ? `/${itemId}` : ''}`);
        cb(null, '', '');
      }
      return childStub();
    });

    await new PassCliStore(KEY_HOST).store('uid-123', 'new');

    expect(order).toEqual([
      'create share-1',
      'delete share-team/item-team',
      'delete share-1/item-a',
      'delete share-1/item-b',
    ]);
  });

  it('remove counts a failed delete as success when another process deleted the item meanwhile', async () => {
    const present = new Set(['item-old']);
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[1] === 'list') cb(null, itemList(...[...present].map((id) => ({ title: KEY_TITLE, id }))), '');
      else if (args[1] === 'view') {
        const id = args[args.indexOf('--item-id') + 1];
        cb(null, itemView({ title: KEY_TITLE, id, username: 'uid-123', password: 'pw', urls: [KEY_URL] }), '');
      } else if (args[1] === 'delete') {
        present.clear();
        cb(new Error('exit 1'), '', 'item not found');
      } else cb(null, '', '');
      return childStub();
    });

    await expect(new PassCliStore(KEY_HOST).remove('uid-123')).resolves.toBeUndefined();
    expect(deleteCalls()).toHaveLength(1);
  });

  it('remove rethrows a failed delete when the item is still listed', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      if (args[0] === 'vault') cb(null, vaultList(personal), '');
      else if (args[1] === 'list') cb(null, itemList({ title: KEY_TITLE, id: 'item-locked' }), '');
      else if (args[1] === 'view') cb(null, itemView({ title: KEY_TITLE, id: 'item-locked', username: 'uid-123', password: 'pw', urls: [KEY_URL] }), '');
      else if (args[1] === 'delete') cb(new Error('exit 1'), '', 'item is locked');
      else cb(null, '', '');
      return childStub();
    });

    await expect(new PassCliStore(KEY_HOST).remove('uid-123')).rejects.toThrow('item is locked');
    expect(deleteCalls()).toHaveLength(1);
  });

  it('remove resolves without deleting anything when no entry matches', async () => {
    simulateSequentialCalls(
      { stdout: vaultList(personal) },
      { stdout: itemList() },
    );

    await expect(new PassCliStore(KEY_HOST).remove('uid-123')).resolves.toBeUndefined();
    expect(deleteCalls()).toEqual([]);
  });
});
