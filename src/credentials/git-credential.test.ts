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

// ─── Standalone function tests ─────────────────────────────────────

describe('gitCredentialFill', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('parses valid credential output', async () => {
    simulateExecFile(
      'protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=secret123\n',
    );

    const result = await gitCredentialFill();
    expect(result).toEqual({
      protocol: 'https',
      host: 'proton.me',
      username: 'user@proton.me',
      password: 'secret123',
    });
  });

  it('uses custom host', async () => {
    simulateExecFile(
      'protocol=https\nhost=custom.host\nusername=user@example.com\npassword=pass\n',
    );

    const result = await gitCredentialFill('custom.host');
    expect(result.host).toBe('custom.host');

    const stdinWrite = mockExecFile.mock.results[0]?.value?.stdin?.write;
    if (stdinWrite) {
      const input = stdinWrite.mock.calls[0][0];
      expect(input).toContain('host=custom.host');
    }
  });

  it('uses supplied username for UID-scoped credential lookup', async () => {
    simulateExecFile('protocol=https\nhost=custom.host\npassword=secret\n');

    const result = await gitCredentialFill('custom.host', 'uid-123');

    expect(result).toEqual({
      protocol: 'https',
      host: 'custom.host',
      username: 'uid-123',
      password: 'secret',
    });

    const stdinWrite = mockExecFile.mock.results[0]?.value?.stdin?.write;
    if (stdinWrite) {
      const input = stdinWrite.mock.calls[0][0];
      expect(input).toContain('host=custom.host');
      expect(input).toContain('username=uid-123');
    }
  });

  it('throws if username is missing', async () => {
    simulateExecFile('protocol=https\nhost=proton.me\npassword=secret\n');
    await expect(gitCredentialFill()).rejects.toThrow('did not return username and password');
  });

  it('throws if password is missing', async () => {
    simulateExecFile('protocol=https\nhost=proton.me\nusername=user@proton.me\n');
    await expect(gitCredentialFill()).rejects.toThrow('did not return username and password');
  });

  it('throws on empty output', async () => {
    simulateExecFile('');
    await expect(gitCredentialFill()).rejects.toThrow('did not return username and password');
  });

  it('throws on exec error', async () => {
    simulateExecFileError('Command not found: git');
    await expect(gitCredentialFill()).rejects.toThrow('git credential fill failed');
  });

  it('throws on non-zero exit', async () => {
    simulateExecFile('', 'helper error', 1);
    await expect(gitCredentialFill()).rejects.toThrow('git credential fill failed');
  });

  it('uses execFile with correct arguments and disables every prompt', async () => {
    simulateExecFile(
      'protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=pass\n',
    );

    await gitCredentialFill();

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
    simulateExecFile('protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=  spaced out  \n');

    const result = await gitCredentialFill();
    expect(result.password).toBe('  spaced out  ');
  });

  it('stops at the blank line that ends the attribute list', async () => {
    simulateExecFile('protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=secret\n\npassword=ignored\n');

    const result = await gitCredentialFill();
    expect(result.password).toBe('secret');
  });

  it.each([
    ['host', 'evil.example\nusername=x', undefined],
    ['username', undefined, 'user\r\npassword=injected'],
    ['username', undefined, 'nul\0byte'],
  ])('rejects %s values containing CR, LF or NUL before spawning git', async (_field, host, username) => {
    simulateExecFile('protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=secret\n');

    await expect(gitCredentialFill(host, username)).rejects.toThrow('must not contain CR, LF or NUL');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('handles lines with = in the value', async () => {
    simulateExecFile(
      'protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=pass=word=123\n',
    );

    const result = await gitCredentialFill();
    expect(result.password).toBe('pass=word=123');
  });

  it('handles Windows-style line endings', async () => {
    simulateExecFile(
      'protocol=https\r\nhost=proton.me\r\nusername=user@proton.me\r\npassword=secret\r\n',
    );

    const result = await gitCredentialFill();
    expect(result.username).toBe('user@proton.me');
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
      host: 'proton.me',
      username: 'user@proton.me',
      password: 'secret',
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'approve'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('rejects passwords containing newlines before spawning git', async () => {
    simulateExecFile('');

    await expect(gitCredentialApprove({
      protocol: 'https',
      host: 'proton.me',
      username: 'user',
      password: 'line1\nline2',
    })).rejects.toThrow('git credential password must not contain CR, LF or NUL');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('throws on error', async () => {
    simulateExecFileError('failed');
    await expect(
      gitCredentialApprove({
        protocol: 'https',
        host: 'proton.me',
        username: 'user',
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
      host: 'proton.me',
      username: 'user@proton.me',
      password: 'wrong-pass',
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'reject'],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

// ─── Class-based provider tests ────────────────────────────────────

describe('GitCredentialProvider', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('resolves credentials via fill', async () => {
    simulateExecFile(
      'protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=s3cret\n',
    );

    const provider = new GitCredentialProvider();
    const creds = await provider.resolve();

    expect(creds).toEqual({
      username: 'user@proton.me',
      password: 's3cret',
    });
  });

  it('prefers username from options over fill result', async () => {
    simulateExecFile(
      'protocol=https\nhost=proton.me\nusername=fill@proton.me\npassword=pass\n',
    );

    const provider = new GitCredentialProvider();
    const creds = await provider.resolve({ username: 'override@proton.me' });

    expect(creds.username).toBe('override@proton.me');
  });

  it('passes username options through to git credential fill', async () => {
    simulateExecFile('protocol=https\nhost=custom.host\npassword=pass\n');

    const provider = new GitCredentialProvider('custom.host');
    const creds = await provider.resolve({ username: 'uid-123' });

    expect(creds).toEqual({ username: 'uid-123', password: 'pass' });
    const stdinWrite = mockExecFile.mock.results[0]?.value?.stdin?.write;
    if (stdinWrite) {
      const input = stdinWrite.mock.calls[0][0];
      expect(input).toContain('host=custom.host');
      expect(input).toContain('username=uid-123');
    }
  });

  it('isAvailable returns true when fill succeeds', async () => {
    simulateExecFile(
      'protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=pass\n',
    );

    const provider = new GitCredentialProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when fill fails', async () => {
    simulateExecFileError('no helper configured');

    const provider = new GitCredentialProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('stores credentials via approve', async () => {
    simulateExecFile('');

    const provider = new GitCredentialProvider();
    await provider.store('user@proton.me', 'password');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'approve'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('removes credentials via reject', async () => {
    simulateExecFile('');

    const provider = new GitCredentialProvider();
    await provider.remove('user@proton.me');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'reject'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('rejects a host containing control characters at construction', () => {
    expect(() => new GitCredentialProvider('bad\nhost')).toThrow('git credential host must not contain CR, LF or NUL');
  });

  it('uses custom host', async () => {
    simulateExecFile(
      'protocol=https\nhost=custom.host\nusername=user\npassword=pass\n',
    );

    const provider = new GitCredentialProvider('custom.host');
    await provider.resolve();

    const stdinWrite = mockExecFile.mock.results[0]?.value?.stdin?.write;
    if (stdinWrite) {
      const input = stdinWrite.mock.calls[0][0];
      expect(input).toContain('host=custom.host');
    }
  });
});
