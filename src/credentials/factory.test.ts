import { normalizeProviderName, createProvider } from './factory';
import { GitCredentialProvider } from './git-credential';
import { PassCliProvider } from './pass-cli';

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

  it.each(['unknown', 'stdin', 'interactive'])('throws on unknown provider %s', (name) => {
    expect(() => normalizeProviderName(name)).toThrow(`Unknown credential provider: ${name}`);
  });
});

describe('createProvider', () => {
  it('creates GitCredentialProvider', () => {
    const provider = createProvider('git-credential', 'custom.host');
    expect(provider).toBeInstanceOf(GitCredentialProvider);
    expect(provider.name).toBe('git-credential');
  });

  it('creates PassCliProvider', () => {
    const provider = createProvider('pass-cli', 'custom.host');
    expect(provider).toBeInstanceOf(PassCliProvider);
    expect(provider.name).toBe('pass-cli');
  });

  it.each(['git-credential', 'pass-cli'] as const)('requires a credential host for %s', (name) => {
    expect(() => createProvider(name, ' ')).toThrow('requires a credential host');
  });
});
