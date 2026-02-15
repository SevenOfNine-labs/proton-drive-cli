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
      stdin: { write: jest.fn(), end: jest.fn() },
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
      stdin: { write: jest.fn(), end: jest.fn() },
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

  it('uses execFile with correct arguments', async () => {
    simulateExecFile(
      'protocol=https\nhost=proton.me\nusername=user@proton.me\npassword=pass\n',
    );

    await gitCredentialFill();

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['credential', 'fill'],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
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
