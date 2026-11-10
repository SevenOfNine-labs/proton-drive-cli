import * as fs from 'fs-extra';
import * as path from 'path';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-client-uid-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');

import { homedir } from 'os';
import { CLIENT_UID_FILE, STATE_DIR } from '../auth/state-dir';
import { logger } from '../utils/logger';
import { CLIENT_UID_PREFIX, loadClientUid } from './client-uid';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('loadClientUid', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.remove(STATE_DIR);
  });

  afterAll(async () => {
    await fs.remove(homedir());
  });

  it('keeps the state directory under the temporary home', () => {
    expect(STATE_DIR.startsWith(homedir())).toBe(true);
    expect(CLIENT_UID_FILE).toBe(path.join(STATE_DIR, 'client-uid.json'));
  });

  it('creates one owner-only client UID and returns it on every later call', async () => {
    const first = await loadClientUid();

    expect(first?.startsWith(CLIENT_UID_PREFIX)).toBe(true);
    expect(first).toMatch(UUID);
    expect(await fs.readJson(CLIENT_UID_FILE)).toEqual({ clientUid: first });
    if (process.platform !== 'win32') {
      expect((await fs.stat(CLIENT_UID_FILE)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(STATE_DIR)).mode & 0o777).toBe(0o700);
    }
    expect(await loadClientUid()).toBe(first);
  });

  it('gives concurrent callers the same client UID', async () => {
    const uids = await Promise.all(Array.from({ length: 6 }, () => loadClientUid()));

    expect(new Set(uids).size).toBe(1);
    expect(await fs.readJson(CLIENT_UID_FILE)).toEqual({ clientUid: uids[0] });
  });

  it.each([
    ['not JSON', 'garbage'],
    ['another prefix', JSON.stringify({ clientUid: 'sdk-js-cli-1234' })],
    ['no client UID', JSON.stringify({})],
  ])('replaces a file with %s', async (_label, content) => {
    await fs.ensureDir(STATE_DIR);
    await fs.writeFile(CLIENT_UID_FILE, content);

    const uid = await loadClientUid();

    expect(uid).toMatch(UUID);
    expect(await fs.readJson(CLIENT_UID_FILE)).toEqual({ clientUid: uid });
  });

  it('returns undefined with a warning when the file cannot be created', async () => {
    await fs.ensureDir(CLIENT_UID_FILE);

    await expect(loadClientUid()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No client UID for upload drafts'));
  });
});
