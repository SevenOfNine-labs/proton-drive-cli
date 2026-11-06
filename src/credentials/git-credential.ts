import { execFile } from 'child_process';

import { AppError, ErrorCode } from '../errors/types';
import type { CredentialProvider, Credentials } from './types';
import { authTrace, maskIdentifier } from '../utils/auth-trace';

export interface GitCredential {
  protocol: string;
  host: string;
  username: string;
  password: string;
}

const DEFAULT_PROTOCOL = 'https';
const TIMEOUT_MS = 10_000;

/**
 * git-credential(1) attribute values may contain any byte except NUL and
 * newline; CR is excluded as well because git strips a trailing CR itself.
 */
const FORBIDDEN_VALUE_CHARS = /[\r\n\0]/;

/**
 * Environment for `git credential`: never prompt on the terminal or through
 * an askpass program (git(1): GIT_TERMINAL_PROMPT, GIT_ASKPASS, SSH_ASKPASS),
 * so a missing entry fails immediately instead of blocking until the timeout.
 */
function gitCredentialEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
}

/**
 * Reject attribute values that would break the key=value line protocol.
 */
export function assertCredentialValue(name: string, value: string): void {
  if (FORBIDDEN_VALUE_CHARS.test(value)) {
    throw new AppError(
      `git credential ${name} must not contain CR, LF or NUL`,
      ErrorCode.VALIDATION_ERROR,
      { field: name },
      false,
    );
  }
}

/**
 * Attributes of git credential output (git-credential(1), INPUT/OUTPUT
 * FORMAT): `key=value` lines split at the first `=`, ended by a blank line.
 */
function parseCredentialOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') break;
    const eqIndex = line.indexOf('=');
    if (eqIndex < 1) continue;
    result[line.substring(0, eqIndex)] = line.substring(eqIndex + 1);
  }
  return result;
}

/**
 * Format a GitCredential as `key=value\n` lines for stdin.
 */
function formatCredentialInput(fields: Partial<GitCredential>): string {
  const lines: string[] = [];
  for (const name of ['protocol', 'host', 'username', 'password'] as const) {
    const value = fields[name];
    if (!value) continue;
    assertCredentialValue(name, value);
    lines.push(`${name}=${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Run a `git credential <action>` command.
 */
function runGitCredential(
  action: 'fill' | 'approve' | 'reject',
  stdinData: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['credential', action],
      { timeout: TIMEOUT_MS, env: gitCredentialEnvironment() },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          reject(new Error(`git credential ${action} failed: ${msg}`));
          return;
        }
        resolve(stdout);
      },
    );

    // An early exit of git closes stdin; the exit status reported to the
    // callback above is the error, so the EPIPE on the stream is not rethrown.
    child.stdin?.on('error', () => {});
    child.stdin?.write(stdinData);
    child.stdin?.end();
  });
}

// ─── git-credential(1) operations ──────────────────────────────────

/**
 * Look up the password of `username` at `host` with `git credential fill`.
 */
export async function gitCredentialFill(host: string, username: string): Promise<GitCredential> {
  authTrace('credential.git.fill.start', {
    host,
    username: maskIdentifier(username),
  });
  const input = formatCredentialInput({
    protocol: DEFAULT_PROTOCOL,
    host,
    username,
  });

  const output = await runGitCredential('fill', input);
  const parsed = parseCredentialOutput(output);

  if (!parsed.password) {
    authTrace('credential.git.fill.failure', {
      host,
      reason: 'missing-password',
    });
    throw new Error(
      'git credential fill did not return a password. ' +
      'Ensure a credential helper is configured (e.g., git-credential-manager).',
    );
  }

  const credential = {
    protocol: parsed.protocol || DEFAULT_PROTOCOL,
    host: parsed.host || host,
    username,
    password: parsed.password,
  };
  authTrace('credential.git.fill.success', {
    host: credential.host,
    username: maskIdentifier(credential.username),
  });
  return credential;
}

/**
 * Store credentials using `git credential approve`.
 */
export async function gitCredentialApprove(cred: GitCredential): Promise<void> {
  const input = formatCredentialInput(cred);
  await runGitCredential('approve', input);
}

/**
 * Remove credentials using `git credential reject`.
 */
export async function gitCredentialReject(cred: GitCredential): Promise<void> {
  const input = formatCredentialInput(cred);
  await runGitCredential('reject', input);
}

// ─── Provider ──────────────────────────────────────────────────────

/**
 * git-credential(1) provider: `git credential fill/approve/reject` against
 * the configured credential helper (macOS Keychain, Windows Credential
 * Manager, Linux Secret Service, ...). Every call runs through execFile
 * without a shell, with a 10-second timeout; attributes travel on stdin,
 * never as command-line arguments (CWE-214).
 */
export class GitCredentialProvider implements CredentialProvider {
  readonly name = 'git-credential' as const;

  constructor(private readonly host: string) {
    if (!host.trim()) {
      throw new Error('git-credential provider requires a credential host');
    }
    assertCredentialValue('host', host);
  }

  async resolve(username: string): Promise<Credentials> {
    const cred = await gitCredentialFill(this.host, username);
    return { username, password: cred.password };
  }

  async store(username: string, password: string): Promise<void> {
    await gitCredentialApprove({
      protocol: DEFAULT_PROTOCOL,
      host: this.host,
      username,
      password,
    });
  }

  async remove(username: string): Promise<void> {
    await gitCredentialReject({
      protocol: DEFAULT_PROTOCOL,
      host: this.host,
      username,
      password: '',
    });
  }
}
