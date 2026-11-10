import * as childProcess from 'child_process';
import * as os from 'os';
import * as path from 'path';
import {
  credentialHelperName,
  credentialUrlApplies,
  gitCredentialFill,
  gitCredentialApprove,
  gitCredentialReject,
  GitCredentialStore,
  selectCredentialHelper,
} from './git-credential';

jest.mock('child_process');

const mockExecFile = childProcess.execFile as unknown as jest.Mock;

const KEY_HOST = 'proton-drive-cli.invalid';
const WSL_GCM = '/mnt/c/Program\\ Files/Git/mingw64/bin/git-credential-manager.exe';
const GCM_WSLENV = 'GCM_INTERACTIVE:GCM_GUI_PROMPT:GCM_PROVIDER:GCM_CREDENTIAL_STORE';
const PINNED = (helper: string, action: string) => [
  '-c', 'credential.helper=',
  '-c', `credential.helper=${helper}`,
  '-c', 'credential.interactive=false',
  'credential', action,
];

interface GitResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface FakeGit {
  /** Values of the system scope by key. */
  system?: Record<string, string[]>;
  /** Values of the global scope by key. */
  global?: Record<string, string[]>;
  /** Values of the local scope by key, listed after the global ones. */
  local?: Record<string, string[]>;
  /** Values of the command scope by key (`-c`, GIT_CONFIG_COUNT), listed last. */
  command?: Record<string, string[]>;
  /** Entries in configuration order, in place of the scopes above; a null value is a key without `=`. */
  entries?: Array<[scope: string, key: string, value: string | null]>;
  /** Exit status of `git config` for every key, in place of the values. */
  configExitCode?: number;
  /** Result of `git credential <action>` for the stdin it received. */
  credential?: (action: string, stdin: string) => GitResult;
}

interface GitCall {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeout: number;
  stdin?: string;
}

let calls: GitCall[] = [];

/**
 * Stand-in for git: answers `git config --null --includes --show-scope
 * --get-regexp <pattern>` with NUL-terminated scope and `key\nvalue` fields in
 * configuration order, keys with a lower-case variable name, exit 1 when none
 * match (git-config(1)), and the pinned `git credential <action>`.
 */
function installGit(fake: FakeGit): void {
  mockExecFile.mockImplementation((
    cmd: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; cwd?: string },
    cb: Function,
  ) => {
    expect(cmd).toBe('git');
    const call: GitCall = { args, env: options.env, cwd: options.cwd, timeout: options.timeout };
    calls.push(call);
    const finish = (result: GitResult) => {
      const exitCode = result.exitCode ?? 0;
      if (exitCode !== 0) {
        const error = Object.assign(new Error(`Command failed with exit code ${exitCode}`), { code: exitCode });
        cb(error, result.stdout ?? '', result.stderr ?? '');
      } else {
        cb(null, result.stdout ?? '', result.stderr ?? '');
      }
    };
    const child = {
      stdin: {
        on: jest.fn(),
        end: jest.fn((data: string) => {
          call.stdin = data;
          setImmediate(() => {
            if (args[0] === 'config') {
              if (fake.configExitCode !== undefined) {
                finish({ exitCode: fake.configExitCode, stderr: 'fatal: bad config' });
                return;
              }
              expect(args).toEqual([
                'config', '--null', '--includes', '--show-scope', '--get-regexp', '^credential\\.(.*\\.)?(helper|credentialstore)$',
              ]);
              const scopes = [['system', fake.system], ['global', fake.global], ['local', fake.local], ['command', fake.command]] as const;
              const entries = fake.entries ?? scopes.flatMap(([scope, values]) => Object.entries(values ?? {})
                .flatMap(([key, list]) => list.map((value) => [scope, key, value] as [string, string, string])));
              const lines = entries
                .map(([scope, key, value]) => [scope, key.replace(/\.credentialStore$/, '.credentialstore'), value] as const)
                .filter(([, key]) => /^credential\.(.*\.)?(helper|credentialstore)$/.test(key))
                .map(([scope, key, value]) => `${scope}\0${key}${value === null ? '' : `\n${value}`}\0`);
              finish(lines.length > 0 ? { stdout: lines.join('') } : { exitCode: 1 });
              return;
            }
            const action = args[args.length - 1];
            finish(fake.credential ? fake.credential(action, data) : { stdout: '' });
          });
        }),
      },
    };
    return child;
  });
}

function credentialCalls(): GitCall[] {
  return calls.filter((call) => call.args[0] === '-c');
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const SAVED_ENV = ['GCM_CREDENTIAL_STORE', 'WSLENV', 'GIT_DIR', 'GIT_WORK_TREE'] as const;
const originalEnv = Object.fromEntries(SAVED_ENV.map((name) => [name, process.env[name]]));

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
}

beforeEach(() => {
  jest.resetAllMocks();
  calls = [];
  for (const name of SAVED_ENV) {
    delete process.env[name];
  }
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  for (const name of SAVED_ENV) {
    if (originalEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[name];
    }
  }
});

describe('credentialHelperName (gitcredentials(7), CUSTOM HELPERS)', () => {
  it.each([
    ['osxkeychain', 'osxkeychain'],
    ['Manager', 'manager'],
    ['cache --timeout=300', 'cache'],
    ['store --file ~/.git-credentials', 'store'],
    ['/usr/lib/git-core/git-credential-libsecret', 'libsecret'],
    [WSL_GCM, 'manager'],
  ])('names %s as %s', (value, name) => {
    expect(credentialHelperName(value)).toBe(name);
  });

  it.each([
    ['a shell snippet', '!f() { echo password=x; }; f'],
    ['an indented shell snippet', '  !pass show git'],
    ['an empty value', ''],
    ['another absolute program', '/usr/local/bin/pass-git-helper'],
    ['a command list that also runs store', 'osxkeychain; git credential-store'],
    ['a pipeline', 'libsecret | tee f'],
    ['a redirection', 'osxkeychain > f'],
    ['an AND list', 'osxkeychain && store'],
    ['a comment', 'osxkeychain # x'],
    ['a glob', 'osxkeychain *'],
    ['a quoted absolute path, which git runs as git credential-"..."', '"/opt/Git Tools/git-credential-osxkeychain" --verbose'],
    ['a quoted Windows path', "'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-wincred.exe'"],
    ['a command substitution in backquotes', 'libsecret `cmd`'],
    ['a $(...) command substitution in an argument', '/usr/bin/git-credential-libsecret "$(cmd)"'],
    ['a second command after a line break', 'libsecret\ngit credential-store'],
    ['a carriage return', 'libsecret\rstore'],
    ['a single-quoted name', "'osxkeychain'"],
    ['a parameter expansion', '$HOME/bin/git-credential-osxkeychain'],
  ])('names no helper for %s', (_label, value) => {
    expect(credentialHelperName(value)).toBeNull();
  });

  it('accepts an absolute path whose spaces are escaped with backslashes', () => {
    expect(credentialHelperName('/opt/Git\\ Tools/git-credential-osxkeychain')).toBe('osxkeychain');
    expect(credentialHelperName('/usr/share/doc/git/contrib/credential/libsecret/git-credential-libsecret --verbose')).toBe('libsecret');
  });

  it('treats a drive-letter path as absolute only on Windows, as git\'s is_absolute_path does', () => {
    const value = 'C:/Program\\ Files/Git/mingw64/bin/git-credential-manager.exe';

    setPlatform('win32');
    expect(credentialHelperName(value)).toBe('manager');

    setPlatform('linux');
    expect(credentialHelperName(value)).toBeNull();
  });
});

describe('credentialUrlApplies (gitcredentials(7) CREDENTIAL CONTEXTS), verdicts of git 2.43', () => {
  it.each([
    [`https://${KEY_HOST}`, true],
    [`https://${KEY_HOST}/`, true],
    ['HTTPS://PROTON-DRIVE-CLI.INVALID', true],
    [`https://${KEY_HOST}:443`, true],
    [`https://${KEY_HOST}:0443`, true],
    [`https://${KEY_HOST}:`, true],
    [`https://${KEY_HOST}/.`, true],
    [`https://${KEY_HOST}/a/..`, true],
    [`https://${KEY_HOST}/%2e`, true],
    ['https://proton%2Ddrive-cli.invalid', true],
    [`https://${KEY_HOST}.`, true],
    ['https://*.invalid', true],
    ['https://*.*', true],
    ['https://', true],
    [KEY_HOST, true],
    [`https://${KEY_HOST}:8443`, false],
    [`https://${KEY_HOST}/path`, false],
    [`http://${KEY_HOST}`, false],
    ['https:', false],
    ['https://proton-*.invalid', false],
    [`https://${KEY_HOST}?x`, false],
    [`https://${KEY_HOST}#x`, false],
    [`https://${KEY_HOST}\\`, false],
    [`https://@${KEY_HOST}`, false],
    [`https://:pw@${KEY_HOST}`, false],
    ['https://proton-drive\tcli.invalid', false],
    ['https://ｐroton-drive-cli.invalid', false],
    ['https://other@github.com', false],
    [`https://UID123@${KEY_HOST}`, null],
    [`UID123@${KEY_HOST}`, null],
  ])('%s -> %s', (pattern, expected) => {
    expect(credentialUrlApplies(pattern, KEY_HOST)).toBe(expected);
  });
});

describe('selectCredentialHelper', () => {
  it('reads the credential settings with includes and scopes in one git config call, in the file-system root, outside any repository', async () => {
    process.env.GIT_DIR = '/repo/.git';
    process.env.GIT_WORK_TREE = '/repo';
    installGit({ global: { 'credential.helper': ['osxkeychain'] } });

    await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({ value: 'osxkeychain', env: {} });
    expect(calls.map((call) => call.args)).toEqual([
      ['config', '--null', '--includes', '--show-scope', '--get-regexp', '^credential\\.(.*\\.)?(helper|credentialstore)$'],
    ]);
    const [config] = calls;
    expect(config.cwd).toBe(path.parse(os.tmpdir()).root);
    expect(config.env).not.toHaveProperty('GIT_DIR');
    expect(config.env).not.toHaveProperty('GIT_WORK_TREE');
  });

  it('keeps the system helpers before the global ones', async () => {
    installGit({
      system: { 'credential.helper': ['libsecret'] },
      global: { 'credential.helper': ['osxkeychain'] },
    });

    await expect(selectCredentialHelper(KEY_HOST)).resolves.toMatchObject({ value: 'libsecret' });
  });

  it('ignores helpers of the local and command scopes', async () => {
    installGit({
      global: { 'credential.helper': ['store'] },
      local: { 'credential.helper': ['osxkeychain'] },
      command: { 'credential.helper': ['libsecret'] },
    });

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow('(configured: store)');
  });

  it('lets a global empty value reset a system helper', async () => {
    installGit({
      system: { 'credential.helper': ['libsecret'] },
      global: { 'credential.helper': [''] },
    });

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow('(configured: none)');
  });

  it('applies an empty value as a reset of the helper list, as git does', async () => {
    installGit({
      system: { 'credential.helper': ['libsecret'] },
      global: { 'credential.helper': ['', 'store', 'osxkeychain'] },
    });

    await expect(selectCredentialHelper(KEY_HOST)).resolves.toMatchObject({ value: 'osxkeychain' });
  });

  it('skips store and cache and returns the first helper that encrypts secrets at rest', async () => {
    installGit({
      global: { 'credential.helper': ['store', 'cache --timeout=300', '/usr/lib/git-core/git-credential-libsecret', 'osxkeychain'] },
    });

    await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({ value: '/usr/lib/git-core/git-credential-libsecret', env: {} });
  });

  it('skips a secure helper chained with store in one shell command', async () => {
    installGit({ global: { 'credential.helper': ['osxkeychain; git credential-store', 'libsecret'] } });

    await expect(selectCredentialHelper(KEY_HOST)).resolves.toMatchObject({ value: 'libsecret' });
  });

  it('rejects a configuration without a helper that encrypts secrets at rest and names what it found', async () => {
    installGit({ global: { 'credential.helper': ['store', 'cache --timeout=300', '!f() { :; }; f'] } });

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow(
      'git has no credential helper that encrypts secrets at rest ' +
        `(configured: store, cache, custom program). Set credential.helper, or credential.https://${KEY_HOST}.helper, to osxkeychain, wincred, libsecret or manager`,
    );
  });

  it('applies general and URL-specific helpers in configuration order, an empty value of either resetting the list', async () => {
    installGit({
      entries: [
        ['global', 'credential.helper', 'store'],
        ['global', `credential.https://${KEY_HOST}.helper`, ''],
        ['global', `credential.https://${KEY_HOST}.helper`, 'libsecret'],
      ],
    });
    await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({ value: 'libsecret', env: {} });

    installGit({
      entries: [
        ['global', `credential.https://${KEY_HOST}.helper`, 'osxkeychain'],
        ['global', 'credential.helper', ''],
        ['global', 'credential.helper', 'store'],
      ],
    });
    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow('(configured: store)');
  });

  it('ignores URL-specific helpers git does not apply to the credential host', async () => {
    installGit({
      entries: [
        ['global', 'credential.https://github.com.helper', 'osxkeychain'],
        ['global', `credential.https://${KEY_HOST}/path.helper`, 'osxkeychain'],
        ['global', `credential.http://${KEY_HOST}.helper`, 'osxkeychain'],
        ['global', `credential.https://${KEY_HOST}:8443.helper`, 'osxkeychain'],
        ['global', 'credential.https://proton-*.invalid.helper', 'osxkeychain'],
        ['global', 'credential.https://other@github.com.helper', 'osxkeychain'],
        ['global', 'credential.helper', 'cache'],
      ],
    });

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow('(configured: cache)');
  });

  it('refuses a URL-specific helper of the credential host that depends on the username', async () => {
    installGit({ entries: [['global', `credential.https://UID123@${KEY_HOST}.helper`, 'osxkeychain']] });

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow('depends on the credential username');
  });

  it('reports a helper key without a value, which git refuses as well', async () => {
    installGit({ entries: [['global', `credential.https://${KEY_HOST}.helper`, null]] });

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow(`git config credential.https://${KEY_HOST}.helper has no value`);
  });

  it('rejects a configuration without any helper', async () => {
    installGit({});

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow('(configured: none)');
  });

  it('reports a git config failure other than an unset key', async () => {
    installGit({ configExitCode: 128 });

    await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow('git config --get-regexp credential settings failed: fatal: bad config');
  });

  describe('Git Credential Manager store (GCM docs/credstores.md)', () => {
    it.each([
      ['linux', undefined, null],
      ['linux', 'secretservice', 'secretservice'],
      ['linux', 'SecretService', 'secretservice'],
      ['linux', 'gpg', 'gpg'],
      ['linux', 'plaintext', null],
      ['linux', 'cache', null],
      ['linux', 'none', null],
      ['darwin', undefined, 'keychain'],
      ['darwin', 'keychain', 'keychain'],
      ['darwin', 'gpg', 'gpg'],
      ['darwin', 'plaintext', null],
      ['win32', undefined, 'wincredman'],
      ['win32', 'wincredman', 'wincredman'],
      ['win32', 'dpapi', 'dpapi'],
      ['win32', 'cache', null],
    ] as const)('on %s with credential.credentialStore %s pins GCM_CREDENTIAL_STORE %s', async (platform, store, pinned) => {
      setPlatform(platform);
      installGit({
        global: {
          'credential.helper': ['manager'],
          ...(store ? { 'credential.credentialStore': [store] } : {}),
        },
      });

      if (pinned) {
        await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({ value: 'manager', env: { GCM_CREDENTIAL_STORE: pinned } });
      } else {
        await expect(selectCredentialHelper(KEY_HOST)).rejects.toThrow(
          `manager with credential store ${store ? store.toLowerCase() : 'default'}`,
        );
      }
    });

    it('takes GCM_CREDENTIAL_STORE over credential.credentialStore', async () => {
      setPlatform('linux');
      process.env.GCM_CREDENTIAL_STORE = 'secretservice';
      installGit({ global: { 'credential.helper': ['manager'], 'credential.credentialStore': ['plaintext'] } });

      await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({ value: 'manager', env: { GCM_CREDENTIAL_STORE: 'secretservice' } });
    });

    it('applies credential.credentialStore set for the credential host, in configuration order', async () => {
      setPlatform('linux');
      installGit({
        entries: [
          ['global', 'credential.credentialStore', 'plaintext'],
          ['global', `credential.https://${KEY_HOST}.helper`, 'manager'],
          ['global', `credential.https://${KEY_HOST}.credentialStore`, 'secretservice'],
          ['global', 'credential.https://github.com.credentialStore', 'plaintext'],
        ],
      });

      await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({ value: 'manager', env: { GCM_CREDENTIAL_STORE: 'secretservice' } });
    });

    it('uses the last credential.credentialStore value', async () => {
      setPlatform('linux');
      installGit({
        system: { 'credential.credentialStore': ['plaintext'] },
        global: { 'credential.helper': ['manager'], 'credential.credentialStore': ['secretservice'] },
      });

      await expect(selectCredentialHelper(KEY_HOST)).resolves.toMatchObject({ value: 'manager' });
    });

    it('applies the Windows stores to the GCM executable of Git for Windows called from WSL and names the pins in WSLENV', async () => {
      setPlatform('linux');
      installGit({ global: { 'credential.helper': [WSL_GCM] } });

      await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({
        value: WSL_GCM,
        env: { GCM_CREDENTIAL_STORE: 'wincredman', WSLENV: GCM_WSLENV },
      });
    });

    it('appends the GCM pins to an existing WSLENV', async () => {
      setPlatform('linux');
      process.env.WSLENV = 'USERPROFILE/pu';
      installGit({ global: { 'credential.helper': [WSL_GCM], 'credential.credentialStore': ['dpapi'] } });

      await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({
        value: WSL_GCM,
        env: { GCM_CREDENTIAL_STORE: 'dpapi', WSLENV: `USERPROFILE/pu:${GCM_WSLENV}` },
      });
    });

    it('sets no WSLENV for GCM on Windows itself', async () => {
      setPlatform('win32');
      installGit({ global: { 'credential.helper': ['C:/Program\\ Files/Git/mingw64/bin/git-credential-manager.exe'] } });

      await expect(selectCredentialHelper(KEY_HOST)).resolves.toMatchObject({ env: { GCM_CREDENTIAL_STORE: 'wincredman' } });
      expect((await selectCredentialHelper(KEY_HOST)).env).not.toHaveProperty('WSLENV');
    });

    it('falls through to the next secure helper when GCM uses an unencrypted store', async () => {
      setPlatform('linux');
      installGit({
        global: { 'credential.helper': ['manager', 'libsecret'], 'credential.credentialStore': ['plaintext'] },
      });

      await expect(selectCredentialHelper(KEY_HOST)).resolves.toEqual({ value: 'libsecret', env: {} });
    });
  });
});

describe('gitCredentialFill', () => {
  it('runs git credential fill with the selected helper as the only helper, every prompt disabled, outside any repository', async () => {
    process.env.GIT_DIR = '/repo/.git';
    installGit({
      global: { 'credential.helper': ['store', 'osxkeychain'] },
      credential: () => ({ stdout: `protocol=https\nhost=${KEY_HOST}\nusername=uid-123\npassword=secret123\n` }),
    });

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');

    expect(result).toEqual({ protocol: 'https', host: KEY_HOST, username: 'uid-123', password: 'secret123' });
    const [fill] = credentialCalls();
    expect(fill.args).toEqual(PINNED('osxkeychain', 'fill'));
    expect(fill.stdin).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n`);
    expect(fill.timeout).toBe(10_000);
    expect(fill.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'false',
      GCM_GUI_PROMPT: 'false',
      GCM_PROVIDER: 'generic',
    });
    expect(fill.env).not.toHaveProperty('GIT_DIR');
    expect(fill.env).not.toHaveProperty('GCM_CREDENTIAL_STORE');
    expect(fill.cwd).toBe(path.parse(os.tmpdir()).root);
    expect(fill.env.PATH).toBe(process.env.PATH);
  });

  it('pins the validated Git Credential Manager store and its WSLENV export for every credential call', async () => {
    setPlatform('linux');
    installGit({
      global: { 'credential.helper': [WSL_GCM] },
      credential: () => ({ stdout: 'password=secret\n' }),
    });

    await gitCredentialFill(KEY_HOST, 'uid-123');

    const [fill] = credentialCalls();
    expect(fill.args).toEqual(PINNED(WSL_GCM, 'fill'));
    expect(fill.env).toMatchObject({
      GCM_CREDENTIAL_STORE: 'wincredman',
      WSLENV: GCM_WSLENV,
      GCM_INTERACTIVE: 'false',
      GCM_GUI_PROMPT: 'false',
      GCM_PROVIDER: 'generic',
    });
  });

  it('passes a helper path with spaces as one -c argument', async () => {
    setPlatform('linux');
    installGit({
      global: { 'credential.helper': [WSL_GCM] },
      credential: () => ({ stdout: 'password=secret\n' }),
    });

    await gitCredentialFill(KEY_HOST, 'uid-123');

    expect(credentialCalls()[0].args).toEqual(PINNED(WSL_GCM, 'fill'));
  });

  it('runs no git credential command without a secure helper', async () => {
    installGit({ global: { 'credential.helper': ['store'] } });

    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).rejects.toThrow('(configured: store)');
    expect(credentialCalls()).toEqual([]);
  });

  it('keeps the requested username when the helper does not echo it', async () => {
    installGit({
      global: { 'credential.helper': ['osxkeychain'] },
      credential: () => ({ stdout: `protocol=https\nhost=${KEY_HOST}\npassword=secret\n` }),
    });

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');
    expect(result.username).toBe('uid-123');
    expect(result.password).toBe('secret');
  });

  it.each([
    ['no password attribute', `protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n`],
    ['empty output', ''],
  ])('rejects %s', async (_label, stdout) => {
    installGit({ global: { 'credential.helper': ['osxkeychain'] }, credential: () => ({ stdout }) });

    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).rejects.toThrow('git credential fill returned no entry for this session');
  });

  it('reports the stderr of a failing git credential fill', async () => {
    installGit({
      global: { 'credential.helper': ['osxkeychain'] },
      credential: () => ({ exitCode: 128, stderr: 'fatal: Cannot prompt because user interactivity has been disabled.' }),
    });

    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).rejects.toThrow(
      'git credential fill failed: fatal: Cannot prompt because user interactivity has been disabled.',
    );
  });

  it('keeps leading and trailing whitespace in values', async () => {
    installGit({ global: { 'credential.helper': ['osxkeychain'] }, credential: () => ({ stdout: 'password=  spaced out  \n' }) });

    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).resolves.toMatchObject({ password: '  spaced out  ' });
  });

  it('stops at the blank line that ends the attribute list', async () => {
    installGit({
      global: { 'credential.helper': ['osxkeychain'] },
      credential: () => ({ stdout: 'username=uid-123\npassword=secret\n\npassword=ignored\n' }),
    });

    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).resolves.toMatchObject({ password: 'secret' });
  });

  it('splits attributes at the first = and accepts CRLF line endings', async () => {
    installGit({
      global: { 'credential.helper': ['osxkeychain'] },
      credential: () => ({ stdout: 'protocol=https\r\nhost=h\r\npassword=pass=word=123\r\n' }),
    });

    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).resolves.toMatchObject({ password: 'pass=word=123' });
  });

  it.each([
    ['host', 'evil.example\nusername=x', 'uid-123'],
    ['username', KEY_HOST, 'user\r\npassword=injected'],
    ['username', KEY_HOST, 'nul\0byte'],
  ])('rejects %s values containing CR, LF or NUL before spawning git', async (_field, host, username) => {
    installGit({ global: { 'credential.helper': ['osxkeychain'] } });

    await expect(gitCredentialFill(host, username)).rejects.toThrow('must not contain CR, LF or NUL');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('gitCredentialApprove', () => {
  it('sends the credential to git credential approve through the pinned helper', async () => {
    installGit({ global: { 'credential.helper': ['libsecret'] } });

    await gitCredentialApprove({ protocol: 'https', host: KEY_HOST, username: 'uid-123', password: 'secret' });

    const [approve] = credentialCalls();
    expect(approve.args).toEqual(PINNED('libsecret', 'approve'));
    expect(approve.stdin).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\npassword=secret\n`);
  });

  it('rejects passwords containing newlines before spawning git', async () => {
    installGit({ global: { 'credential.helper': ['libsecret'] } });

    await expect(gitCredentialApprove({
      protocol: 'https',
      host: KEY_HOST,
      username: 'uid-123',
      password: 'line1\nline2',
    })).rejects.toThrow('git credential password must not contain CR, LF or NUL');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('reports a failing approve', async () => {
    installGit({ global: { 'credential.helper': ['libsecret'] }, credential: () => ({ exitCode: 1, stderr: 'no D-Bus session' }) });

    await expect(
      gitCredentialApprove({ protocol: 'https', host: KEY_HOST, username: 'uid-123', password: 'pass' }),
    ).rejects.toThrow('git credential approve failed: no D-Bus session');
  });
});

describe('gitCredentialReject', () => {
  it('erases the entries of the username without sending a password', async () => {
    installGit({ global: { 'credential.helper': ['wincred'] } });

    await gitCredentialReject(KEY_HOST, 'uid-123');

    const [reject] = credentialCalls();
    expect(reject.args).toEqual(PINNED('wincred', 'reject'));
    expect(reject.stdin).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n`);
  });
});

describe('GitCredentialStore', () => {
  it('resolves the password of the requested username at its host', async () => {
    installGit({
      global: { 'credential.helper': ['osxkeychain'] },
      credential: () => ({ stdout: `protocol=https\nhost=${KEY_HOST}\nusername=uid-123\npassword=s3cret\n` }),
    });

    await expect(new GitCredentialStore(KEY_HOST).resolve('uid-123')).resolves.toEqual({ username: 'uid-123', password: 's3cret' });
    expect(credentialCalls()[0].stdin).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n`);
  });

  it('checkWritable selects the helper from git config without running any credential command', async () => {
    installGit({ global: { 'credential.helper': ['osxkeychain'] } });

    await new GitCredentialStore(KEY_HOST).checkWritable();

    expect(calls.map((call) => call.args[0])).toEqual(['config']);
    expect(credentialCalls()).toHaveLength(0);
  });

  it('checkWritable rejects as store does without a helper that encrypts secrets at rest', async () => {
    installGit({ global: { 'credential.helper': ['store'] } });

    await expect(new GitCredentialStore(KEY_HOST).checkWritable()).rejects.toThrow('(configured: store)');
    expect(credentialCalls()).toHaveLength(0);
  });

  /** A helper keeping one item per username; `updates` false models one that keeps an existing item on approve. */
  function statefulHelper(options: { updates: boolean; failingFills?: number }) {
    const items = new Map<string, string>();
    let failingFills = options.failingFills ?? 0;
    return (action: string, stdin: string) => {
      const attributes = Object.fromEntries(stdin.split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s, 2)));
      if (action === 'approve' && (options.updates || !items.has(attributes.username))) {
        items.set(attributes.username, attributes.password);
      }
      if (action === 'reject') items.delete(attributes.username);
      if (action === 'fill') {
        if (failingFills > 0) {
          failingFills -= 1;
          return { exitCode: 128, stderr: 'fatal: could not read Password: terminal prompts disabled' };
        }
        return { stdout: items.has(attributes.username) ? `password=${items.get(attributes.username)}\n` : '' };
      }
      return { stdout: '' };
    };
  }

  const LINE = (password?: string) => `protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n${password === undefined ? '' : `password=${password}\n`}`;

  it('stores with approve and a fill read-back, without reject, when the helper updates the item; removes with reject', async () => {
    installGit({ global: { 'credential.helper': ['osxkeychain'] }, credential: statefulHelper({ updates: true }) });
    const store = new GitCredentialStore(KEY_HOST);

    await store.store('uid-123', 'first');
    await store.store('uid-123', 'second');
    await store.remove('uid-123');

    expect(credentialCalls().map((call) => [call.args.at(-1), call.stdin])).toEqual([
      ['approve', LINE('first')],
      ['fill', LINE()],
      ['approve', LINE('second')],
      ['fill', LINE()],
      ['reject', LINE()],
    ]);
  });

  it('runs reject and approve when the helper keeps the existing item on approve', async () => {
    installGit({ global: { 'credential.helper': ['osxkeychain'] }, credential: statefulHelper({ updates: false }) });
    const store = new GitCredentialStore(KEY_HOST);

    await store.store('uid-123', 'first');
    calls = [];
    await store.store('uid-123', 'second');

    expect(credentialCalls().map((call) => [call.args.at(-1), call.stdin])).toEqual([
      ['approve', LINE('second')],
      ['fill', LINE()],
      ['reject', LINE()],
      ['approve', LINE('second')],
    ]);
    await expect(store.resolve('uid-123')).resolves.toEqual({ username: 'uid-123', password: 'second' });
  });

  it('runs reject and approve when the read-back after approve fails', async () => {
    installGit({ global: { 'credential.helper': ['libsecret'] }, credential: statefulHelper({ updates: true, failingFills: 1 }) });
    const store = new GitCredentialStore(KEY_HOST);

    await store.store('uid-123', 'secret');

    expect(credentialCalls().map((call) => call.args.at(-1))).toEqual(['approve', 'fill', 'reject', 'approve']);
    await expect(store.resolve('uid-123')).resolves.toEqual({ username: 'uid-123', password: 'secret' });
  });

  it('rejects a host containing control characters at construction', () => {
    expect(() => new GitCredentialStore('bad\nhost')).toThrow('git credential host must not contain CR, LF or NUL');
  });

  it('requires a credential host', () => {
    expect(() => new GitCredentialStore('')).toThrow('requires a credential host');
  });
});
