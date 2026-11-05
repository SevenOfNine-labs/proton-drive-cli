import * as openpgp from '@protontech/openpgp';
import { DecryptionResult, EncryptionResult } from '../types/crypto';
import { serverTime } from '../utils/server-time';

/**
 * Main crypto service for encryption and decryption operations
 */
export class CryptoService {
  /**
   * Decrypt a PGP message with a private key
   * @param armoredMessage - Armored PGP message
   * @param privateKey - Decrypted private key
   * @returns Decrypted data as string
   */
  async decryptMessage(
    armoredMessage: string,
    privateKey: openpgp.PrivateKey
  ): Promise<string> {
    const message = await openpgp.readMessage({ armoredMessage });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
    });
    return data as string;
  }

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

  /**
   * Decrypt a PGP message with a passphrase (string or Uint8Array)
   * @param armoredMessage - Armored PGP message
   * @param passphrase - Passphrase as string or Uint8Array
   * @returns Decrypted data as string
   */
  async decryptMessageWithPassphrase(
    armoredMessage: string,
    passphrase: string | Uint8Array
  ): Promise<string> {
    const message = await openpgp.readMessage({ armoredMessage });
    const { data } = await openpgp.decrypt({
      message,
      passwords: [passphrase as string],
    });
    return data as string;
  }

  /**
   * Extract session key from an armored message
   * @param armoredMessage - Armored PGP message
   * @param privateKey - Private key to decrypt the session key
   * @returns Session key
   */
  async extractSessionKey(
    armoredMessage: string,
    privateKey: openpgp.PrivateKey
  ): Promise<openpgp.DecryptedSessionKey> {
    const message = await openpgp.readMessage({ armoredMessage });
    const sessionKeys = await openpgp.decryptSessionKeys({
      message,
      decryptionKeys: privateKey,
    });
    if (!sessionKeys || sessionKeys.length === 0) {
      throw new Error('Failed to extract session key: no session keys found in message');
    }
    return sessionKeys[0];
  }

  /**
   * Decrypt a message with a session key
   * @param armoredMessage - Armored PGP message
   * @param sessionKey - Session key
   * @returns Decrypted data
   */
  async decryptWithSessionKey(
    armoredMessage: string,
    sessionKey: openpgp.DecryptedSessionKey
  ): Promise<Uint8Array> {
    const message = await openpgp.readMessage({ armoredMessage });
    const { data } = await openpgp.decrypt({
      message,
      sessionKeys: sessionKey as openpgp.SessionKey,
      format: 'binary'
    });
    return data as Uint8Array;
  }

  /**
   * Encrypt a message with a public key
   * @param data - Data to encrypt
   * @param publicKey - Public key to encrypt with
   * @returns Armored encrypted message
   */
  async encryptMessage(
    data: string,
    publicKey: openpgp.PublicKey
  ): Promise<string> {
    const message = await openpgp.createMessage({ text: data });
    const encrypted = await openpgp.encrypt({
      message,
      encryptionKeys: publicKey,
    });
    return encrypted as string;
  }

  /**
   * Encrypt data with a passphrase
   * @param data - Data to encrypt (string only for now)
   * @param passphrase - Passphrase as string or Uint8Array
   * @returns Armored encrypted message
   */
  async encryptWithPassphrase(
    data: string,
    passphrase: string | Uint8Array
  ): Promise<string> {
    const message = await openpgp.createMessage({ text: data });
    const encrypted = await openpgp.encrypt({
      message,
      passwords: [passphrase as string],
    });
    return encrypted as string;
  }

  /**
   * Generate a random session key
   * @param algorithm - Algorithm ('aes256', 'aes192', 'aes128')
   * @returns Session key
   */
  async generateSessionKey(algorithm: 'aes256' | 'aes192' | 'aes128' = 'aes256'): Promise<Uint8Array> {
    // Generate a random session key
    const keySize = algorithm === 'aes256' ? 32 : algorithm === 'aes192' ? 24 : 16;
    return crypto.getRandomValues(new Uint8Array(keySize));
  }

  /**
   * Verify signature of a cleartext message
   * @param armoredMessage - Armored cleartext signed message
   * @param publicKey - Public key to verify with
   * @returns Verification result with data
   */
  async verifyCleartextMessage(
    armoredMessage: string,
    publicKey: openpgp.PublicKey
  ): Promise<DecryptionResult> {
    const cleartextMessage = await openpgp.readCleartextMessage({ cleartextMessage: armoredMessage });
    const verificationResult = await openpgp.verify({
      message: cleartextMessage,
      verificationKeys: publicKey,
    });

    const { verified } = verificationResult.signatures[0];
    try {
      await verified;
      return {
        data: cleartextMessage.getText(),
        verified: true,
      };
    } catch (e) {
      return {
        data: cleartextMessage.getText(),
        verified: false,
      };
    }
  }

  /**
   * Sign a message
   * @param data - Data to sign
   * @param privateKey - Private key to sign with
   * @returns Armored signed message
   */
  async signMessage(
    data: string,
    privateKey: openpgp.PrivateKey
  ): Promise<string> {
    const message = await openpgp.createCleartextMessage({ text: data });
    const signed = await openpgp.sign({
      message,
      signingKeys: privateKey,
    });
    return signed as string;
  }

  /**
   * Compute SHA256 hash of data
   * @param data - Data to hash
   * @returns Hex-encoded hash
   */
  async computeHash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate a random passphrase (32 bytes, hex encoded)
   * @returns Random passphrase string
   */
  generatePassphrase(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate a new key pair
   * @param name - Name for the key
   * @param passphrase - Optional passphrase to encrypt the private key
   * @returns Key pair (public and private keys), with encryptedPrivateKey for storage
   */
  async generateKeyPair(name: string, passphrase?: string): Promise<{
    publicKey: openpgp.PublicKey;
    privateKey: openpgp.PrivateKey;
    decryptedPrivateKey: openpgp.PrivateKey;
    encryptedPrivateKeyArmored: string;
  }> {
    const keyPair = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: 2048,
      userIDs: [{ name }],
      passphrase,
    });

    // Read the encrypted private key
    const encryptedPrivateKey = await openpgp.readPrivateKey({ armoredKey: keyPair.privateKey });

    // Decrypt it to get the usable private key (if passphrase provided)
    let decryptedPrivateKey: openpgp.PrivateKey;
    if (passphrase) {
      decryptedPrivateKey = await openpgp.decryptKey({
        privateKey: encryptedPrivateKey,
        passphrase,
      });
    } else {
      decryptedPrivateKey = encryptedPrivateKey;
    }

    const publicKey = await openpgp.readKey({ armoredKey: keyPair.publicKey });

    return {
      publicKey,
      privateKey: encryptedPrivateKey,  // Encrypted version for storage
      decryptedPrivateKey,               // Decrypted version for immediate use
      encryptedPrivateKeyArmored: keyPair.privateKey,
    };
  }

  /**
   * Encrypt binary data with a session key and sign it
   * @param data - Binary data to encrypt
   * @param sessionKey - Session key object
   * @param signingKey - Private key to sign with
   * @returns Encrypted data and signature
   */
  async encryptAndSignBinary(
    data: Uint8Array,
    sessionKey: openpgp.SessionKey,
    signingKey: openpgp.PrivateKey
  ): Promise<{ data: Uint8Array; signature: string }> {
    // Create binary message (convert to Buffer for compatibility)
    const buffer = Buffer.from(data);
    const encryptMessage = await openpgp.createMessage({ binary: buffer });

    // Encrypt with session key and sign
    const encrypted = await openpgp.encrypt({
      message: encryptMessage,
      sessionKey: sessionKey,
      signingKeys: signingKey,
      format: 'binary',
    }) as Uint8Array;

    // Generate detached signature with a fresh message object.
    // OpenPGP.js message objects may be consumed by streaming operations,
    // so reusing the same object for both encrypt and sign is unsafe.
    const signMessage = await openpgp.createMessage({ binary: Buffer.from(data) });
    const signature = await openpgp.sign({
      message: signMessage,
      signingKeys: signingKey,
      detached: true,
    }) as string;

    return { data: encrypted, signature };
  }

  /**
   * Encrypt binary data and return as armored text
   * @param data - Binary data to encrypt
   * @param publicKeys - Public keys to encrypt to
   * @returns Armored encrypted message
   */
  async encryptBinaryData(
    data: Uint8Array,
    publicKeys: openpgp.PublicKey[]
  ): Promise<string> {
    const buffer = Buffer.from(data);
    const message = await openpgp.createMessage({ binary: buffer });
    const encrypted = await openpgp.encrypt({
      message,
      encryptionKeys: publicKeys,
    });
    return encrypted as string;
  }

  /**
   * Generate a session key for symmetric encryption
   * @param privateKey - Private key (used to determine algorithm compatibility)
   * @returns Session key
   */
  async generateSessionKeyForKey(privateKey: openpgp.PrivateKey): Promise<openpgp.SessionKey> {
    // Generate a random session key compatible with this key
    const sessionKey = await openpgp.generateSessionKey({
      encryptionKeys: privateKey,
    });
    return sessionKey;
  }

  /**
   * Encrypt a session key with encryption keys (returns PKESK packet)
   * @param sessionKey - Session key to encrypt
   * @param encryptionKeys - Array of keys to encrypt to (can be public or private keys)
   * @returns Encrypted session key packet (key packet)
   */
  async encryptSessionKey(
    sessionKey: openpgp.SessionKey,
    encryptionKeys: (openpgp.PublicKey | openpgp.PrivateKey)[]
  ): Promise<{ keyPacket: Uint8Array }> {
    // Use OpenPGP.js's encryptSessionKeys function
    const publicKeys = encryptionKeys.map(key => {
      if ('toPublic' in key && typeof key.toPublic === 'function') {
        // It's a private key, extract public key
        return key.toPublic();
      }
      // It's already a public key
      return key as openpgp.PublicKey;
    });

    // Encrypt the session key with the public keys using OpenPGP.js's native function
    const encryptedSessionKey = await openpgp.encryptSessionKey({
      ...sessionKey,
      encryptionKeys: publicKeys,
      format: 'binary',
    });

    return {
      keyPacket: encryptedSessionKey as Uint8Array,
    };
  }

  /**
   * Sign binary data (detached signature) - returns armored signature
   * @param data - Binary data to sign
   * @param signingKey - Private key to sign with
   * @returns Armored signature
   */
  async signBinaryDetached(
    data: Uint8Array,
    signingKey: openpgp.PrivateKey
  ): Promise<string> {
    const buffer = Buffer.from(data);
    const message = await openpgp.createMessage({ binary: buffer });
    const signature = await openpgp.sign({
      message,
      signingKeys: signingKey,
      detached: true,
    });
    return signature as string;
  }

  /**
   * Sign binary data and return raw signature bytes
   * @param data - Binary data to sign
   * @param signingKey - Private key to sign with
   * @returns Raw signature bytes
   */
  async signBinaryDetachedRaw(
    data: Uint8Array,
    signingKey: openpgp.PrivateKey
  ): Promise<Uint8Array> {
    const buffer = Buffer.from(data);
    const message = await openpgp.createMessage({ binary: buffer });
    const signature = await openpgp.sign({
      message,
      signingKeys: signingKey,
      detached: true,
      format: 'binary',
    });
    return signature as Uint8Array;
  }

  /**
   * Encrypt binary data and return as armored text
   * @param data - Binary data to encrypt
   * @param sessionKey - Session key for encryption
   * @param encryptionKeys - Optional encryption keys
   * @returns Armored encrypted message
   */
  async encryptBinaryToArmored(
    data: Uint8Array,
    sessionKey: openpgp.SessionKey,
    encryptionKeys?: openpgp.PrivateKey[]
  ): Promise<string> {
    const buffer = Buffer.from(data);
    const message = await openpgp.createMessage({ binary: buffer });

    const encrypted = await openpgp.encrypt({
      message,
      sessionKey,
      encryptionKeys: encryptionKeys || [],
      format: 'armored',
    });

    return encrypted as string;
  }

  /**
   * Compute verification token by XORing verification code with encrypted data
   * @param verificationCode - Verification code from server
   * @param encryptedData - Encrypted block data
   * @returns Verification token
   */
  computeVerificationToken(
    verificationCode: Uint8Array,
    encryptedData: Uint8Array
  ): Uint8Array {
    // XOR verification code with encrypted data (0-padded)
    return verificationCode.map((value, index) => value ^ (encryptedData[index] || 0));
  }

  /**
   * Decrypt a session key from a ContentKeyPacket
   * @param contentKeyPacketBase64 - Base64-encoded encrypted session key
   * @param nodePrivateKey - Node private key to decrypt with
   * @returns Decrypted session key
   */
  async decryptSessionKey(
    contentKeyPacketBase64: string,
    nodePrivateKey: openpgp.PrivateKey
  ): Promise<openpgp.SessionKey> {
    // Decode base64 to binary
    const keyPacketBinary = Buffer.from(contentKeyPacketBase64, 'base64');

    // Decrypt the session key using OpenPGP.js
    const decryptedKeys = await openpgp.decryptSessionKeys({
      message: await openpgp.readMessage({ binaryMessage: keyPacketBinary }),
      decryptionKeys: nodePrivateKey,
    });

    if (!decryptedKeys || decryptedKeys.length === 0) {
      throw new Error('Failed to decrypt session key');
    }

    const sessionKey = decryptedKeys[0];

    // Ensure algorithm is not null
    if (!sessionKey.algorithm) {
      throw new Error('Session key has no algorithm');
    }

    return sessionKey as openpgp.SessionKey;
  }
}

export const cryptoService = new CryptoService();
