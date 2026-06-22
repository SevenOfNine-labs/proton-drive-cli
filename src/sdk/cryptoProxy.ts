/**
 * OpenPGPCryptoProxy adapter for the Proton Drive SDK.
 *
 * Implements the 10-method proxy interface using @protontech/openpgp directly.
 * The SDK's OpenPGPCryptoWithCryptoProxy wraps this to provide the full
 * 25+ method OpenPGPCrypto interface automatically.
 *
 * The SDK's crypto types (PrivateKey, PublicKey, SessionKey) are opaque marker
 * interfaces. At runtime they ARE openpgp.js objects. We cast through `any`
 * at the boundary.
 */

import * as openpgp from '@protontech/openpgp';
import type { CryptoApiInterface } from '@protontech/crypto';

// The SDK's opaque types are not exported from the top-level package.
// They're just marker interfaces — at runtime everything is openpgp.js objects.
// We define local aliases that match the SDK's shapes exactly.
type PrivateKey = { readonly _idx: any; readonly _dummyType: 'private' };
type PublicKey = { readonly _idx: any };
type SessionKey = { data: Uint8Array };

export class ProtonOpenPGPCryptoProxy implements CryptoApiInterface {
  async generateKey(options: {
    userIDs: { name: string }[];
    type: 'ecc';
    curve: 'ed25519Legacy';
  }): Promise<any> {
    const { privateKey } = await openpgp.generateKey({
      userIDs: options.userIDs,
      type: options.type,
      curve: options.curve as any,
      format: 'object',
    });
    return privateKey;
  }

  async exportPrivateKey(options: {
    privateKey: any;
    passphrase: string | null;
  }): Promise<string> {
    const pgpKey = options.privateKey as openpgp.PrivateKey;
    if (options.passphrase != null) {
      const encrypted = await openpgp.encryptKey({
        privateKey: pgpKey,
        passphrase: options.passphrase,
      });
      return encrypted.armor();
    }
    return pgpKey.armor();
  }

  async importPrivateKey(options: {
    armoredKey: string;
    passphrase: string | null;
  }): Promise<any> {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: options.armoredKey });
    if (options.passphrase != null) {
      const decrypted = await openpgp.decryptKey({
        privateKey,
        passphrase: options.passphrase,
      });
      return decrypted;
    }
    return privateKey;
  }

  async generateSessionKey(options: {
    recipientKeys: any[];
  }): Promise<SessionKey> {
    const sk = await openpgp.generateSessionKey({
      encryptionKeys: options.recipientKeys as openpgp.PublicKey[],
    });
    return { data: sk.data };
  }

  async encryptSessionKey(
    options: SessionKey & {
      format: 'binary';
      encryptionKeys?: any;
      passwords?: string[];
    },
  ): Promise<Uint8Array> {
    const encOpts: any = {
      data: options.data,
      algorithm: 'aes256',
      format: 'binary',
    };
    if (options.encryptionKeys) {
      const keys = Array.isArray(options.encryptionKeys)
        ? options.encryptionKeys
        : [options.encryptionKeys];
      encOpts.encryptionKeys = keys;
    }
    if (options.passwords) {
      encOpts.passwords = options.passwords;
    }
    const result = await openpgp.encryptSessionKey(encOpts);
    return result as unknown as Uint8Array;
  }

  async decryptSessionKey(options: {
    armoredMessage?: string;
    binaryMessage?: Uint8Array;
    decryptionKeys: any;
  }): Promise<SessionKey | undefined> {
    let message: any;
    if (options.armoredMessage) {
      message = await openpgp.readMessage({ armoredMessage: options.armoredMessage });
    } else if (options.binaryMessage) {
      message = await openpgp.readMessage({ binaryMessage: options.binaryMessage as any });
    } else {
      return undefined;
    }

    const pgpKeys = Array.isArray(options.decryptionKeys)
      ? options.decryptionKeys
      : [options.decryptionKeys];
    const result = await openpgp.decryptSessionKeys({
      message,
      decryptionKeys: pgpKeys,
    });

    if (result.length === 0) return undefined;
    return { data: result[0].data };
  }

  async encryptMessage(options: {
    format?: string;
    binaryData: Uint8Array;
    sessionKey?: SessionKey;
    encryptionKeys: any[];
    signingKeys?: any;
    detached?: boolean;
    compress?: boolean;
  }): Promise<any> {
    const format = options.format || 'armored';
    const message = await openpgp.createMessage({ binary: options.binaryData as any });

    const encOpts: any = {
      message,
      format,
    };

    if (options.sessionKey) {
      encOpts.sessionKey = {
        data: options.sessionKey.data,
        algorithm: 'aes256',
      };
    }

    if (options.encryptionKeys && options.encryptionKeys.length > 0) {
      encOpts.encryptionKeys = options.encryptionKeys;
    }

    if (options.signingKeys) {
      encOpts.signingKeys = options.signingKeys;
    }

    if (options.compress) {
      encOpts.config = { preferredCompressionAlgorithm: openpgp.enums.compression.zlib };
    }

    if (options.detached) {
      const sigResult = await openpgp.sign({
        message,
        signingKeys: encOpts.signingKeys ? [encOpts.signingKeys] : [],
        detached: true,
        format: format as any,
      } as any);

      const encrypted = await openpgp.encrypt(encOpts);
      return { message: encrypted, signature: sigResult };
    }

    const encrypted = await openpgp.encrypt(encOpts);
    return { message: encrypted };
  }

  async decryptMessage(options: {
    format: string;
    armoredMessage?: string;
    binaryMessage?: Uint8Array;
    armoredSignature?: string;
    binarySignature?: Uint8Array;
    sessionKeys?: SessionKey;
    passwords?: string[];
    decryptionKeys?: any;
    verificationKeys?: any;
  }): Promise<{
    data: any;
    verificationStatus: 0 | 1 | 2;
    verificationErrors?: Error[];
  }> {
    let message: any;
    if (options.armoredMessage) {
      message = await openpgp.readMessage({ armoredMessage: options.armoredMessage });
    } else if (options.binaryMessage) {
      message = await openpgp.readMessage({ binaryMessage: options.binaryMessage as any });
    } else {
      throw new Error('Either armoredMessage or binaryMessage must be provided');
    }

    const decOpts: any = {
      message,
      format: options.format,
    };

    if (options.sessionKeys) {
      decOpts.sessionKeys = {
        data: options.sessionKeys.data,
        algorithm: 'aes256',
      };
    }

    if (options.passwords) {
      decOpts.passwords = options.passwords;
    }

    if (options.decryptionKeys) {
      const keys = Array.isArray(options.decryptionKeys)
        ? options.decryptionKeys
        : [options.decryptionKeys];
      decOpts.decryptionKeys = keys;
    }

    if (options.verificationKeys) {
      const keys = Array.isArray(options.verificationKeys)
        ? options.verificationKeys
        : [options.verificationKeys];
      decOpts.verificationKeys = keys;
    }

    if (options.armoredSignature) {
      decOpts.signature = await openpgp.readSignature({ armoredSignature: options.armoredSignature });
    } else if (options.binarySignature) {
      decOpts.signature = await openpgp.readSignature({ binarySignature: options.binarySignature as any });
    }

    const result = await openpgp.decrypt(decOpts);

    let verificationStatus: 0 | 1 | 2 = 0; // NOT_SIGNED
    const verificationErrors: Error[] = [];

    if (result.signatures && result.signatures.length > 0) {
      try {
        await result.signatures[0].verified;
        verificationStatus = 1; // SIGNED_AND_VALID
      } catch (err: any) {
        verificationStatus = 2; // SIGNED_AND_INVALID
        verificationErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return {
      data: result.data,
      verificationStatus,
      verificationErrors: verificationErrors.length > 0 ? verificationErrors : undefined,
    };
  }

  async signMessage(options: {
    format: string;
    binaryData: Uint8Array;
    signingKeys: any;
    detached: boolean;
    signatureContext?: { critical: boolean; value: string };
  }): Promise<any> {
    const message = await openpgp.createMessage({ binary: options.binaryData as any });
    const pgpKeys = Array.isArray(options.signingKeys)
      ? options.signingKeys
      : [options.signingKeys];

    const signOpts: any = {
      message,
      signingKeys: pgpKeys,
      detached: options.detached,
      format: options.format,
    };

    if (options.signatureContext) {
      signOpts.signatureNotations = [
        {
          name: 'salt@notations.protontech.ch',
          value: new Uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(32))),
          humanReadable: false,
          critical: options.signatureContext.critical,
        },
      ];
    }

    const result = await openpgp.sign(signOpts);
    return result;
  }

  async verifyMessage(options: {
    binaryData: Uint8Array;
    armoredSignature?: string;
    binarySignature?: Uint8Array;
    verificationKeys: any;
    signatureContext?: { critical: boolean; value: string };
  }): Promise<{
    verificationStatus: 0 | 1 | 2;
    errors?: Error[];
  }> {
    const message = await openpgp.createMessage({ binary: options.binaryData as any });
    const pgpKeys = Array.isArray(options.verificationKeys)
      ? options.verificationKeys
      : [options.verificationKeys];

    let signature: any;
    if (options.armoredSignature) {
      signature = await openpgp.readSignature({ armoredSignature: options.armoredSignature });
    } else if (options.binarySignature) {
      signature = await openpgp.readSignature({ binarySignature: options.binarySignature as any });
    } else {
      return { verificationStatus: 0 };
    }

    const result = await openpgp.verify({
      message,
      signature,
      verificationKeys: pgpKeys,
    } as any);

    const errors: Error[] = [];
    let status: 0 | 1 | 2 = 0;

    if (result.signatures && result.signatures.length > 0) {
      try {
        await result.signatures[0].verified;
        status = 1; // SIGNED_AND_VALID
      } catch (err: any) {
        status = 2; // SIGNED_AND_INVALID
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return {
      verificationStatus: status,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}
