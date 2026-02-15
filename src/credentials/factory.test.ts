import { normalizeProviderName, createProvider, resolvePassword } from './factory';
import { GitCredentialProvider } from './git-credential';
import { PassCliProvider } from './pass-cli';
import { StdinProvider } from './stdin';
import { InteractiveProvider } from './interactive';

// Mock git-credential module
jest.mock('./git-credential', () => {
  const actual = jest.requireActual('./git-credential');
  return {
    ...actual,
    gitCredentialFill: jest.fn(),
  };
});

import { gitCredentialFill } from './git-credential';
const mockedGitCredentialFill = gitCredentialFill as jest.MockedFunction<typeof gitCredentialFill>;

describe('normalizeProviderName', () => {
  it('normalizes "git" to "git-credential"', () => {
    expect(normalizeProviderName('git')).toBe('git-credential');
  });

  it('normalizes "git-credential" to "git-credential"', () => {
    expect(normalizeProviderName('git-credential')).toBe('git-credential');
  });

  it('normalizes "pass" to "pass-cli"', () => {
    expect(normalizeProviderName('pass')).toBe('pass-cli');
  });

  it('normalizes "pass-cli" to "pass-cli"', () => {
    expect(normalizeProviderName('pass-cli')).toBe('pass-cli');
  });

  it('normalizes with whitespace and case', () => {
    expect(normalizeProviderName('  GIT  ')).toBe('git-credential');
    expect(normalizeProviderName('PASS-CLI')).toBe('pass-cli');
  });

  it('throws on unknown provider', () => {
    expect(() => normalizeProviderName('unknown')).toThrow('Unknown credential provider: unknown');
  });
});

describe('createProvider', () => {
  it('creates GitCredentialProvider', () => {
    const provider = createProvider('git-credential');
    expect(provider).toBeInstanceOf(GitCredentialProvider);
    expect(provider.name).toBe('git-credential');
  });

  it('creates PassCliProvider', () => {
    const provider = createProvider('pass-cli');
    expect(provider).toBeInstanceOf(PassCliProvider);
    expect(provider.name).toBe('pass-cli');
  });

  it('creates StdinProvider', () => {
    const provider = createProvider('stdin');
    expect(provider).toBeInstanceOf(StdinProvider);
    expect(provider.name).toBe('stdin');
  });

  it('creates InteractiveProvider', () => {
    const provider = createProvider('interactive');
    expect(provider).toBeInstanceOf(InteractiveProvider);
    expect(provider.name).toBe('interactive');
  });

  it('passes host option to GitCredentialProvider', () => {
    const provider = createProvider('git-credential', { host: 'custom.host' });
    expect(provider).toBeInstanceOf(GitCredentialProvider);
  });
});

describe('resolvePassword', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockedGitCredentialFill.mockReset();
  });

  it('resolves password via git credential provider', async () => {
    mockedGitCredentialFill.mockResolvedValue({
      protocol: 'https',
      host: 'proton.me',
      username: 'user@proton.me',
      password: 'git-pass',
    });

    const result = await resolvePassword({ credentialProvider: 'git' });
    expect(result).toBe('git-pass');
    expect(mockedGitCredentialFill).toHaveBeenCalledTimes(1);
  });

  it('propagates git credential errors', async () => {
    mockedGitCredentialFill.mockRejectedValue(new Error('git credential fill failed'));

    await expect(resolvePassword({ credentialProvider: 'git' }))
      .rejects.toThrow('git credential fill failed');
  });

  it('throws descriptive error when no method available', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    await expect(resolvePassword({})).rejects.toThrow(
      /Password required for key decryption/,
    );

    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });
});
