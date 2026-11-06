import './polyfill';
import * as openpgp from 'openpgp';
import { computeKeyPassword } from '@protontech/crypto/srp';
import { CryptoService } from './index';
import { UserApiClient } from '../api/user';
import { User, Address } from '../types/crypto';
import { logger } from '../utils/logger';

/** A decrypted address key paired with its Proton key ID. */
export interface AddressKeyEntry {
  id: string;
  key: openpgp.PrivateKey;
}

type UnlockMaterial =
  | { kind: 'mailbox-password'; password: string }
  | { kind: 'user-key-password'; keyPassword: string };

/**
 * Unlocks the Proton account key hierarchy (user keys, then the address keys
 * whose tokens they sign) and hands the decrypted address keys to the SDK
 * account adapter.
 */
export class DriveCryptoService {
  private crypto: CryptoService;
  private userApi: UserApiClient;
  private userKeys: Map<string, openpgp.PrivateKey> = new Map(); // User keys (primary account keys)
  private addressKeyEntries: Map<string, AddressKeyEntry[]> = new Map(); // Decrypted address keys with their Proton key IDs
  private addresses: Map<string, Address> = new Map(); // Full address info by address ID

  constructor(appVersion?: string) {
    this.crypto = new CryptoService();
    this.userApi = new UserApiClient(undefined, appVersion);
  }

  /**
   * Initialize crypto service with user's mailbox password
   * Decrypts and caches all user private keys.
   *
   * Uses the crypto-init disk cache (keySalts, user, addresses) when
   * available, eliminating 3 API round-trips on subsequent subprocesses.
   */
  async initialize(mailboxPassword: string): Promise<void> {
    // Normalize password (Proton uses NFC normalization)
    const normalizedPassword = mailboxPassword.normalize('NFC');
    await this.initializeWithUnlockMaterial({
      kind: 'mailbox-password',
      password: normalizedPassword,
    });
  }

  /**
   * Initialize crypto service with Proton's derived user key password.
   *
   * Browser session-fork auth returns this value directly. It is not the raw
   * mailbox password and must not be salted/derived again.
   */
  async initializeWithUserKeyPassword(userKeyPassword: string): Promise<void> {
    if (!userKeyPassword) {
      throw new Error('User key password is required');
    }
    await this.initializeWithUnlockMaterial({
      kind: 'user-key-password',
      keyPassword: userKeyPassword,
    });
  }

  private async initializeWithUnlockMaterial(material: UnlockMaterial): Promise<void> {
    this.userKeys.clear();
    this.addressKeyEntries.clear();
    this.addresses.clear();

    // Get key salts from API (or cache)
    const keySalts = await this.userApi.getKeySalts();

    // Create a map of key ID to salt
    const saltMap = new Map<string, string | null>();
    for (const keySalt of keySalts) {
      saltMap.set(keySalt.ID, keySalt.KeySalt);
    }

    // Get user information (for user keys) — may come from cache
    const user: User = await this.userApi.getUser();

    // Decrypt user keys first (these are the primary account keys)
    logger.debug(`Decrypting user keys for: ${user.Name}`);

    for (const key of user.Keys) {
      try {
        const decryptedKey = await this.decryptUserKey(key.PrivateKey, saltMap.get(key.ID), material);
        this.userKeys.set(key.ID, decryptedKey);
      } catch (error) {
        logger.warn(`Failed to decrypt user key: ${error}`);
      }
    }

    // Get user addresses — may come from cache
    const addresses = await this.userApi.getAddresses();

    // Persist crypto-init data to disk cache for subsequent subprocesses.
    // This is non-blocking and non-fatal (best-effort).
    this.userApi.saveCryptoCache(keySalts, user, addresses).catch(() => {});

    // Decrypt address keys (these are encrypted with tokens from user keys)
    for (const address of addresses) {
      const decryptedEntries: AddressKeyEntry[] = [];

      for (const key of address.Keys) {
        try {
          let passphrase: string | null = null;

          if (key.Token && this.userKeys.size > 0) {
            // The address key passphrase is a token encrypted to the user keys
            // and signed by them. Like Proton's official clients, decrypt with
            // every user key and require a valid signature; a key whose token
            // fails verification is skipped (logged below), never unlocked
            // through a password fallback.
            passphrase = await this.crypto.decryptAddressKeyToken(
              key.Token,
              key.Signature,
              Array.from(this.userKeys.values()),
            );
          } else {
            // Fall back to password-based decryption
            passphrase = await this.getFallbackKeyPassphrase(saltMap.get(key.ID), material);
          }

          // Try to decrypt the key
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

    if (this.userKeys.size === 0 && this.addressKeyEntries.size === 0) {
      throw new Error('Failed to decrypt any keys');
    }

    logger.debug(`Decrypted ${this.userKeys.size} user key(s) and ${this.addressKeyEntries.size} address key(s)`);
  }

  private async decryptUserKey(
    armoredKey: string,
    salt: string | null | undefined,
    material: UnlockMaterial,
  ): Promise<openpgp.PrivateKey> {
    if (material.kind === 'user-key-password') {
      return this.decryptPrivateKeyWithPassphrase(armoredKey, material.keyPassword);
    }

    // In single-password mode, always try raw password first.
    try {
      return await this.decryptPrivateKeyWithPassphrase(armoredKey, material.password);
    } catch {
      // Raw password failed, try SRP-compatible salt derivation below.
    }

    if (!salt) {
      throw new Error('No salt available and raw password failed');
    }
    const passphrase = await computeKeyPassword(material.password, salt);
    return this.decryptPrivateKeyWithPassphrase(armoredKey, passphrase);
  }

  private async getFallbackKeyPassphrase(
    salt: string | null | undefined,
    material: UnlockMaterial,
  ): Promise<string> {
    if (material.kind === 'user-key-password') {
      return material.keyPassword;
    }
    return salt ? computeKeyPassword(material.password, salt) : material.password;
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
      // Only consider addresses that have decrypted keys
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
