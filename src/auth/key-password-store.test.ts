import {
  createKeyPasswordStore,
  normalizeKeyPasswordProvider,
} from './key-password-store';
import { PROTON_KEY_PASSWORD_CREDENTIAL_HOST } from '../constants';
import { createProvider } from '../credentials';

const mockProvider = {
  name: 'git-credential' as const,
  isAvailable: jest.fn(),
  resolve: jest.fn(),
  store: jest.fn(),
  remove: jest.fn(),
};

jest.mock('../credentials', () => ({
  createProvider: jest.fn(() => mockProvider),
  normalizeProviderName: jest.fn((provider?: string) => provider || 'git-credential'),
}));

const mockCreateProvider = createProvider as jest.MockedFunction<typeof createProvider>;

describe('key-password-store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProvider.resolve.mockResolvedValue({ username: 'uid-123', password: 'stored-key-password' });
    mockProvider.store.mockResolvedValue(undefined);
    mockProvider.remove.mockResolvedValue(undefined);
  });

  it('defaults to git-credential and the browser-fork key-password host', async () => {
    const store = createKeyPasswordStore();

    await store.store('uid-123', 'key-password');

    expect(store.provider).toBe('git-credential');
    expect(store.host).toBe(PROTON_KEY_PASSWORD_CREDENTIAL_HOST);
    expect(mockCreateProvider).toHaveBeenCalledWith('git-credential', {
      host: PROTON_KEY_PASSWORD_CREDENTIAL_HOST,
    });
    expect(mockProvider.store).toHaveBeenCalledWith('uid-123', 'key-password');
  });

  it('loads key passwords by UID-scoped username', async () => {
    const store = createKeyPasswordStore({
      provider: 'pass-cli',
      host: 'custom-key-host.local',
    });

    await expect(store.load('uid-123')).resolves.toBe('stored-key-password');

    expect(mockCreateProvider).toHaveBeenCalledWith('pass-cli', {
      host: 'custom-key-host.local',
    });
    expect(mockProvider.resolve).toHaveBeenCalledWith({ username: 'uid-123' });
  });

  it('returns undefined when loading fails', async () => {
    mockProvider.resolve.mockRejectedValueOnce(new Error('missing secret'));

    const store = createKeyPasswordStore();

    await expect(store.load('uid-123')).resolves.toBeUndefined();
  });

  it('verifies by checking whether a UID-scoped key password can be loaded', async () => {
    const store = createKeyPasswordStore();

    await expect(store.verify('uid-123')).resolves.toBe(true);

    mockProvider.resolve.mockResolvedValueOnce({ username: 'uid-123', password: '' });
    await expect(store.verify('uid-123')).resolves.toBe(false);
  });

  it('removes UID-scoped key password entries', async () => {
    const store = createKeyPasswordStore({ provider: 'pass-cli' });

    await store.remove('uid-123');

    expect(mockProvider.remove).toHaveBeenCalledWith('uid-123');
  });

  it('rejects unsupported providers', () => {
    expect(() => normalizeKeyPasswordProvider('stdin')).toThrow(
      'Unsupported key password provider: stdin',
    );
  });

  it('rejects empty UIDs and empty key passwords', async () => {
    const store = createKeyPasswordStore();

    await expect(store.load('')).rejects.toThrow('UID is required');
    await expect(store.store('uid-123', '')).rejects.toThrow('Cannot store an empty key password');
  });
});
