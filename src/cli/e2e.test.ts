/**
 * Offline compiled-CLI smoke tests: the built CLI runs as a subprocess
 * without contacting Proton, and its public CLI and bridge surfaces must
 * fail closed on input outside their contracts.
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

/** Long option names listed by `<command> --help`. */
function helpOptions(stdout: string): string[] {
  return [...new Set(stdout.match(/--[a-z][a-z-]*/g) ?? [])].sort();
}

describe('CLI surface', () => {
  it('--help lists the command groups and the key-password providers', async () => {
    const r = await runCli(['--help']);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('login');
    expect(r.stdout).toContain('doctor');
    expect(r.stdout).toContain('bridge');
    expect(r.stdout).toContain('--key-password-provider');
  });

  it('login --help offers exactly the key-password options', async () => {
    const r = await runCli(['login', '--help']);

    expect(r.code).toBe(0);
    expect(helpOptions(r.stdout)).toEqual(['--help', '--key-password-host', '--key-password-provider']);
  });

  it('doctor --help offers exactly the offline preflight options', async () => {
    const r = await runCli(['doctor', '--help']);

    expect(r.code).toBe(0);
    expect(helpOptions(r.stdout)).toEqual([
      '--drive-cli-bin',
      '--help',
      '--json',
      '--key-password-host',
      '--key-password-provider',
      '--session-file',
      '--strict',
    ]);
  });
});

describe('bridge protocol', () => {
  it.each(['auth', 'refresh'])('rejects the command %s, which the protocol does not define', async (command) => {
    const r = await runBridge(command, {});

    expect(r.json).toMatchObject({ ok: false, code: 400, error: `Unknown bridge command: ${command}` });
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

  it('rejects request fields outside the protocol before auth-state handling', async () => {
    const r = await runBridge('auth-state', {
      username: 'user@proton.me',
      password: 'secret',
      allowLogin: true,
    });

    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('Unknown bridge request field');
  });

  it('validates upload request fields', async () => {
    await expect(runBridge('upload', { path: '/tmp/testfile' }))
      .resolves.toMatchObject({ json: { ok: false, code: 400, error: expect.stringContaining('oid') } });
    await expect(runBridge('upload', { oid: 'bad', path: '/tmp/testfile' }))
      .resolves.toMatchObject({ json: { ok: false, error: expect.stringContaining('Invalid OID') } });
    await expect(runBridge('upload', { oid: VALID_OID, path: '/tmp/../etc/passwd' }))
      .resolves.toMatchObject({ json: { ok: false, error: expect.stringContaining('traversal') } });
  });

  it('validates download and batch requests', async () => {
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

describe('bridge stdout contract', () => {
  function stdoutLines(stdout: string): string[] {
    return stdout.split('\n').filter((line) => line.length > 0);
  }

  it('writes exactly one JSON line to stdout for auth-state', async () => {
    const home = makeTempHome();
    const r = await runCli(['bridge', 'auth-state'], { stdin: '{}\n', env: { HOME: home } });

    expect(r.code).toBe(0);
    const lines = stdoutLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, payload: { state: 'needs_login' } });
  });

  it('keeps stdout to the envelope even with --debug and DEBUG=true', async () => {
    const home = makeTempHome();
    const r = await runCli(['--debug', 'bridge', 'auth-state'], { stdin: '{}\n', env: { HOME: home, DEBUG: 'true' } });

    const lines = stdoutLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).ok).toBe(true);
  });

  it('answers unreadable input with an error envelope and exit code 1', async () => {
    const r = await runCli(['bridge', 'auth-state'], { stdin: 'not json' });

    expect(r.code).toBe(1);
    const lines = stdoutLines(r.stdout);
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]);
    expect(envelope).toMatchObject({ ok: false, code: 400 });
    expect(JSON.parse(envelope.details)).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('rejects data-credential fields, which the protocol does not define', async () => {
    const r = await runBridge('auth-state', { dataCredentialProvider: 'pass-cli' });
    expect(r.json).toMatchObject({ ok: false, code: 400 });
    expect(r.json.error).toContain('Unknown bridge request field "dataCredentialProvider"');
  });

  it('reports the program name as proton-drive-cli', async () => {
    const r = await runCli(['--help']);

    expect(r.stdout).toContain('Usage: proton-drive-cli');
    expect(r.stdout).not.toMatch(/proton-drive (login|doctor|upload|ls) /);
  });
});
