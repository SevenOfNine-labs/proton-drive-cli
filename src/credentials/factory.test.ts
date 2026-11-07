import { normalizeCredentialStoreName, createCredentialStore } from './factory';
import { GitCredentialStore } from './git-credential';
import { PassCliStore } from './pass-cli';

describe('normalizeCredentialStoreName', () => {
  it.each([
    ['git', 'git-credential'],
    ['git-credential', 'git-credential'],
    ['pass', 'pass-cli'],
    ['pass-cli', 'pass-cli'],
    ['  GIT  ', 'git-credential'],
    ['PASS-CLI', 'pass-cli'],
  ])('normalizes %j to %s', (name, expected) => {
    expect(normalizeCredentialStoreName(name)).toBe(expected);
  });

  it.each(['unknown', 'stdin', 'interactive', 'keychain'])('throws on unknown store %s', (name) => {
    expect(() => normalizeCredentialStoreName(name)).toThrow(`Unknown credential store: ${name}`);
  });
});

describe('createCredentialStore', () => {
  it('creates GitCredentialStore', () => {
    const store = createCredentialStore('git-credential', 'custom.host');
    expect(store).toBeInstanceOf(GitCredentialStore);
    expect(store.name).toBe('git-credential');
  });

  it('creates PassCliStore', () => {
    const store = createCredentialStore('pass-cli', 'custom.host');
    expect(store).toBeInstanceOf(PassCliStore);
    expect(store.name).toBe('pass-cli');
  });

  it.each(['git-credential', 'pass-cli'] as const)('requires a credential host for %s', (name) => {
    expect(() => createCredentialStore(name, ' ')).toThrow('requires a credential host');
  });
});
