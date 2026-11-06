/**
 * Account adapter for the Proton Drive SDK.
 *
 * Implements ProtonDriveAccount on top of DriveCryptoService, which unlocks
 * the user and address keys during initialize(), and of the crypto endpoint,
 * into which the decrypted keys are imported so the SDK receives key
 * references it can use (official account module: addresses.ts).
 */

import type { CryptoApiInterface, PrivateKeyReference, PublicKeyReference } from '@protontech/crypto';
import type {
  ProtonDriveAccount,
  ProtonDriveAccountAddress,
} from '@protontech/drive-sdk';
import type * as openpgp from 'openpgp';
import { DriveCryptoService } from '../crypto/drive-crypto';
import { logger } from '../utils/logger';
import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';

export class AccountAdapter implements ProtonDriveAccount {
  /** Key references by Proton key ID; a key is imported into the endpoint once. */
  private readonly privateKeyReferences = new Map<string, Promise<PrivateKeyReference>>();
  private readonly ownPublicKeyReferences = new Map<string, Promise<PublicKeyReference>>();
  /** Public keys of other Proton users by lower-cased email. */
  private readonly otherPublicKeys = new Map<string, Promise<PublicKeyReference[]>>();

  constructor(
    private readonly driveCrypto: DriveCryptoService,
    private readonly cryptoProxy: CryptoApiInterface = new ProtonOpenPGPCryptoProxy(),
  ) {}

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    const addressId = this.driveCrypto.getPrimaryAddressId();
    if (!addressId) {
      throw new Error('No primary address found');
    }
    return this.buildAddress(addressId);
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    const addressesMap = this.driveCrypto.getAddressesMap();
    const result: ProtonDriveAccountAddress[] = [];

    for (const id of addressesMap.keys()) {
      if (this.driveCrypto.getAddressKeyEntries(id).length === 0) continue;
      result.push(await this.buildAddress(id));
    }

    if (result.length === 0) {
      throw new Error('No addresses with decrypted keys found');
    }

    return result;
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    if (this.driveCrypto.getAddressesMap().has(emailOrAddressId)) {
      return this.buildAddress(emailOrAddressId);
    }

    const addressId = this.findOwnAddressId(emailOrAddressId);
    if (addressId) {
      return this.buildAddress(addressId);
    }

    throw new Error(`No address found for: ${emailOrAddressId}`);
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    return (await this.getPublicKeys(email)).length > 0;
  }

  /**
   * Public keys the SDK verifies signatures with: the user's own address
   * keys for an own email, otherwise the keys Proton publishes for the
   * address (GET /core/v4/keys/all), empty when no Proton account owns it.
   */
  async getPublicKeys(email: string, forceRefresh?: boolean): Promise<PublicKeyReference[]> {
    const ownAddressId = this.findOwnAddressId(email);
    if (ownAddressId) {
      return this.getOwnPublicKeys(ownAddressId);
    }
    return this.getOtherPublicKeys(email, forceRefresh);
  }

  private findOwnAddressId(email: string): string | undefined {
    const wanted = email.toLowerCase();
    for (const [id, address] of this.driveCrypto.getAddressesMap().entries()) {
      if (address.Email.toLowerCase() === wanted) {
        return id;
      }
    }
    return undefined;
  }

  private async buildAddress(addressId: string): Promise<ProtonDriveAccountAddress> {
    const address = this.driveCrypto.getAddressesMap().get(addressId);
    if (!address) {
      throw new Error(`Address not found: ${addressId}`);
    }

    // Key IDs travel with the decrypted keys: Proton attributes signatures to
    // the reported key ID, and a positional lookup in address.Keys would
    // mislabel keys whenever an earlier key could not be unlocked.
    const entries = this.driveCrypto.getAddressKeyEntries(addressId);
    if (entries.length === 0) {
      throw new Error(`No decrypted keys for address: ${addressId}`);
    }

    const keys = await Promise.all(
      entries.map(async ({ id, key }) => ({ id, key: await this.importPrivateKey(id, key) })),
    );

    return {
      email: address.Email,
      addressId,
      primaryKeyIndex: 0,
      keys,
    };
  }

  private importPrivateKey(keyId: string, key: openpgp.PrivateKey): Promise<PrivateKeyReference> {
    let reference = this.privateKeyReferences.get(keyId);
    if (!reference) {
      // The key is already decrypted; its serialisation carries the
      // unprotected secret material, hence passphrase null.
      reference = this.cryptoProxy.importPrivateKey({
        binaryKey: new Uint8Array(key.write()),
        passphrase: null,
      });
      this.privateKeyReferences.set(keyId, reference);
      reference.catch(() => this.privateKeyReferences.delete(keyId));
    }
    return reference;
  }

  private async getOwnPublicKeys(addressId: string): Promise<PublicKeyReference[]> {
    const entries = this.driveCrypto.getAddressKeyEntries(addressId);
    return Promise.all(entries.map(({ id, key }) => this.importOwnPublicKey(id, key)));
  }

  private importOwnPublicKey(keyId: string, key: openpgp.PrivateKey): Promise<PublicKeyReference> {
    let reference = this.ownPublicKeyReferences.get(keyId);
    if (!reference) {
      reference = (async () => {
        const privateKey = await this.importPrivateKey(keyId, key);
        return this.cryptoProxy.importPublicKey({
          binaryKey: await this.cryptoProxy.exportPublicKey({ key: privateKey, format: 'binary' }),
        });
      })();
      this.ownPublicKeyReferences.set(keyId, reference);
      reference.catch(() => this.ownPublicKeyReferences.delete(keyId));
    }
    return reference;
  }

  private getOtherPublicKeys(email: string, forceRefresh?: boolean): Promise<PublicKeyReference[]> {
    const cacheKey = email.toLowerCase();
    const cached = this.otherPublicKeys.get(cacheKey);
    if (cached && !forceRefresh) {
      return cached;
    }

    const lookup = (async () => {
      const address = await this.driveCrypto.getUserApi().getAddressPublicKeys(email);
      if (!address) {
        return [];
      }
      return Promise.all(
        address.Keys.map((key) => this.cryptoProxy.importPublicKey({ armoredKey: key.PublicKey })),
      );
    })();
    this.otherPublicKeys.set(cacheKey, lookup);
    lookup.catch((error) => {
      logger.debug(`Public key lookup failed for ${email}: ${error instanceof Error ? error.message : error}`);
      this.otherPublicKeys.delete(cacheKey);
    });
    return lookup;
  }
}
