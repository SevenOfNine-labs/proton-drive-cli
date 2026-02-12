import * as openpgp from '@protontech/openpgp';
import { CryptoService } from './index';
import { UserApiClient } from '../api/user';
import { decryptAddressKey } from './keys';
import { DecryptedShareContext, DecryptedNodeContext, User, Address } from '../types/crypto';
import { Share, Link } from '../types/drive';
import { deriveKeyPassphrase } from './key-password';
import { logger } from '../utils/logger';

/**
 * Drive-specific crypto operations
 * Handles the key hierarchy: User Key -> Share Key -> Node Key -> Content
 */
export class DriveCryptoService {
  private crypto: CryptoService;
  private userApi: UserApiClient;
  private userKeys: Map<string, openpgp.PrivateKey> = new Map(); // User keys (primary account keys)
  private addressKeys: Map<string, openpgp.PrivateKey[]> = new Map(); // Address keys (all decrypted keys per address)
  private addresses: Map<string, Address> = new Map(); // Full address info by address ID
  private shareContexts: Map<string, DecryptedShareContext> = new Map();
  private nodeContexts: Map<string, DecryptedNodeContext> = new Map();

  constructor() {
    this.crypto = new CryptoService();
    this.userApi = new UserApiClient();
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

    // Get key salts from API (or cache)
    const keySalts = await this.userApi.getKeySalts();

    // Create a map of key ID to salt
    const saltMap = new Map<string, string | null>();
    for (const keySalt of keySalts) {
      saltMap.set(keySalt.ID, keySalt.KeySalt);
    }

    // Get user information (for user keys) — may come from cache
    const user = await this.userApi.getUser();

    // Decrypt user keys first (these are the primary account keys)
    logger.debug(`Decrypting user keys for: ${user.Name}`);

    for (const key of user.Keys) {
      try {
        const salt = saltMap.get(key.ID);

        // In single-password mode, always try raw password first
        try {
          const decryptedKey = await this.decryptPrivateKeyWithPassphrase(key.PrivateKey, normalizedPassword);
          this.userKeys.set(key.ID, decryptedKey);
          continue;
        } catch (rawPassError) {
          // Raw password failed, try with salt derivation
        }

        // If raw password failed and we have a salt, try deriving passphrase
        if (salt) {
          const passphrase = await deriveKeyPassphrase(normalizedPassword, salt);
          const decryptedKey = await this.decryptPrivateKeyWithPassphrase(key.PrivateKey, passphrase);
          this.userKeys.set(key.ID, decryptedKey);
        } else {
          throw new Error('No salt available and raw password failed');
        }
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
      const decryptedKeys: openpgp.PrivateKey[] = [];

      for (const key of address.Keys) {
        try {
          let passphrase: string | null = null;

          if (key.Token && this.userKeys.size > 0) {
            // Address key is encrypted with a token that's encrypted with the user key.
            // Try all user keys — the token may not be encrypted with the first one.
            for (const userKey of this.userKeys.values()) {
              try {
                passphrase = await this.crypto.decryptMessage(key.Token!, userKey);
                break;
              } catch {
                // Try next user key
              }
            }
            if (!passphrase) {
              // No user key could decrypt the token — try password fallback
              const salt = saltMap.get(key.ID);
              passphrase = salt
                ? await deriveKeyPassphrase(normalizedPassword, salt)
                : normalizedPassword;
            }
          } else {
            // Fall back to password-based decryption
            const salt = saltMap.get(key.ID);
            passphrase = salt
              ? await deriveKeyPassphrase(normalizedPassword, salt)
              : normalizedPassword;
          }

          // Try to decrypt the key
          const decryptedKey = await this.decryptPrivateKeyWithPassphrase(key.PrivateKey, passphrase);
          decryptedKeys.push(decryptedKey);
        } catch (error) {
          logger.warn(`Failed to decrypt address key: ${error}`);
        }
      }

      if (decryptedKeys.length > 0) {
        this.addressKeys.set(address.ID, decryptedKeys);
        this.addresses.set(address.ID, address);
      }
    }

    if (this.userKeys.size === 0 && this.addressKeys.size === 0) {
      throw new Error('Failed to decrypt any keys');
    }

    logger.debug(`Decrypted ${this.userKeys.size} user key(s) and ${this.addressKeys.size} address key(s)`);
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
   * Get the primary decrypted key for an address.
   * Returns the first key (primary), but all keys are available via getKeysForAddress.
   */
  private getKeyForAddress(addressId: string): openpgp.PrivateKey {
    const keys = this.addressKeys.get(addressId);
    if (!keys || keys.length === 0) {
      throw new Error(`No decrypted key found for address ${addressId}`);
    }
    return keys[0];
  }

  /**
   * Get all decrypted keys for an address (for trying multiple keys during decryption).
   */
  private getKeysForAddress(addressId: string): openpgp.PrivateKey[] {
    return this.addressKeys.get(addressId) || [];
  }

  /**
   * Get any available private key (try user keys first, then address keys)
   */
  private getAnyPrivateKey(): openpgp.PrivateKey {
    // Try user keys first (these are primary keys)
    const userKeys = Array.from(this.userKeys.values());
    if (userKeys.length > 0) {
      return userKeys[0];
    }

    // Fall back to address keys (first key from first address)
    for (const keys of this.addressKeys.values()) {
      if (keys.length > 0) {
        return keys[0];
      }
    }

    throw new Error('No decrypted keys available');
  }

  /**
   * Decrypt a share's private key
   * @param share - Share object from API
   * @returns Decrypted share private key
   */
  async decryptShare(share: Share): Promise<DecryptedShareContext> {
    // Check cache first
    if (this.shareContexts.has(share.ShareID)) {
      return this.shareContexts.get(share.ShareID)!;
    }

    // Get address keys for decrypting the share passphrase.
    // Try all keys for the address — the passphrase may be encrypted with a non-primary key.
    const keysToTry: openpgp.PrivateKey[] = share.AddressID
      ? this.getKeysForAddress(share.AddressID)
      : [this.getAnyPrivateKey()];

    if (keysToTry.length === 0) {
      throw new Error(`No decrypted keys for address ${share.AddressID}`);
    }

    // Step 1: Decrypt the share passphrase (encrypted PGP message)
    let sharePassphrase: string | null = null;
    let lastError: Error | null = null;
    for (const key of keysToTry) {
      try {
        sharePassphrase = await this.crypto.decryptMessage(share.Passphrase, key);
        break;
      } catch (err) {
        lastError = err as Error;
      }
    }
    if (sharePassphrase === null) {
      throw lastError || new Error('Failed to decrypt share passphrase');
    }

    // Step 2: Decrypt the share's private key using the passphrase
    const sharePrivateKey = await this.decryptPrivateKeyWithPassphrase(
      share.Key,
      sharePassphrase
    );

    const context: DecryptedShareContext = {
      shareId: share.ShareID,
      shareKey: sharePrivateKey, // This is now an openpgp.PrivateKey, not a string
      sharePassphrase,
    };

    // Cache for future use
    this.shareContexts.set(share.ShareID, context);

    return context;
  }

  /**
   * Decrypt a node's (file/folder) key and passphrase
   * @param link - Link object from API
   * @param shareContext - Decrypted share context
   * @returns Decrypted node context
   */
  async decryptNode(link: Link, shareContext: DecryptedShareContext): Promise<DecryptedNodeContext> {
    // Check cache first
    const cacheKey = `${shareContext.shareId}:${link.LinkID}`;
    if (this.nodeContexts.has(cacheKey)) {
      return this.nodeContexts.get(cacheKey)!;
    }

    // Use the share's private key to decrypt node key and passphrase
    const sharePrivateKey = shareContext.shareKey;

    // Step 1: Extract session key from NodePassphrase (encrypted with share private key)
    const passphraseSessionKey = await this.crypto.extractSessionKey(
      link.NodePassphrase,
      sharePrivateKey
    );

    // Step 2: Decrypt the NodePassphrase with the session key to get passphrase string
    const nodePassphraseBytes = await this.crypto.decryptWithSessionKey(
      link.NodePassphrase,
      passphraseSessionKey
    );
    const nodePassphrase = new TextDecoder().decode(nodePassphraseBytes);

    // Step 3: Decrypt node private key with the node passphrase
    const nodePrivateKey = await this.decryptPrivateKeyWithPassphrase(
      link.NodeKey,
      nodePassphrase
    );

    const context: DecryptedNodeContext = {
      linkId: link.LinkID,
      nodeKey: nodePrivateKey, // This is now openpgp.PrivateKey, not a string
      nodePassphrase,
    };

    // Cache for future use
    this.nodeContexts.set(cacheKey, context);

    return context;
  }

  /**
   * Decrypt a file or folder name
   * @param link - Link object from API
   * @param nodeContext - Decrypted node context
   * @returns Decrypted name
   */
  async decryptName(link: Link, nodeContext: DecryptedNodeContext): Promise<string> {
    // Decrypt name (encrypted with parent node's private key)
    const decryptedName = await this.crypto.decryptMessage(
      link.Name,
      nodeContext.nodeKey
    );

    return decryptedName;
  }

  /**
   * Decrypt MIME type
   * @param link - Link object from API
   * @param nodeContext - Decrypted node context
   * @returns Decrypted MIME type
   */
  async decryptMimeType(link: Link, nodeContext: DecryptedNodeContext): Promise<string> {
    if (!link.MIMEType) {
      return 'application/octet-stream';
    }

    // Decrypt MIME type (encrypted with node private key)
    const decryptedMimeType = await this.crypto.decryptMessage(
      link.MIMEType,
      nodeContext.nodeKey
    );

    return decryptedMimeType;
  }

  /**
   * Decrypt a node's key using parent node context (not share)
   * @param link - Link object from API
   * @param parentNodeContext - Parent node's decrypted context
   * @returns Decrypted node context
   */
  async decryptNodeWithParent(link: Link, parentNodeContext: DecryptedNodeContext): Promise<DecryptedNodeContext> {
    // Check cache first
    const cacheKey = `node:${link.LinkID}`;
    if (this.nodeContexts.has(cacheKey)) {
      return this.nodeContexts.get(cacheKey)!;
    }

    const parentPrivateKey = parentNodeContext.nodeKey;

    // Step 1: Extract session key from NodePassphrase (encrypted with parent node's private key)
    const passphraseSessionKey = await this.crypto.extractSessionKey(
      link.NodePassphrase,
      parentPrivateKey
    );

    // Step 2: Decrypt the NodePassphrase with the session key to get passphrase string
    const nodePassphraseBytes = await this.crypto.decryptWithSessionKey(
      link.NodePassphrase,
      passphraseSessionKey
    );
    const nodePassphrase = new TextDecoder().decode(nodePassphraseBytes);

    // Step 3: Decrypt node private key with the node passphrase
    const nodePrivateKey = await this.decryptPrivateKeyWithPassphrase(
      link.NodeKey,
      nodePassphrase
    );

    const context: DecryptedNodeContext = {
      linkId: link.LinkID,
      nodeKey: nodePrivateKey,
      nodePassphrase,
    };

    // Cache for future use
    this.nodeContexts.set(cacheKey, context);

    return context;
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
      if (!this.addressKeys.has(id)) continue;
      if (address.Order < bestOrder) {
        bestOrder = address.Order;
        bestId = id;
      }
    }
    return bestId;
  }

  /**
   * Get the primary address email
   * @returns Primary address email
   */
  getPrimaryAddressEmail(): string | null {
    const addressId = this.getPrimaryAddressId();
    if (!addressId) {
      return null;
    }
    const address = this.addresses.get(addressId);
    return address ? address.Email : null;
  }

  /**
   * Get address email by ID
   * @param addressId - Address ID
   * @returns Address email
   */
  getAddressEmail(addressId: string): string | null {
    const address = this.addresses.get(addressId);
    return address ? address.Email : null;
  }

  /**
   * Get all address verification keys (email -> public key)
   * Returns a Map of lowercase email to the primary public key for that address.
   */
  getAllAddressVerificationKeys(): Map<string, openpgp.PublicKey> {
    const result = new Map<string, openpgp.PublicKey>();
    for (const [id, keys] of this.addressKeys.entries()) {
      if (keys.length === 0) continue;
      const address = this.addresses.get(id);
      if (!address) continue;
      result.set(address.Email.toLowerCase(), keys[0].toPublic());
    }
    return result;
  }

  /**
   * Get the signing key for an address
   * @param addressId - Address ID (optional, uses primary if not specified)
   * @returns Signing key (private key)
   */
  getSigningKey(addressId?: string): openpgp.PrivateKey {
    if (addressId) {
      return this.getKeyForAddress(addressId);
    }
    return this.getAnyPrivateKey();
  }

  /**
   * Get user private key (for general operations)
   * @returns User private key
   */
  getUserPrivateKey(): openpgp.PrivateKey {
    return this.getAnyPrivateKey();
  }

  /**
   * Get the addresses map (address ID → Address)
   * Needed by SDK AccountAdapter
   */
  getAddressesMap(): Map<string, Address> {
    return this.addresses;
  }

  /**
   * Get the address keys map (address ID → decrypted private keys)
   * Needed by SDK AccountAdapter
   */
  getAddressKeysMap(): Map<string, import('@protontech/openpgp').PrivateKey[]> {
    return this.addressKeys;
  }

  /**
   * Clear all cached keys and contexts (for logout)
   */
  clearCache(): void {
    this.userKeys.clear();
    this.addressKeys.clear();
    this.addresses.clear();
    this.shareContexts.clear();
    this.nodeContexts.clear();
  }
}

export const driveCrypto = new DriveCryptoService();
