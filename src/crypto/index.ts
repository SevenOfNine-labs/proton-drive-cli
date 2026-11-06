import * as openpgp from 'openpgp';
import { serverTime } from '../utils/server-time';

/**
 * OpenPGP operations on Proton account key material that are not covered by
 * the SDK crypto proxy: unlocking the user's own keys before the SDK starts.
 */
export class CryptoService {
  /**
   * Decrypt an address-key token and verify its detached signature.
   *
   * Proton encrypts each address key's passphrase ("token") to the user keys
   * and signs it with them. Official clients (web client and the SDK account
   * module) refuse the address key unless the signature verifies, so a
   * substituted token can never unlock an attacker-chosen key. Mirror that.
   *
   * @param armoredToken - Armored encrypted token (AddressKey.Token)
   * @param armoredSignature - Armored detached signature (AddressKey.Signature)
   * @param userKeys - Decrypted user private keys (decryption and verification)
   * @returns Decrypted token (the address key passphrase)
   */
  async decryptAddressKeyToken(
    armoredToken: string,
    armoredSignature: string | null,
    userKeys: openpgp.PrivateKey[]
  ): Promise<string> {
    if (!armoredSignature) {
      throw new Error('Address key token has no signature');
    }
    if (userKeys.length === 0) {
      throw new Error('No user keys available to verify the address key token');
    }
    const message = await openpgp.readMessage({ armoredMessage: armoredToken });
    const signature = await openpgp.readSignature({ armoredSignature });
    const { data, signatures } = await openpgp.decrypt({
      message,
      signature,
      decryptionKeys: userKeys,
      verificationKeys: userKeys.map((key) => key.toPublic()),
      date: serverTime(),
    });
    if (signatures.length === 0) {
      throw new Error('Address key token is not signed');
    }
    // Any signature by one of the user keys is sufficient (Proton tokens
    // carry one); collect the failures for the error message.
    const failures: string[] = [];
    for (const sig of signatures) {
      try {
        await sig.verified;
        return data as string;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Address key token signature verification failed: ${failures.join('; ')}`);
  }
}
