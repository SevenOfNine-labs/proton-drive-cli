import './polyfill';
import * as openpgp from 'openpgp';
import { CryptoService } from './index';
import { UserApiClient } from '../api/user';
import { AppError, ErrorCode } from '../errors/types';
import { User, Address } from '../types/crypto';
import { logger } from '../utils/logger';

/** A decrypted address key paired with its Proton key ID. */
export interface AddressKeyEntry {
  id: string;
  key: openpgp.PrivateKey;
}

/**
 * Unlocks the Proton account key hierarchy with the browser-fork key
 * password and hands the decrypted address keys to the SDK account adapter.
 *
 * Follows the official account module (addresses.ts Addresses.getUserData
 * and getAddressKey): every user key is unlocked with the key password; an
 * address key with a Token is unlocked with that token, decrypted with the
 * user keys and required to carry a valid user-key signature; an address key
 * without a Token is unlocked with the key password.
 */
export class DriveCryptoService {
  private crypto: CryptoService;
  private userApi: UserApiClient;
  private userKeys: Map<string, openpgp.PrivateKey> = new Map();
  private addressKeyEntries: Map<string, AddressKeyEntry[]> = new Map();
  private addresses: Map<string, Address> = new Map();

  constructor(appVersion?: string) {
    this.crypto = new CryptoService();
    this.userApi = new UserApiClient(undefined, appVersion);
  }

  /**
   * Unlock the user and address keys with the browser-fork key password.
   * The user and address records come from the crypto-init cache when it
   * belongs to the current session.
   *
   * @throws AppError CREDENTIALS_UNAVAILABLE when the key password unlocks no user key
   */
  async initialize(keyPassword: string): Promise<void> {
    if (!keyPassword) {
      throw new Error('Key password is required');
    }
    this.userKeys.clear();
    this.addressKeyEntries.clear();
    this.addresses.clear();

    const user: User = await this.userApi.getUser();
    logger.debug(`Decrypting user keys for: ${user.Name}`);
    for (const key of user.Keys) {
      try {
        this.userKeys.set(key.ID, await this.decryptPrivateKeyWithPassphrase(key.PrivateKey, keyPassword));
      } catch (error) {
        logger.warn(`Failed to decrypt user key ${key.ID}: ${error}`);
      }
    }
    if (this.userKeys.size === 0) {
      throw new AppError(
        'The stored key password unlocks no user key. Run: proton-drive-cli login',
        ErrorCode.CREDENTIALS_UNAVAILABLE,
        {},
        false,
      );
    }

    const addresses = await this.userApi.getAddresses();
    this.userApi.saveCryptoCache(user, addresses).catch(() => {});

    const userKeys = Array.from(this.userKeys.values());
    for (const address of addresses) {
      const decryptedEntries: AddressKeyEntry[] = [];
      for (const key of address.Keys) {
        try {
          const passphrase = key.Token
            ? await this.crypto.decryptAddressKeyToken(key.Token, key.Signature, userKeys)
            : keyPassword;
          const decryptedKey = await this.decryptPrivateKeyWithPassphrase(key.PrivateKey, passphrase);
          decryptedEntries.push({ id: key.ID, key: decryptedKey });
        } catch (error) {
          logger.warn(`Failed to decrypt address key ${key.ID}: ${error}`);
        }
      }

      if (decryptedEntries.length > 0) {
        this.addressKeyEntries.set(address.ID, decryptedEntries);
        this.addresses.set(address.ID, address);
      }
    }

    logger.debug(`Decrypted ${this.userKeys.size} user key(s) and ${this.addressKeyEntries.size} address key(s)`);
  }

  /**
   * Decrypt a private key with a passphrase
   */
  private async decryptPrivateKeyWithPassphrase(
    armoredKey: string,
    passphrase: string
  ): Promise<openpgp.PrivateKey> {
    const privateKey = await openpgp.readPrivateKey({ armoredKey });
    const decryptedKey = await openpgp.decryptKey({
      privateKey,
      passphrase,
    });
    return decryptedKey;
  }

  /**
   * Get the primary address ID (lowest Order value = primary)
   * @returns Primary address ID
   */
  getPrimaryAddressId(): string | null {
    let bestId: string | null = null;
    let bestOrder = Infinity;
    for (const [id, address] of this.addresses.entries()) {
      if (!this.addressKeyEntries.has(id)) continue;
      if (address.Order < bestOrder) {
        bestOrder = address.Order;
        bestId = id;
      }
    }
    return bestId;
  }

  /**
   * Get the addresses map (address ID → Address)
   * Needed by SDK AccountAdapter
   */
  getAddressesMap(): Map<string, Address> {
    return this.addresses;
  }

  /**
   * Decrypted keys of an address together with their Proton key IDs, in API
   * order, skipping keys that could not be unlocked.
   *
   * Needed by the SDK account adapter: Proton attributes signatures to the
   * reported key ID, so the ID must travel with the key object instead of
   * being looked up by position in `Address.Keys` (which would mislabel keys
   * whenever an earlier key was skipped).
   */
  getAddressKeyEntries(addressId: string): AddressKeyEntry[] {
    return this.addressKeyEntries.get(addressId) || [];
  }

  /**
   * The authenticated user API client this service initialised with, for the
   * SDK account adapter's public-key lookups of other Proton users.
   */
  getUserApi(): UserApiClient {
    return this.userApi;
  }
}
