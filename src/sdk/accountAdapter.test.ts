import { AccountAdapter } from './accountAdapter';
import { DriveCryptoService } from '../crypto/drive-crypto';

// Mock the UserApiClient (used internally by AccountAdapter)
jest.mock('../api/user', () => ({
  UserApiClient: jest.fn().mockImplementation(() => ({})),
}));

describe('AccountAdapter', () => {
  let mockDriveCrypto: jest.Mocked<DriveCryptoService>;
  let adapter: AccountAdapter;

  const fakeKey = { _idx: 'key1', _dummyType: 'private' as const, toPublic: () => ({}) };
  const fakeAddress = {
    ID: 'addr-1',
    Email: 'test@proton.me',
    Status: 1,
    Type: 1,
    Order: 1,
    Priority: 1,
    Keys: [{ ID: 'key-1', Version: 4, Primary: 1, Flags: 3, PrivateKey: '', Token: null, Signature: null, Activation: null }],
  };

  beforeEach(() => {
    mockDriveCrypto = {
      getPrimaryAddressId: jest.fn().mockReturnValue('addr-1'),
      getPrimaryAddressEmail: jest.fn().mockReturnValue('test@proton.me'),
      getAddressesMap: jest.fn().mockReturnValue(new Map([['addr-1', fakeAddress]])),
      getAddressKeysMap: jest.fn().mockReturnValue(new Map([['addr-1', [fakeKey]]])),
      getAddressKeyEntries: jest.fn().mockImplementation((id: string) =>
        id === 'addr-1' ? [{ id: 'key-1', key: fakeKey }] : []),
    } as unknown as jest.Mocked<DriveCryptoService>;

    adapter = new AccountAdapter(mockDriveCrypto);
  });

  describe('getOwnPrimaryAddress', () => {
    it('returns the primary address with correct shape', async () => {
      const addr = await adapter.getOwnPrimaryAddress();
      expect(addr.email).toBe('test@proton.me');
      expect(addr.addressId).toBe('addr-1');
      expect(addr.primaryKeyIndex).toBe(0);
      expect(addr.keys).toHaveLength(1);
      expect(addr.keys[0].id).toBe('key-1');
    });

    it('throws when no primary address', async () => {
      mockDriveCrypto.getPrimaryAddressId.mockReturnValue(null);
      await expect(adapter.getOwnPrimaryAddress()).rejects.toThrow('No primary address found');
    });
  });

  describe('getOwnAddresses', () => {
    it('returns all addresses with decrypted keys', async () => {
      const addresses = await adapter.getOwnAddresses();
      expect(addresses).toHaveLength(1);
      expect(addresses[0].email).toBe('test@proton.me');
    });

    it('throws when no addresses have keys', async () => {
      mockDriveCrypto.getAddressKeyEntries.mockReturnValue([]);
      await expect(adapter.getOwnAddresses()).rejects.toThrow('No addresses with decrypted keys');
    });

    it('reports the ID of the key that actually unlocked, not the positional one', async () => {
      // address.Keys lists key-1 first, but key-1 could not be unlocked.
      mockDriveCrypto.getAddressesMap.mockReturnValue(new Map([['addr-1', {
        ...fakeAddress,
        Keys: [
          fakeAddress.Keys[0],
          { ...fakeAddress.Keys[0], ID: 'key-2', Primary: 0 },
        ],
      }]]));
      mockDriveCrypto.getAddressKeyEntries.mockReturnValue([{ id: 'key-2', key: fakeKey as any }]);

      const [addr] = await adapter.getOwnAddresses();
      expect(addr.keys.map((k) => k.id)).toEqual(['key-2']);
      expect((await adapter.getOwnPrimaryAddress()).keys[0].id).toBe('key-2');
    });
  });

  describe('getOwnAddress', () => {
    it('finds address by ID', async () => {
      const addr = await adapter.getOwnAddress('addr-1');
      expect(addr.email).toBe('test@proton.me');
    });

    it('finds address by email', async () => {
      const addr = await adapter.getOwnAddress('test@proton.me');
      expect(addr.email).toBe('test@proton.me');
    });

    it('finds address by email case-insensitively', async () => {
      const addr = await adapter.getOwnAddress('TEST@PROTON.ME');
      expect(addr.email).toBe('test@proton.me');
    });

    it('throws for unknown address', async () => {
      await expect(adapter.getOwnAddress('unknown@example.com')).rejects.toThrow('No address found');
    });
  });

  describe('hasProtonAccount', () => {
    it('returns false (not supported in bridge)', async () => {
      expect(await adapter.hasProtonAccount('user@proton.me')).toBe(false);
    });
  });

  describe('getPublicKeys', () => {
    it('returns empty array (not supported in bridge)', async () => {
      expect(await adapter.getPublicKeys('user@proton.me')).toEqual([]);
    });
  });
});
