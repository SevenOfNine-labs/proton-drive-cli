import { DriveCryptoService } from './drive-crypto';
import { UserApiClient } from '../api/user';

jest.mock('../api/user');

describe('DriveCryptoService', () => {
  let svc: DriveCryptoService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new DriveCryptoService();
  });

  describe('getPrimaryAddressId', () => {
    test('returns null when no address keys loaded', () => {
      expect(svc.getPrimaryAddressId()).toBeNull();
    });

    test('returns address with lowest Order value', () => {
      // Inject internal state to test ordering
      const internal = svc as any;
      const fakeEntry = { id: 'k', key: {} } as any;
      internal.addressKeyEntries.set('addr-2', [fakeEntry]);
      internal.addressKeyEntries.set('addr-1', [fakeEntry]);
      internal.addresses.set('addr-2', { ID: 'addr-2', Email: 'b@test.com', Order: 2, Keys: [] });
      internal.addresses.set('addr-1', { ID: 'addr-1', Email: 'a@test.com', Order: 1, Keys: [] });
      expect(svc.getPrimaryAddressId()).toBe('addr-1');
    });

    test('ignores addresses without decrypted keys', () => {
      const internal = svc as any;
      const fakeEntry = { id: 'k', key: {} } as any;
      // addr-1 has Order 1 but no decrypted keys
      internal.addresses.set('addr-1', { ID: 'addr-1', Email: 'a@test.com', Order: 1, Keys: [] });
      // addr-2 has Order 2 and has decrypted keys
      internal.addressKeyEntries.set('addr-2', [fakeEntry]);
      internal.addresses.set('addr-2', { ID: 'addr-2', Email: 'b@test.com', Order: 2, Keys: [] });
      expect(svc.getPrimaryAddressId()).toBe('addr-2');
    });
  });

  describe('getAddressKeyEntries', () => {
    test('returns an empty list for an unknown address', () => {
      expect(svc.getAddressKeyEntries('unknown')).toEqual([]);
    });
  });

  describe('getUserApi', () => {
    test('exposes the client created with the configured app version', () => {
      new DriveCryptoService('external-drive-test@1.2.3');
      expect(UserApiClient).toHaveBeenLastCalledWith(undefined, 'external-drive-test@1.2.3');
      expect(svc.getUserApi()).toBeInstanceOf(UserApiClient);
    });
  });

  describe('initialize', () => {
    test('throws when API calls fail (no real API)', async () => {
      (UserApiClient as jest.Mock).mockImplementation(() => ({
        getKeySalts: jest.fn().mockRejectedValue(new Error('No valid session')),
      }));
      await expect(new DriveCryptoService().initialize('password')).rejects.toThrow();
    });
  });
});
