import * as openpgp from '@protontech/openpgp';
import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';
import { resetServerTime, updateServerTime } from '../utils/server-time';

describe('ProtonOpenPGPCryptoProxy', () => {
  let proxy: ProtonOpenPGPCryptoProxy;

  beforeAll(() => {
    proxy = new ProtonOpenPGPCryptoProxy();
  });

  describe('generateKey', () => {
    it('generates a key that can be exported and imported', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });
      expect(key).toBeDefined();

      // Export with passphrase
      const armored = await proxy.exportPrivateKey({
        privateKey: key,
        passphrase: 'test-passphrase',
      });
      expect(armored).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');

      // Import with passphrase
      const imported = await proxy.importPrivateKey({
        armoredKey: armored,
        passphrase: 'test-passphrase',
      });
      expect(imported).toBeDefined();
    });

    it('rejects import with wrong passphrase', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });
      const armored = await proxy.exportPrivateKey({
        privateKey: key,
        passphrase: 'correct',
      });

      await expect(
        proxy.importPrivateKey({ armoredKey: armored, passphrase: 'wrong' })
      ).rejects.toThrow();
    });
  });

  describe('session key operations', () => {
    it('generates, encrypts, and decrypts a session key', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });

      const sessionKey = await proxy.generateSessionKey({
        recipientKeys: [key],
      });
      expect(sessionKey).toBeDefined();
      expect(sessionKey.data).toBeInstanceOf(Uint8Array);

      // Encrypt session key with the public key
      const encrypted = await proxy.encryptSessionKey({
        ...sessionKey,
        format: 'binary',
        encryptionKeys: key,
      });
      expect(encrypted).toBeInstanceOf(Uint8Array);

      // Decrypt session key
      const decrypted = await proxy.decryptSessionKey({
        binaryMessage: encrypted,
        decryptionKeys: key,
      });
      expect(decrypted).toBeDefined();
      expect(decrypted!.data).toBeInstanceOf(Uint8Array);
    });
  });

  describe('encrypt/decrypt message', () => {
    it('encrypts and decrypts armored message', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });

      const plaintext = new TextEncoder().encode('Hello, Proton Drive!');

      const { message } = await proxy.encryptMessage({
        binaryData: plaintext,
        encryptionKeys: [key],
      });
      expect(typeof message).toBe('string');
      expect(message).toContain('-----BEGIN PGP MESSAGE-----');

      const result = await proxy.decryptMessage({
        format: 'binary',
        armoredMessage: message as string,
        decryptionKeys: key,
      });
      expect(new TextDecoder().decode(result.data as Uint8Array)).toBe('Hello, Proton Drive!');
    });

    it('encrypts and decrypts binary message with session key', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });

      const sessionKey = await proxy.generateSessionKey({ recipientKeys: [key] });
      const plaintext = new TextEncoder().encode('Session key test');

      const { message } = await proxy.encryptMessage({
        format: 'binary',
        binaryData: plaintext,
        sessionKey,
        encryptionKeys: [key],
      });
      expect(message).toBeInstanceOf(Uint8Array);

      const result = await proxy.decryptMessage({
        format: 'binary',
        binaryMessage: message as Uint8Array,
        sessionKeys: sessionKey,
      });
      expect(new TextDecoder().decode(result.data as Uint8Array)).toBe('Session key test');
    });
  });

  describe('sign/verify message', () => {
    it('signs and verifies a message', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });

      const data = new TextEncoder().encode('Sign this');

      const signature = await proxy.signMessage({
        format: 'armored',
        binaryData: data,
        signingKeys: key,
        detached: true,
      });
      expect(typeof signature).toBe('string');

      const result = await proxy.verifyMessage({
        binaryData: data,
        armoredSignature: signature as string,
        verificationKeys: key,
      });
      expect(result.verificationStatus).toBe(1); // SIGNED_AND_VALID
    });

    it('returns invalid for tampered data', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });

      const data = new TextEncoder().encode('Original');
      const signature = await proxy.signMessage({
        format: 'armored',
        binaryData: data,
        signingKeys: key,
        detached: true,
      });

      const tampered = new TextEncoder().encode('Tampered');
      const result = await proxy.verifyMessage({
        binaryData: tampered,
        armoredSignature: signature as string,
        verificationKeys: key,
      });
      expect(result.verificationStatus).toBe(2); // SIGNED_AND_INVALID
    });
  });

  describe('decryptSessionKey', () => {
    it('returns undefined when no message provided', async () => {
      const key = await proxy.generateKey({
        userIDs: [{ name: 'Test' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
      });

      const result = await proxy.decryptSessionKey({
        decryptionKeys: key,
      });
      expect(result).toBeUndefined();
    });
  });
});


describe('ProtonOpenPGPCryptoProxy server time', () => {
  afterEach(() => {
    resetServerTime();
  });

  it('dates keys and signatures with the Proton server clock, not the device clock', async () => {
    const proxy = new ProtonOpenPGPCryptoProxy();

    // Pretend the device clock runs one hour ahead of Proton. Keys generated
    // after the sync are dated at server time as well; a key dated by the
    // device clock would be "from the future" for every later signature.
    const serverNow = new Date(Date.now() - 3_600_000);
    updateServerTime(serverNow);

    const key = await proxy.generateKey({
      userIDs: [{ name: 'Test' }],
      type: 'ecc',
      curve: 'ed25519Legacy',
    });
    expect(Math.abs((key as any).getCreationTime().getTime() - serverNow.getTime())).toBeLessThan(2000);

    const binarySignature = await proxy.signMessage({
      format: 'binary',
      binaryData: new TextEncoder().encode('hello'),
      signingKeys: key,
      detached: true,
    });
    const signature = await openpgp.readSignature({ binarySignature });
    const created = (signature.packets[0] as any).created as Date;

    expect(Math.abs(created.getTime() - serverNow.getTime())).toBeLessThan(2000);
  });
});
