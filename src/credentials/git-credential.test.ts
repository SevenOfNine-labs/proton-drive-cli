import {
  gitCredentialFill,
  gitCredentialApprove,
  gitCredentialReject,
  GitCredentialProvider,
} from './git-credential';
import * as childProcess from 'child_process';

jest.mock('child_process');

const mockExecFile = childProcess.execFile as unknown as jest.Mock;

function simulateExecFile(stdout: string, stderr = '', exitCode = 0) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    const child = {
      stdin: { on: jest.fn(), write: jest.fn(), end: jest.fn() },
    };
    if (exitCode !== 0) {
      const error = new Error(`exit code ${exitCode}`) as any;
      error.code = exitCode;
      cb(error, stdout, stderr);
    } else {
      cb(null, stdout, stderr);
    }
    return child;
  });
}

function simulateExecFileError(message: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    const child = {
      stdin: { on: jest.fn(), write: jest.fn(), end: jest.fn() },
    };
    cb(new Error(message), '', '');
    return child;
  });
}

const KEY_HOST = 'proton-drive-key.proton-lfs-cli.local';

function stdinOfCall(index: number): string {
  return mockExecFile.mock.results[index].value.stdin.write.mock.calls[0][0];
}

describe('gitCredentialFill', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('sends host and username and returns the stored password', async () => {
    simulateExecFile(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\npassword=secret123\n`);

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');
    expect(result).toEqual({
      protocol: 'https',
      host: KEY_HOST,
      username: 'uid-123',
      password: 'secret123',
    });
    expect(stdinOfCall(0)).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n`);
  });

  it('keeps the requested username when the helper does not echo it', async () => {
    simulateExecFile(`protocol=https\nhost=${KEY_HOST}\npassword=secret\n`);

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');
    expect(result.username).toBe('uid-123');
    expect(result.password).toBe('secret');
  });

  it('throws if password is missing', async () => {
    simulateExecFile(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n`);
    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).rejects.toThrow('did not return a password');
  });

  it('throws on empty output', async () => {
    simulateExecFile('');
    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).rejects.toThrow('did not return a password');
  });

  it('throws on exec error', async () => {
    simulateExecFileError('Command not found: git');
    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).rejects.toThrow('git credential fill failed');
  });

  it('throws on non-zero exit', async () => {
    simulateExecFile('', 'helper error', 1);
    await expect(gitCredentialFill(KEY_HOST, 'uid-123')).rejects.toThrow('git credential fill failed');
  });

  it('uses execFile with correct arguments and disables every prompt', async () => {
    simulateExecFile('protocol=https\nhost=h\nusername=uid-123\npassword=pass\n');

    await gitCredentialFill(KEY_HOST, 'uid-123');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'fill'],
      expect.objectContaining({
        timeout: 10_000,
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }),
      }),
      expect.any(Function),
    );
    const env = mockExecFile.mock.calls[0][2].env;
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('keeps leading and trailing whitespace in values', async () => {
    simulateExecFile('protocol=https\nhost=h\nusername=uid-123\npassword=  spaced out  \n');

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');
    expect(result.password).toBe('  spaced out  ');
  });

  it('stops at the blank line that ends the attribute list', async () => {
    simulateExecFile('protocol=https\nhost=h\nusername=uid-123\npassword=secret\n\npassword=ignored\n');

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');
    expect(result.password).toBe('secret');
  });

  it.each([
    ['host', 'evil.example\nusername=x', 'uid-123'],
    ['username', KEY_HOST, 'user\r\npassword=injected'],
    ['username', KEY_HOST, 'nul\0byte'],
  ])('rejects %s values containing CR, LF or NUL before spawning git', async (_field, host, username) => {
    simulateExecFile('protocol=https\nhost=h\nusername=uid-123\npassword=secret\n');

    await expect(gitCredentialFill(host, username)).rejects.toThrow('must not contain CR, LF or NUL');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('handles lines with = in the value', async () => {
    simulateExecFile('protocol=https\nhost=h\nusername=uid-123\npassword=pass=word=123\n');

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');
    expect(result.password).toBe('pass=word=123');
  });

  it('handles Windows-style line endings', async () => {
    simulateExecFile('protocol=https\r\nhost=h\r\nusername=uid-123\r\npassword=secret\r\n');

    const result = await gitCredentialFill(KEY_HOST, 'uid-123');
    expect(result.password).toBe('secret');
  });
});

describe('gitCredentialApprove', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('sends credentials to git credential approve', async () => {
    simulateExecFile('');

    await gitCredentialApprove({
      protocol: 'https',
      host: KEY_HOST,
      username: 'uid-123',
      password: 'secret',
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'approve'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(stdinOfCall(0)).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\npassword=secret\n`);
  });

  it('rejects passwords containing newlines before spawning git', async () => {
    simulateExecFile('');

    await expect(gitCredentialApprove({
      protocol: 'https',
      host: KEY_HOST,
      username: 'uid-123',
      password: 'line1\nline2',
    })).rejects.toThrow('git credential password must not contain CR, LF or NUL');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('throws on error', async () => {
    simulateExecFileError('failed');
    await expect(
      gitCredentialApprove({
        protocol: 'https',
        host: KEY_HOST,
        username: 'uid-123',
        password: 'pass',
      }),
    ).rejects.toThrow('git credential approve failed');
  });
});

describe('gitCredentialReject', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('sends credentials to git credential reject', async () => {
    simulateExecFile('');

    await gitCredentialReject({
      protocol: 'https',
      host: KEY_HOST,
      username: 'uid-123',
      password: '',
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'reject'],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe('GitCredentialProvider', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('resolves the password of the requested username at its host', async () => {
    simulateExecFile(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\npassword=s3cret\n`);

    const creds = await new GitCredentialProvider(KEY_HOST).resolve('uid-123');

    expect(creds).toEqual({ username: 'uid-123', password: 's3cret' });
    expect(stdinOfCall(0)).toContain(`host=${KEY_HOST}\n`);
    expect(stdinOfCall(0)).toContain('username=uid-123\n');
  });

  it('rejects when the helper has no entry', async () => {
    simulateExecFileError('terminal prompts disabled');

    await expect(new GitCredentialProvider(KEY_HOST).resolve('uid-123')).rejects.toThrow('git credential fill failed');
  });

  it('stores credentials via approve', async () => {
    simulateExecFile('');

    await new GitCredentialProvider(KEY_HOST).store('uid-123', 'password');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'approve'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(stdinOfCall(0)).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\npassword=password\n`);
  });

  it('removes credentials via reject', async () => {
    simulateExecFile('');

    await new GitCredentialProvider(KEY_HOST).remove('uid-123');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'reject'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(stdinOfCall(0)).toBe(`protocol=https\nhost=${KEY_HOST}\nusername=uid-123\n`);
  });

  it('rejects a host containing control characters at construction', () => {
    expect(() => new GitCredentialProvider('bad\nhost')).toThrow('git credential host must not contain CR, LF or NUL');
  });

  it('requires a credential host', () => {
    expect(() => new GitCredentialProvider('')).toThrow('requires a credential host');
  });
});
