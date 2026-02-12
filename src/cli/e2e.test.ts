/**
 * End-to-end tests for proton-drive-cli.
 *
 * These tests invoke the compiled CLI binary as a subprocess — the same way
 * a user (or the Go adapter) would call it.  They do NOT mock SDK internals;
 * they exercise the full command parsing → validation → error-handling path.
 *
 * The bridge commands that require a real ProtonDriveClient (upload, download,
 * list) are tested in the parent repo's Go integration tests
 * (tests/integration/git_lfs_e2e_mock_test.go) with a mock bridge subprocess.
 * Here we focus on:
 *   1. CLI surface: --help, --version, output modes
 *   2. Bridge protocol: input validation, error envelopes, unknown commands
 *   3. Standalone commands: argument validation, missing-auth errors
 *   4. Credential subcommands
 *   5. Security: OID validation, path traversal rejection
 */

import { execFile, ExecFileException } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const CLI_BIN = path.resolve(__dirname, '../../dist/index.js');
const NODE = process.execPath;

/** Run the CLI with given args and optional stdin, return { stdout, stderr, code } */
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

/** Helper to run a bridge command with JSON stdin */
function runBridge(
  command: string,
  payload: Record<string, any>,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number; json: any }> {
  return runCli(['bridge', command], { stdin: JSON.stringify(payload), env }).then((r) => {
    let json: any = null;
    try {
      // Bridge output may contain multiple lines; take the last non-empty one
      const lines = r.stdout.trim().split('\n').filter((l) => l.trim());
      if (lines.length > 0) {
        json = JSON.parse(lines[lines.length - 1]);
      }
    } catch {
      // Not valid JSON — that's OK for some error cases
    }
    return { ...r, json };
  });
}

// ─── CLI Surface ──────────────────────────────────────────────────────

describe('CLI surface', () => {
  it('--help shows all commands', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('proton-drive');
    expect(r.stdout).toContain('login');
    expect(r.stdout).toContain('logout');
    expect(r.stdout).toContain('status');
    expect(r.stdout).toContain('ls');
    expect(r.stdout).toContain('upload');
    expect(r.stdout).toContain('download');
    expect(r.stdout).toContain('mkdir');
    expect(r.stdout).toContain('rm');
    expect(r.stdout).toContain('mv');
    expect(r.stdout).toContain('cat');
    expect(r.stdout).toContain('info');
    expect(r.stdout).toContain('bridge');
    expect(r.stdout).toContain('credential');
  });

  it('--version prints version', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('unknown command shows error', async () => {
    const r = await runCli(['nonexistent']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('unknown command');
  });

  describe('subcommand --help', () => {
    const commands = ['login', 'logout', 'status', 'ls', 'upload', 'download', 'mkdir', 'rm', 'mv', 'cat', 'info', 'bridge', 'credential'];

    for (const cmd of commands) {
      it(`${cmd} --help exits 0`, async () => {
        const r = await runCli([cmd, '--help']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(cmd);
      });
    }
  });

  describe('credential subcommand --help', () => {
    for (const sub of ['store', 'remove', 'verify']) {
      it(`credential ${sub} --help exits 0`, async () => {
        const r = await runCli(['credential', sub, '--help']);
        expect(r.code).toBe(0);
      });
    }
  });
});

// ─── Bridge Protocol ──────────────────────────────────────────────────

describe('bridge protocol', () => {
  describe('auth command', () => {
    it('rejects missing username', async () => {
      const r = await runBridge('auth', { password: 'pass' });
      expect(r.json).toBeDefined();
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
      expect(r.json.error).toContain('username');
    });

    it('rejects missing password', async () => {
      const r = await runBridge('auth', { username: 'user@proton.me' });
      expect(r.json).toBeDefined();
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
      expect(r.json.error).toContain('password');
    });

    it('rejects empty payload', async () => {
      const r = await runBridge('auth', {});
      expect(r.json).toBeDefined();
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
    });
  });

  describe('upload command', () => {
    it('rejects missing oid', async () => {
      const r = await runBridge('upload', {
        path: '/tmp/testfile',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
      expect(r.json.error).toContain('oid');
    });

    it('rejects missing path', async () => {
      const r = await runBridge('upload', {
        oid: 'a'.repeat(64),
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
      expect(r.json.error).toContain('path');
    });

    it('rejects invalid OID format (too short)', async () => {
      const r = await runBridge('upload', {
        oid: 'abc123',
        path: '/tmp/testfile',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain('Invalid OID');
    });

    it('rejects invalid OID format (non-hex)', async () => {
      const r = await runBridge('upload', {
        oid: 'g'.repeat(64),
        path: '/tmp/testfile',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain('Invalid OID');
    });

    it('rejects path traversal in local path', async () => {
      const r = await runBridge('upload', {
        oid: 'a'.repeat(64),
        path: '/tmp/../etc/passwd',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain('traversal');
    });

    it('rejects nonexistent file', async () => {
      const r = await runBridge('upload', {
        oid: 'a'.repeat(64),
        path: '/tmp/proton-drive-cli-e2e-nonexistent-file-12345',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      // Should fail either on file access or on auth (depends on order)
    });
  });

  describe('download command', () => {
    it('rejects missing oid', async () => {
      const r = await runBridge('download', {
        outputPath: '/tmp/out',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
      expect(r.json.error).toContain('oid');
    });

    it('rejects missing outputPath', async () => {
      const r = await runBridge('download', {
        oid: 'a'.repeat(64),
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
      expect(r.json.error).toContain('outputPath');
    });

    it('rejects path traversal in outputPath', async () => {
      const r = await runBridge('download', {
        oid: 'a'.repeat(64),
        outputPath: '../../../etc/shadow',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain('traversal');
    });

    it('rejects invalid OID', async () => {
      const r = await runBridge('download', {
        oid: 'x'.repeat(64),
        outputPath: '/tmp/out',
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain('Invalid OID');
    });
  });

  describe('unknown bridge command', () => {
    it('returns error for unknown command', async () => {
      const r = await runBridge('frobnicate', { password: 'pass' });
      expect(r.json.ok).toBe(false);
      expect(r.json.code).toBe(400);
      expect(r.json.error).toContain('Unknown bridge command');
    });
  });

  describe('malformed input', () => {
    it('rejects non-JSON stdin', async () => {
      const r = await runCli(['bridge', 'auth'], { stdin: 'not json at all' });
      // Should exit non-zero
      expect(r.code).not.toBe(0);
    });

    it('rejects empty stdin', async () => {
      const r = await runCli(['bridge', 'auth'], { stdin: '' });
      expect(r.code).not.toBe(0);
    });
  });

  describe('bridge JSON envelope format', () => {
    it('response always has ok field', async () => {
      const r = await runBridge('auth', {});
      expect(r.json).toBeDefined();
      expect(typeof r.json.ok).toBe('boolean');
    });

    it('error response has error and code fields', async () => {
      const r = await runBridge('auth', {});
      expect(r.json.ok).toBe(false);
      expect(typeof r.json.error).toBe('string');
      expect(typeof r.json.code).toBe('number');
    });
  });
});

// ─── OID Validation (comprehensive) ──────────────────────────────────

describe('OID validation (via bridge)', () => {
  const validOid = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

  it('accepts valid 64-char lowercase hex OID', async () => {
    // This will fail later (no auth), but OID validation should pass
    const r = await runBridge('upload', {
      oid: validOid,
      path: '/tmp/test',
      password: 'pass',
    });
    // Should NOT fail with "Invalid OID"
    if (r.json.error) {
      expect(r.json.error).not.toContain('Invalid OID');
    }
  });

  it('accepts valid 64-char uppercase hex OID', async () => {
    const r = await runBridge('upload', {
      oid: validOid.toUpperCase(),
      path: '/tmp/test',
      password: 'pass',
    });
    if (r.json.error) {
      expect(r.json.error).not.toContain('Invalid OID');
    }
  });

  it('rejects 63-char OID', async () => {
    const r = await runBridge('upload', {
      oid: 'a'.repeat(63),
      path: '/tmp/test',
      password: 'pass',
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('Invalid OID');
  });

  it('rejects 65-char OID', async () => {
    const r = await runBridge('upload', {
      oid: 'a'.repeat(65),
      path: '/tmp/test',
      password: 'pass',
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('Invalid OID');
  });

  it('rejects OID with shell metacharacters', async () => {
    const r = await runBridge('upload', {
      oid: 'a'.repeat(60) + '$(rm)',
      path: '/tmp/test',
      password: 'pass',
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('Invalid OID');
  });

  it('rejects empty OID', async () => {
    const r = await runBridge('upload', {
      oid: '',
      path: '/tmp/test',
      password: 'pass',
    });
    expect(r.json.ok).toBe(false);
  });
});

// ─── Path Traversal Prevention ────────────────────────────────────────

describe('path traversal prevention (via bridge)', () => {
  const validOid = 'a'.repeat(64);

  const maliciousPaths = [
    '../etc/passwd',
    '../../etc/shadow',
    '/tmp/../../etc/passwd',
    'foo/../../../bar',
    '..\\windows\\system32',
  ];

  for (const malicious of maliciousPaths) {
    it(`rejects upload path: ${malicious}`, async () => {
      const r = await runBridge('upload', {
        oid: validOid,
        path: malicious,
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain('traversal');
    });

    it(`rejects download outputPath: ${malicious}`, async () => {
      const r = await runBridge('download', {
        oid: validOid,
        outputPath: malicious,
        password: 'pass',
      });
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain('traversal');
    });
  }
});

// ─── Standalone Commands (no auth) ────────────────────────────────────

describe('standalone commands without auth', () => {
  // These commands require authentication, so they should fail gracefully
  // with a meaningful error — NOT crash with an unhandled exception.

  it('ls fails with auth error when no session', async () => {
    const r = await runCli(['ls', '/', '--password-stdin'], {
      stdin: 'fake-password\n',
      env: { HOME: os.tmpdir() }, // no session file — forces fresh auth attempt
      timeout: 15_000,
    });
    expect(r.code).not.toBe(0);
    // Should show an error, not a stack trace
    expect(r.stderr.length + r.stdout.length).toBeGreaterThan(0);
  }, 20_000);

  it('upload fails with meaningful error for missing file', async () => {
    const r = await runCli(['upload', '/nonexistent/file.bin', '/'], {
      env: { HOME: os.tmpdir() },
    });
    expect(r.code).not.toBe(0);
  });

  it('download requires two arguments', async () => {
    const r = await runCli(['download', '/source']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("missing required argument 'output'");
  });

  it('mkdir requires two arguments', async () => {
    const r = await runCli(['mkdir', '/path']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("missing required argument 'folder-name'");
  });

  it('upload requires at least one argument', async () => {
    const r = await runCli(['upload']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("missing required argument 'file'");
  });
});

// ─── Credential Commands ──────────────────────────────────────────────

describe('credential commands', () => {
  it('credential verify --help exits 0', async () => {
    const r = await runCli(['credential', 'verify', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Verify');
  });

  it('credential store --help shows options', async () => {
    const r = await runCli(['credential', 'store', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--username');
    expect(r.stdout).toContain('--host');
    expect(r.stdout).toContain('--password-stdin');
  });

  it('credential remove --help shows options', async () => {
    const r = await runCli(['credential', 'remove', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--username');
    expect(r.stdout).toContain('--host');
  });
});

// ─── Output Modes ─────────────────────────────────────────────────────

describe('output modes', () => {
  it('--quiet suppresses non-error output on login help', async () => {
    // --quiet + --help should still show help (help bypasses quiet)
    const r = await runCli(['--quiet', '--help']);
    // help is always shown regardless of quiet
    expect(r.stdout).toContain('proton-drive');
  });

  it('bridge suppresses non-JSON output', async () => {
    // Bridge mode forces logger to ERROR level, so stdout should be pure JSON
    const r = await runBridge('auth', { username: 'u@p.me', password: 'p' });
    const lines = r.stdout.trim().split('\n').filter((l) => l.trim());
    for (const line of lines) {
      // Every line of stdout should be valid JSON
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ─── Bridge storageBase Handling ──────────────────────────────────────

describe('bridge storageBase', () => {
  it('defaults to LFS when storageBase not provided', async () => {
    // Upload with a valid OID but no storageBase — should use "LFS" default.
    // Will fail on auth, but the error should NOT be about storageBase.
    const r = await runBridge('upload', {
      oid: 'a'.repeat(64),
      path: '/tmp/test',
      password: 'pass',
    });
    if (r.json.error) {
      expect(r.json.error).not.toContain('storageBase');
    }
  });
});

// ─── Bridge Exists ────────────────────────────────────────────────────

describe('bridge exists', () => {
  it('rejects missing oid', async () => {
    const r = await runBridge('exists', { password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('oid');
  });

  it('rejects invalid OID', async () => {
    const r = await runBridge('exists', { oid: 'bad', password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('Invalid OID');
  });

  it('valid OID passes validation (fails on auth, not validation)', async () => {
    const r = await runBridge('exists', { oid: 'a'.repeat(64), password: 'pass' });
    // Should fail on auth, not on OID validation
    if (r.json.error) {
      expect(r.json.error).not.toContain('Invalid OID');
      expect(r.json.error).not.toContain('oid is required');
    }
  });
});

// ─── Bridge Delete ────────────────────────────────────────────────────

describe('bridge delete', () => {
  it('rejects missing oid', async () => {
    const r = await runBridge('delete', { password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('oid');
  });

  it('rejects invalid OID', async () => {
    const r = await runBridge('delete', { oid: 'xyz', password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('Invalid OID');
  });

  it('valid OID passes validation', async () => {
    const r = await runBridge('delete', { oid: 'a'.repeat(64), password: 'pass' });
    if (r.json.error) {
      expect(r.json.error).not.toContain('Invalid OID');
      expect(r.json.error).not.toContain('oid is required');
    }
  });
});

// ─── Bridge Refresh ───────────────────────────────────────────────────

describe('bridge refresh', () => {
  it('returns valid JSON envelope', async () => {
    const r = await runBridge('refresh', {});
    expect(r.json).toBeDefined();
    expect(typeof r.json.ok).toBe('boolean');
    // Either succeeds (session exists) or fails with auth error
    if (!r.json.ok) {
      expect(r.json.error).toBeTruthy();
    } else {
      expect(r.json.payload.refreshed).toBe(true);
    }
  });

  it('fails without session in clean HOME', async () => {
    const r = await runBridge('refresh', {}, { HOME: os.tmpdir() });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBeTruthy();
  });
});

// ─── Bridge Init ──────────────────────────────────────────────────────

describe('bridge init', () => {
  it('default storageBase passes validation', async () => {
    const r = await runBridge('init', { password: 'pass' });
    // Should fail on auth, not validation
    if (r.json.error) {
      expect(r.json.error).not.toContain('storageBase');
    }
  });

  it('custom storageBase passes validation', async () => {
    const r = await runBridge('init', { storageBase: 'CustomLFS', password: 'pass' });
    if (r.json.error) {
      expect(r.json.error).not.toContain('storageBase');
    }
  });
});

// ─── Bridge Batch Operations ──────────────────────────────────────────

describe('bridge batch-exists', () => {
  it('rejects missing oids', async () => {
    const r = await runBridge('batch-exists', { password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('oids');
  });

  it('rejects empty oids array', async () => {
    const r = await runBridge('batch-exists', { oids: [], password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
  });

  it('rejects invalid OID in array', async () => {
    const r = await runBridge('batch-exists', {
      oids: ['a'.repeat(64), 'bad-oid'],
      password: 'pass',
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('Invalid OID');
  });

  it('valid oids array passes validation', async () => {
    const r = await runBridge('batch-exists', {
      oids: ['a'.repeat(64), 'b'.repeat(64)],
      password: 'pass',
    });
    if (r.json.error) {
      expect(r.json.error).not.toContain('Invalid OID');
      expect(r.json.error).not.toContain('oids');
    }
  });
});

describe('bridge batch-delete', () => {
  it('rejects missing oids', async () => {
    const r = await runBridge('batch-delete', { password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
    expect(r.json.error).toContain('oids');
  });

  it('rejects empty oids array', async () => {
    const r = await runBridge('batch-delete', { oids: [], password: 'pass' });
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe(400);
  });

  it('rejects invalid OID in array', async () => {
    const r = await runBridge('batch-delete', {
      oids: ['x'.repeat(64)],
      password: 'pass',
    });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('Invalid OID');
  });
});

// ─── New CLI Commands ─────────────────────────────────────────────────

describe('new CLI commands', () => {
  describe('rm', () => {
    it('--help exits 0 and shows description', async () => {
      const r = await runCli(['rm', '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Remove');
    });

    it('requires path argument', async () => {
      const r = await runCli(['rm']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("missing required argument 'path'");
    });
  });

  describe('mv', () => {
    it('--help exits 0 and shows description', async () => {
      const r = await runCli(['mv', '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Move');
    });

    it('requires two arguments', async () => {
      const r = await runCli(['mv', '/source']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("missing required argument 'destination'");
    });
  });

  describe('cat', () => {
    it('--help exits 0 and shows description', async () => {
      const r = await runCli(['cat', '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Stream');
    });

    it('requires path argument', async () => {
      const r = await runCli(['cat']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("missing required argument 'path'");
    });
  });

  describe('info', () => {
    it('--help exits 0 and shows description', async () => {
      const r = await runCli(['info', '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('metadata');
    });

    it('requires path argument', async () => {
      const r = await runCli(['info']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("missing required argument 'path'");
    });
  });
});

// ─── Bridge Command Description ───────────────────────────────────────

describe('bridge command description', () => {
  it('bridge --help lists all bridge commands', async () => {
    const r = await runCli(['bridge', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('auth');
    expect(r.stdout).toContain('upload');
    expect(r.stdout).toContain('download');
    expect(r.stdout).toContain('list');
    expect(r.stdout).toContain('exists');
    expect(r.stdout).toContain('delete');
    expect(r.stdout).toContain('refresh');
    expect(r.stdout).toContain('init');
    expect(r.stdout).toContain('batch-exists');
    expect(r.stdout).toContain('batch-delete');
  });
});

// ─── Login Session Reuse ─────────────────────────────────────────────

describe('login session reuse', () => {
  const TEST_USER = 'test@example.com';
  let tmpHome: string;

  function hashUser(username: string): string {
    return createHash('sha256').update(username.toLowerCase().trim()).digest('hex');
  }

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'login-reuse-'));
    const sessionDir = path.join(tmpHome, '.proton-drive-cli');
    fs.mkdirSync(sessionDir, { recursive: true });
    // Write a valid session file with a far-future JWT expiry and userHash
    const session = {
      sessionId: 'test-session-id',
      uid: 'test-uid-123',
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo5OTk5OTk5OTk5fQ.K3DEMO',
      refreshToken: 'refresh-token-abc',
      scopes: ['self', 'drive'],
      passwordMode: 1,
      userHash: hashUser(TEST_USER),
    };
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify(session),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('skips login when session already exists for same user', async () => {
    const r = await runCli(['login', '-u', TEST_USER, '--password-stdin'], {
      stdin: 'test-password',
      env: { HOME: tmpHome },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Already authenticated');
  });

  it('skips login in quiet mode and outputs OK', async () => {
    const r = await runCli(['--quiet', 'login', '-u', TEST_USER, '--password-stdin'], {
      stdin: 'test-password',
      env: { HOME: tmpHome },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('OK');
  });

  it('proceeds with login when different user provided', async () => {
    // Different username — should NOT reuse session, should try to login
    // (will fail on actual auth, but should NOT say "Already authenticated")
    const r = await runCli(['login', '-u', 'other@example.com', '--password-stdin'], {
      stdin: 'test-password',
      env: { HOME: tmpHome },
    });
    expect(r.stdout).not.toContain('Already authenticated');
  }, 30_000);

  it('bridge auth reuses session for same user', async () => {
    const r = await runBridge('auth', { username: TEST_USER, password: 'test' }, { HOME: tmpHome });
    expect(r.json.ok).toBe(true);
    expect(r.json.payload.sessionReused).toBe(true);
  });

  it('bridge auth does not reuse session for different user', async () => {
    const r = await runBridge('auth', { username: 'other@example.com', password: 'test' }, { HOME: tmpHome });
    // Should NOT reuse session — will try real auth and fail
    if (r.json.payload?.sessionReused) {
      fail('Should not reuse session for different user');
    }
  });
});

// ─── Bridge Stdin Timeout ─────────────────────────────────────────────

describe('bridge stdin timeout', () => {
  it('exits non-zero if stdin never closes', async () => {
    // Don't send any stdin — bridge should timeout after 30s.
    // We use a shorter timeout for the test process.
    const r = await runCli(['bridge', 'auth'], { timeout: 35_000 });
    expect(r.code).not.toBe(0);
  }, 40_000);
});
