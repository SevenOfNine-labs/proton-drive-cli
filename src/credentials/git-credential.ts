/**
 * Git Credential Manager provider.
 *
 * Wraps `git credential fill/approve/reject` to resolve, store, and remove
 * credentials via the system's configured credential helper (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service, etc.).
 *
 * Security:
 * - Uses execFile (not exec) to prevent shell injection
 * - 10-second timeout to prevent hanging on interactive helpers
 * - Credentials are passed via stdin, not command-line arguments
 */

import { execFile } from 'child_process';

import { PROTON_CREDENTIAL_HOST } from '../constants';
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
 * Parse `key=value` lines from git credential output.
 *
 * Only a trailing CR/LF is stripped: values keep leading and trailing
 * whitespace, and the first `=` separates key from value. A blank line ends
 * the attribute list.
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
  lines.push(''); // trailing blank line signals end of input
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

// ─── git-credential(1) operations used by the provider ─────────────

/**
 * Resolve credentials using `git credential fill`.
 */
export async function gitCredentialFill(host?: string, username?: string): Promise<GitCredential> {
  authTrace('credential.git.fill.start', {
    host: host || PROTON_CREDENTIAL_HOST,
    username: maskIdentifier(username),
  });
  const input = formatCredentialInput({
    protocol: DEFAULT_PROTOCOL,
    host: host || PROTON_CREDENTIAL_HOST,
    username,
  });

  const output = await runGitCredential('fill', input);
  const parsed = parseCredentialOutput(output);

  if (!(parsed.username || username) || !parsed.password) {
    authTrace('credential.git.fill.failure', {
      host: host || PROTON_CREDENTIAL_HOST,
      reason: 'missing-username-or-password',
    });
    throw new Error(
      'git credential fill did not return username and password. ' +
      'Ensure a credential helper is configured (e.g., git-credential-manager).',
    );
  }

  const credential = {
    protocol: parsed.protocol || DEFAULT_PROTOCOL,
    host: parsed.host || host || PROTON_CREDENTIAL_HOST,
    username: parsed.username || username!,
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

// ─── Class-based provider ──────────────────────────────────────────

export class GitCredentialProvider implements CredentialProvider {
  readonly name = 'git-credential' as const;
  private readonly host: string;

  constructor(host?: string) {
    this.host = host || PROTON_CREDENTIAL_HOST;
    assertCredentialValue('host', this.host);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await gitCredentialFill(this.host);
      return true;
    } catch {
      return false;
    }
  }

  async resolve(options?: { username?: string }): Promise<Credentials> {
    authTrace('credential.resolve.start', {
      provider: this.name,
      host: this.host,
      username: maskIdentifier(options?.username),
    });
    const cred = await gitCredentialFill(this.host, options?.username);
    authTrace('credential.resolve.success', {
      provider: this.name,
      host: this.host,
      username: maskIdentifier(options?.username || cred.username),
    });
    return { username: options?.username || cred.username, password: cred.password };
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

  async verify(): Promise<boolean> {
    authTrace('credential.verify.start', {
      provider: this.name,
      host: this.host,
    });
    try {
      const ok = await this.isAvailable();
      authTrace('credential.verify.success', {
        provider: this.name,
        host: this.host,
        ok,
      });
      return ok;
    } catch (error) {
      authTrace('credential.verify.failure', {
        provider: this.name,
        host: this.host,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
