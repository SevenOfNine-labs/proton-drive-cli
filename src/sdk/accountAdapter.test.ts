import * as openpgp from 'openpgp';
import { AccountAdapter } from './accountAdapter';
import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';
import { DriveCryptoService } from '../crypto/drive-crypto';
import type { Address } from '../types/crypto';
import { keyCreationDate } from '../test/openpgp-keys';

async function generateDecryptedKey(name: string): Promise<openpgp.PrivateKey> {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ name, email: `${name}@example.test` }],
    format: 'object',
    date: keyCreationDate(),
  });
  return privateKey;
}

describe('AccountAdapter', () => {
  let ownKey: openpgp.PrivateKey;
  let foreignKey: openpgp.PrivateKey;
  let getAddressPublicKeys: jest.Mock;
  let mockDriveCrypto: jest.Mocked<DriveCryptoService>;
  let adapter: AccountAdapter;

  const address: Address = {
    ID: 'addr-1',
    Email: 'test@proton.me',
    Status: 1,
    Type: 1,
    Order: 1,
    Priority: 1,
    Keys: [{ ID: 'key-1', Version: 4, Primary: 1, Flags: 3, PrivateKey: '', Token: null, Signature: null, Activation: null }],
  };

  beforeAll(async () => {
    ownKey = await generateDecryptedKey('own');
    foreignKey = await generateDecryptedKey('foreign');
  });

  beforeEach(() => {
    getAddressPublicKeys = jest.fn();
    mockDriveCrypto = {
      getPrimaryAddressId: jest.fn().mockReturnValue('addr-1'),
      getAddressesMap: jest.fn().mockReturnValue(new Map([['addr-1', address]])),
      getAddressKeyEntries: jest.fn().mockImplementation((id: string) =>
        id === 'addr-1' ? [{ id: 'key-1', key: ownKey }] : []),
      getUserApi: jest.fn().mockReturnValue({ getAddressPublicKeys }),
    } as unknown as jest.Mocked<DriveCryptoService>;

    adapter = new AccountAdapter(mockDriveCrypto, new ProtonOpenPGPCryptoProxy());
  });

  describe('getOwnPrimaryAddress', () => {
    it('returns the primary address with key references usable by the crypto endpoint', async () => {
      const addr = await adapter.getOwnPrimaryAddress();
      expect(addr.email).toBe('test@proton.me');
      expect(addr.addressId).toBe('addr-1');
      expect(addr.primaryKeyIndex).toBe(0);
      expect(addr.keys).toHaveLength(1);
      expect(addr.keys[0].id).toBe('key-1');
      expect(addr.keys[0].key.isPrivate()).toBe(true);
      expect(addr.keys[0].key.getFingerprint()).toBe(ownKey.getFingerprint());
    });

    it('imports each key once', async () => {
      const first = await adapter.getOwnPrimaryAddress();
      const second = await adapter.getOwnAddresses();
      expect(second[0].keys[0].key).toBe(first.keys[0].key);
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
        ...address,
        Keys: [
          address.Keys[0],
          { ...address.Keys[0], ID: 'key-2', Primary: 0 },
        ],
      }]]));
      mockDriveCrypto.getAddressKeyEntries.mockReturnValue([{ id: 'key-2', key: ownKey }]);

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

  describe('getPublicKeys', () => {
    it('returns the public keys of an own address without calling the API', async () => {
      const keys = await adapter.getPublicKeys('Test@Proton.me');

      expect(keys).toHaveLength(1);
      expect(keys[0].isPrivate()).toBe(false);
      expect(keys[0].getFingerprint()).toBe(ownKey.getFingerprint());
      expect(getAddressPublicKeys).not.toHaveBeenCalled();
      expect(await adapter.hasProtonAccount('test@proton.me')).toBe(true);
    });

    it('fetches and caches the keys Proton publishes for another address', async () => {
      getAddressPublicKeys.mockResolvedValue({ Keys: [{ PublicKey: foreignKey.toPublic().armor(), Flags: 3 }] });

      const keys = await adapter.getPublicKeys('other@proton.me');
      expect(keys).toHaveLength(1);
      expect(keys[0].getFingerprint()).toBe(foreignKey.getFingerprint());
      expect(getAddressPublicKeys).toHaveBeenCalledWith('other@proton.me');

      await adapter.getPublicKeys('Other@proton.me');
      expect(getAddressPublicKeys).toHaveBeenCalledTimes(1);

      await adapter.getPublicKeys('other@proton.me', true);
      expect(getAddressPublicKeys).toHaveBeenCalledTimes(2);
    });

    it('returns no keys for an address without Proton account', async () => {
      getAddressPublicKeys.mockResolvedValue(null);

      expect(await adapter.getPublicKeys('nobody@example.com')).toEqual([]);
      expect(await adapter.hasProtonAccount('nobody@example.com')).toBe(false);
    });

    it('propagates lookup failures and retries on the next call', async () => {
      getAddressPublicKeys
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ Keys: [] });

      await expect(adapter.getPublicKeys('other@proton.me')).rejects.toThrow('network down');
      expect(await adapter.getPublicKeys('other@proton.me')).toEqual([]);
      expect(getAddressPublicKeys).toHaveBeenCalledTimes(2);
    });
  });
});
