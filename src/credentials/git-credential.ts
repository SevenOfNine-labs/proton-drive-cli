import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { parse as parseShellWords } from 'shell-quote';

import { AppError, ErrorCode } from '../errors/types';
import type { CredentialStore, Credentials } from './types';
import { authTrace, maskIdentifier } from '../utils/auth-trace';

export interface GitCredential {
  protocol: string;
  host: string;
  username: string;
  password: string;
}

const PROTOCOL = 'https';
const TIMEOUT_MS = 10_000;

/** Root of the file system: git finds no repository above it to apply. */
const GIT_WORKING_DIRECTORY = path.parse(os.tmpdir()).root;

/**
 * git-credential(1) attribute values may contain any byte except NUL and
 * newline; CR is excluded as well because git strips a trailing CR itself.
 */
const FORBIDDEN_VALUE_CHARS = /[\r\n\0]/;

/**
 * Helpers that encrypt secrets at rest (gitcredentials(7)); manager is Git
 * Credential Manager, subject to {@link SECURE_GCM_STORES}.
 */
const SECURE_HELPERS = new Set(['osxkeychain', 'wincred', 'libsecret', 'manager']);

type GcmPlatform = 'win32' | 'darwin' | 'other';

/**
 * Git Credential Manager stores that encrypt at rest, by the platform of the
 * GCM binary; `default` is the store GCM uses when none is configured
 * (GCM docs/credstores.md: wincredman on Windows, keychain on macOS, none on Linux).
 */
const SECURE_GCM_STORES: Record<GcmPlatform, string[]> = {
  win32: ['default', 'wincredman', 'dpapi'],
  darwin: ['default', 'keychain', 'gpg'],
  other: ['secretservice', 'gpg'],
};

const GCM_DEFAULT_STORES: Partial<Record<GcmPlatform, string>> = {
  win32: 'wincredman',
  darwin: 'keychain',
};

/** GCM settings this store sets in the environment, which overrides git configuration (GCM docs/environment.md). */
const GCM_PINNED_VARIABLES = ['GCM_INTERACTIVE', 'GCM_GUI_PROMPT', 'GCM_PROVIDER', 'GCM_CREDENTIAL_STORE'];

/** The helper the store runs and the environment that pins its settings. */
export interface CredentialHelper {
  value: string;
  env: NodeJS.ProcessEnv;
}

/**
 * No terminal, askpass or GUI prompt (git(1) GIT_TERMINAL_PROMPT, GIT_ASKPASS;
 * GCM docs/environment.md) and no repository: GIT_DIR and GIT_WORK_TREE are
 * removed and git runs in the file-system root ({@link GIT_WORKING_DIRECTORY}).
 */
function gitEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'false',
    GCM_GUI_PROMPT: 'false',
    GCM_PROVIDER: 'generic',
    ...extra,
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
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

function runGit(args: string[], stdinData?: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { timeout: TIMEOUT_MS, cwd: GIT_WORKING_DIRECTORY, env: gitEnvironment(env) },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(stderr?.trim() || error.message), { exitCode: error.code }));
          return;
        }
        resolve(stdout);
      },
    );

    // An early exit of git closes stdin; the exit status reported to the
    // callback above is the error, so the EPIPE on the stream is not rethrown.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdinData ?? '');
  });
}

/** `pattern` matches `host` label by label, a `*` label matching any one label (git urlmatch.c match_host). */
function hostPatternMatches(pattern: string, host: string): boolean {
  const patternLabels = pattern.toLowerCase().replace(/\.$/, '').split('.');
  const hostLabels = host.toLowerCase().split('.');
  return patternLabels.length === hostLabels.length &&
    patternLabels.every((label, index) => label === '*' || label === hostLabels[index]);
}

/**
 * Whether git applies the configuration URL `pattern` of `credential.<url>.*`
 * to `https://<host>` without path and user: scheme, percent-decoded host
 * with `*` labels, default port, path, user (gitcredentials(7) CREDENTIAL
 * CONTEXTS, git urlmatch.c); null when it depends on the username.
 */
export function credentialUrlApplies(pattern: string, host: string): boolean | null {
  const match = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?(?:([^@/]*)@)?([^/:]*)(?::([0-9]*))?(\/.*)?$/.exec(pattern);
  if (!match) {
    return false;
  }
  const [, scheme, user, encodedHost, port, encodedPath] = match;
  let patternHost: string;
  let urlPath: string | undefined;
  try {
    patternHost = decodeURIComponent(encodedHost);
    urlPath = encodedPath === undefined ? undefined : decodeURIComponent(encodedPath);
  } catch {
    return false;
  }
  if (scheme !== undefined && scheme.toLowerCase() !== 'https') {
    return false;
  }
  if (port !== undefined && port !== '' && Number(port) !== 443) {
    return false;
  }
  if (urlPath !== undefined && path.posix.normalize(urlPath) !== '/') {
    return false;
  }
  if (patternHost === '' ? scheme === undefined : !hostPatternMatches(patternHost, host)) {
    return false;
  }
  if (user !== undefined) {
    return user === '' || user.includes(':') ? false : null;
  }
  return true;
}

/** The `credential.*` settings git applies to one credential host. */
export interface CredentialConfig {
  helpers: string[];
  credentialStore?: string;
}

/**
 * `credential.helper` and `credential.credentialStore`, general and for
 * `https://<host>`, from the system and global scopes in configuration
 * order, includes followed (git-config(1) `--get-regexp`, `--show-scope`,
 * `--includes`); an empty helper resets the list, as in git.
 */
export async function readCredentialConfig(host: string): Promise<CredentialConfig> {
  let output: string;
  try {
    output = await runGit([
      'config', '--null', '--includes', '--show-scope', '--get-regexp', '^credential\\.(.*\\.)?(helper|credentialstore)$',
    ]);
  } catch (error) {
    if ((error as { exitCode?: unknown }).exitCode === 1) {
      return { helpers: [] };
    }
    throw new Error(`git config --get-regexp credential settings failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const config: CredentialConfig = { helpers: [] };
  const fields = output.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index] !== 'system' && fields[index] !== 'global') {
      continue;
    }
    const newline = fields[index + 1].indexOf('\n');
    const key = newline < 0 ? fields[index + 1] : fields[index + 1].slice(0, newline);
    const parts = /^credential\.(?:(.*)\.)?(helper|credentialstore)$/.exec(key);
    if (!parts) {
      continue;
    }
    const applies = parts[1] === undefined ? true : credentialUrlApplies(parts[1], host);
    if (applies === null) {
      throw new Error(`git config ${key} depends on the credential username; set credential.helper or credential.https://${host}.helper`);
    }
    if (!applies) {
      continue;
    }
    if (newline < 0) {
      throw new Error(`git config ${key} has no value`);
    }
    const value = fields[index + 1].slice(newline + 1);
    if (parts[2] === 'helper') {
      config.helpers = value === '' ? [] : [...config.helpers, value];
    } else {
      config.credentialStore = value;
    }
  }
  return config;
}

/** Quotes, command substitution, parameter expansion and line breaks, which shell-quote does not reject. */
const SHELL_EXPANSION = /[`$'"\r\n]/;

/** git's is_absolute_path: a leading `/`, or on Windows a drive prefix or a leading backslash. */
function isAbsoluteHelperPath(value: string): boolean {
  return value.startsWith('/') || (process.platform === 'win32' && /^(?:[A-Za-z]:)?[\\/]/.test(value));
}

/**
 * Helper name of a `credential.helper` value (gitcredentials(7), "CUSTOM
 * HELPERS"): git passes the value to the shell, as `git credential-<value>`
 * unless it is an absolute path. The name is `<name>` of a plain word, or of
 * an absolute path to a `git-credential-<name>` program; null for a shell
 * snippet (`!...`), a value with quotes, expansions, shell operators,
 * redirections or globs, or any other program.
 */
export function credentialHelperName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('!') || SHELL_EXPANSION.test(trimmed)) {
    return null;
  }
  const words = parseShellWords(trimmed, (variable) => `$${variable}`);
  if (words.length === 0 || words.some((word) => typeof word !== 'string')) {
    return null;
  }
  const program = words[0] as string;
  if (!isAbsoluteHelperPath(trimmed)) {
    return /^[A-Za-z0-9._-]+$/.test(program) ? program.toLowerCase() : null;
  }
  const base = (program.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  return base.startsWith('git-credential-') ? base.slice('git-credential-'.length) : null;
}

/** Platform whose GCM build `helper` runs; a `.exe` started outside Windows is the Windows build under WSL. */
function gcmPlatform(helper: string): GcmPlatform {
  if (/\.exe\b/i.test(helper) || process.platform === 'win32') {
    return 'win32';
  }
  return process.platform === 'darwin' ? 'darwin' : 'other';
}

/**
 * Environment pinning GCM's store to the validated one. A Windows GCM started
 * from WSL receives Linux variables only when WSLENV names them (Microsoft
 * WSL documentation, "Share environment variables between Windows and WSL").
 */
function gcmEnvironment(helper: string, store: string): NodeJS.ProcessEnv {
  const platform = gcmPlatform(helper);
  const env: NodeJS.ProcessEnv = {
    GCM_CREDENTIAL_STORE: store === 'default' ? GCM_DEFAULT_STORES[platform] : store,
  };
  if (platform === 'win32' && process.platform !== 'win32') {
    env.WSLENV = [process.env.WSLENV, ...GCM_PINNED_VARIABLES].filter(Boolean).join(':');
  }
  return env;
}

/** GCM's credential store: GCM_CREDENTIAL_STORE, else credential.credentialStore (GCM docs/configuration.md). */
function gcmCredentialStore(config: CredentialConfig): string {
  const configured = process.env.GCM_CREDENTIAL_STORE?.trim() || config.credentialStore?.trim();
  return configured ? configured.toLowerCase() : 'default';
}

/**
 * The helper this store runs for `host`: the first helper of the system and
 * global configuration that git applies to `https://<host>` and that encrypts
 * secrets at rest, with GCM's store pinned in its environment. `git
 * credential approve` sends the credential to every configured helper
 * (git-credential(1)), so the store pins this one helper and a plaintext
 * `store` or an in-memory `cache` never receives the session secrets. An
 * empty value resets the list, as in git.
 */
export async function selectCredentialHelper(host: string): Promise<CredentialHelper> {
  const config = await readCredentialConfig(host);
  const rejected: string[] = [];
  for (const helper of config.helpers) {
    const name = credentialHelperName(helper);
    if (name === null || !SECURE_HELPERS.has(name)) {
      rejected.push(name ?? 'custom program');
      continue;
    }
    let env: NodeJS.ProcessEnv = {};
    if (name === 'manager') {
      const store = gcmCredentialStore(config);
      if (!SECURE_GCM_STORES[gcmPlatform(helper)].includes(store)) {
        rejected.push(`manager with credential store ${store}`);
        continue;
      }
      env = gcmEnvironment(helper, store);
    }
    authTrace('credential.git.helper', { helper: name });
    return { value: helper, env };
  }
  throw new Error(
    'git has no credential helper that encrypts secrets at rest ' +
      `(configured: ${rejected.length > 0 ? rejected.join(', ') : 'none'}). ` +
      `Set credential.helper, or credential.https://${host}.helper, to osxkeychain, wincred, libsecret or manager`,
  );
}

/** Run `git credential <action>` with the selected helper as the only one (git-config(1), command scope last). */
async function runGitCredential(action: 'fill' | 'approve' | 'reject', host: string, stdinData: string): Promise<string> {
  const helper = await selectCredentialHelper(host);
  try {
    return await runGit(
      [
        '-c', 'credential.helper=',
        '-c', `credential.helper=${helper.value}`,
        '-c', 'credential.interactive=false',
        'credential', action,
      ],
      stdinData,
      helper.env,
    );
  } catch (error) {
    throw new Error(`git credential ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const output = await runGitCredential('fill', host, formatCredentialInput({ protocol: PROTOCOL, host, username }));
  const parsed = parseCredentialOutput(output);

  if (!parsed.password) {
    authTrace('credential.git.fill.failure', {
      host,
      reason: 'missing-password',
    });
    throw new Error('git credential fill returned no entry for this session');
  }

  authTrace('credential.git.fill.success', {
    host,
    username: maskIdentifier(username),
  });
  return { protocol: PROTOCOL, host, username, password: parsed.password };
}

/**
 * Store credentials using `git credential approve`.
 */
export async function gitCredentialApprove(cred: GitCredential): Promise<void> {
  await runGitCredential('approve', cred.host, formatCredentialInput(cred));
}

/**
 * Remove every entry of `username` at `host` using `git credential reject`
 * without a password, which erases regardless of the stored value.
 */
export async function gitCredentialReject(host: string, username: string): Promise<void> {
  await runGitCredential('reject', host, formatCredentialInput({ protocol: PROTOCOL, host, username }));
}

// ─── Store ─────────────────────────────────────────────────────────

/**
 * git-credential(1) store: `git credential fill/approve/reject` through the
 * helper {@link selectCredentialHelper} selects. Every call runs through
 * execFile without a shell, with a 10-second timeout; attributes travel on
 * stdin, never as command-line arguments (CWE-214).
 */
export class GitCredentialStore implements CredentialStore {
  readonly name = 'git-credential' as const;

  constructor(private readonly host: string) {
    if (!host.trim()) {
      throw new Error('git-credential store requires a credential host');
    }
    assertCredentialValue('host', host);
  }

  async resolve(username: string): Promise<Credentials> {
    const cred = await gitCredentialFill(this.host, username);
    return { username, password: cred.password };
  }

  /**
   * `approve`, then `fill` to read it back; a helper that kept the existing
   * item gets `reject` and `approve` (git-credential(1)), so readers see an
   * entry at all times unless the helper cannot update one in place.
   */
  async store(username: string, password: string): Promise<void> {
    const credential = { protocol: PROTOCOL, host: this.host, username, password };
    await gitCredentialApprove(credential);
    const stored = await gitCredentialFill(this.host, username).then((cred) => cred.password, () => undefined);
    if (stored === password) {
      return;
    }
    await gitCredentialReject(this.host, username);
    await gitCredentialApprove(credential);
  }

  async remove(username: string): Promise<void> {
    await gitCredentialReject(this.host, username);
  }

  /** Selects the helper as `store` does; runs no helper, so none can prompt. */
  async checkWritable(): Promise<void> {
    await selectCredentialHelper(this.host);
  }
}
