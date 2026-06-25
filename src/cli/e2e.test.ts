/**
 * Offline compiled-CLI smoke tests.
 *
 * These run the built CLI as a subprocess. They intentionally do not perform
 * real Proton login; the goal is to prove the public CLI and bridge surfaces
 * fail closed and no longer accept account-password/SRP inputs.
 */

import { execFile, ExecFileException } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const CLI_BIN = path.resolve(__dirname, '../../dist/index.js');
const NODE = process.execPath;
const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

function runCli(
  args: string[],
  options: { stdin?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      NODE,
      [CLI_BIN, ...args],
      {
        timeout: options.timeout || 10_000,
        env: { ...process.env, ...options.env, NODE_ENV: 'test' },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          code: error?.code ? (typeof error.code === 'number' ? error.code : 1) : 0,
        });
      },
    );
    if (options.stdin !== undefined) {
      child.stdin!.write(options.stdin);
      child.stdin!.end();
    }
  });
}

async function runBridge(
  command: string,
  payload: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number; json: any }> {
  const r = await runCli(['bridge', command], {
    stdin: JSON.stringify(payload),
    env,
  });
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const json = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  return { ...r, json };
}

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proton-drive-cli-e2e-'));
}

describe('CLI surface', () => {
  it('--help shows browser-fork auth and no credential command', async () => {
    const r = await runCli(['--help']);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('login');
    expect(r.stdout).toContain('doctor');
    expect(r.stdout).toContain('bridge');
    expect(r.stdout).toContain('--key-password-provider');
    expect(r.stdout).not.toContain('credential store');
    expect(r.stdout).not.toContain('--password-stdin');
  });

  it('login --help exposes only browser-fork key-password options', async () => {
    const r = await runCli(['login', '--help']);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--key-password-provider');
    expect(r.stdout).toContain('--key-password-host');
    expect(r.stdout).not.toContain('--username');
    expect(r.stdout).not.toContain('--password-stdin');
    expect(r.stdout).not.toContain('--credential-provider');
    expect(r.stdout).not.toContain('--auth-mode');
  });

  it('credential command is not registered', async () => {
    const r = await runCli(['credential', '--help']);

    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('Store credentials');
    expect(r.stdout).not.toContain('--username');
    expect(r.stdout).not.toContain('--password-stdin');
  });
});

describe('bridge protocol', () => {
  it('rejects the removed bridge auth command', async () => {
    const r = await runBridge('auth', {});

    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('Unknown bridge command: auth');
  });

  it('auth-state is local-only and reports needs_login for an empty temp home', async () => {
    const home = makeTempHome();
    const r = await runBridge('auth-state', {}, { HOME: home });

    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.payload).toMatchObject({
      state: 'needs_login',
      hasSession: false,
      willAttemptNetwork: false,
    });
  });

  it('rejects forbidden account-login fields before auth-state handling', async () => {
    const r = await runBridge('auth-state', {
      username: 'user@proton.me',
      password: 'secret',
      allowLogin: true,
    });

    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('Unknown bridge request field');
  });

  it('validates upload request fields without accepting account password', async () => {
    await expect(runBridge('upload', { path: '/tmp/testfile' }))
      .resolves.toMatchObject({ json: { ok: false, code: 400, error: expect.stringContaining('oid') } });
    await expect(runBridge('upload', { oid: 'bad', path: '/tmp/testfile' }))
      .resolves.toMatchObject({ json: { ok: false, error: expect.stringContaining('Invalid OID') } });
    await expect(runBridge('upload', { oid: VALID_OID, path: '/tmp/../etc/passwd' }))
      .resolves.toMatchObject({ json: { ok: false, error: expect.stringContaining('traversal') } });
  });

  it('validates download and batch requests without account password', async () => {
    await expect(runBridge('download', { outputPath: '/tmp/out' }))
      .resolves.toMatchObject({ json: { ok: false, code: 400, error: expect.stringContaining('oid') } });
    await expect(runBridge('batch-exists', { oids: 'not-array' }))
      .resolves.toMatchObject({ json: { ok: false, code: 400, error: expect.stringContaining('array of strings') } });
    await expect(runBridge('batch-delete', { oids: [VALID_OID, 'bad'] }))
      .resolves.toMatchObject({ json: { ok: false, error: expect.stringContaining('Invalid OID') } });
  });

  it('unknown request fields fail before transfer setup', async () => {
    const r = await runBridge('init', {
      storageBase: 'LFS',
      credentialProvider: 'git-credential',
    });

    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('Unknown bridge request field "credentialProvider"');
  });
});
