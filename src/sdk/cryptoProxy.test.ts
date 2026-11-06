import * as openpgp from 'openpgp';
import { OpenPGPCryptoWithCryptoProxy } from '@protontech/drive-sdk';
import type { PrivateKeyReference, PublicKeyReference } from '@protontech/crypto';
import { VERIFICATION_STATUS } from '@protontech/crypto/constants';
import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';
import { resetServerTime, updateServerTime } from '../utils/server-time';

const CONTEXT_NOTATION = 'context@proton.ch';
const encode = (text: string) => new TextEncoder().encode(text);

async function generateKey(proxy: ProtonOpenPGPCryptoProxy, name = 'Test'): Promise<PrivateKeyReference> {
  return proxy.generateKey({ userIDs: [{ name }], type: 'ecc', curve: 'ed25519Legacy' });
}

async function publicKeyOf(proxy: ProtonOpenPGPCryptoProxy, key: PrivateKeyReference): Promise<PublicKeyReference> {
  return proxy.importPublicKey({ binaryKey: await proxy.exportPublicKey({ key, format: 'binary' }) });
}

async function notationsOf(binarySignature: Uint8Array<ArrayBuffer>) {
  const signature = await openpgp.readSignature({ binarySignature });
  return (signature.packets[0] as any).rawNotations as Array<{ name: string; value: Uint8Array; critical: boolean }>;
}

describe('ProtonOpenPGPCryptoProxy', () => {
  let proxy: ProtonOpenPGPCryptoProxy;
  let key: PrivateKeyReference;
  let publicKey: PublicKeyReference;

  beforeAll(async () => {
    proxy = new ProtonOpenPGPCryptoProxy();
    key = await generateKey(proxy);
    publicKey = await publicKeyOf(proxy, key);
  });

  describe('key management', () => {
    it('generates a key that can be exported and imported', async () => {
      const armored = await proxy.exportPrivateKey({ privateKey: key, passphrase: 'test-passphrase' });
      expect(armored).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');

      const imported = await proxy.importPrivateKey({ armoredKey: armored, passphrase: 'test-passphrase' });
      expect(imported.isPrivate()).toBe(true);
      expect(imported.getFingerprint()).toBe(key.getFingerprint());
    });

    it('rejects import with wrong passphrase', async () => {
      const armored = await proxy.exportPrivateKey({ privateKey: key, passphrase: 'correct' });

      await expect(
        proxy.importPrivateKey({ armoredKey: armored, passphrase: 'wrong' })
      ).rejects.toThrow();
    });

    it('shares one key store between instances, like the per-process CryptoProxy', async () => {
      const other = new ProtonOpenPGPCryptoProxy();
      const exported = await other.exportPublicKey({ key, format: 'armored' });
      expect(exported).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    });
  });

  describe('session keys', () => {
    it('generates, encrypts and decrypts a session key, reporting its algorithm', async () => {
      const sessionKey = await proxy.generateSessionKey({ recipientKeys: [publicKey] });
      expect(sessionKey.data).toBeInstanceOf(Uint8Array);
      expect(sessionKey.algorithm).toBe('aes256');

      const encrypted = await proxy.encryptSessionKey({ ...sessionKey, format: 'binary', encryptionKeys: publicKey });
      expect(encrypted).toBeInstanceOf(Uint8Array);

      const decrypted = await proxy.decryptSessionKey({ binaryMessage: encrypted, decryptionKeys: key });
      expect(decrypted?.data).toEqual(sessionKey.data);
      // The SDK reads this to recognise AEAD session keys (openPGPCrypto.ts).
      expect(decrypted?.algorithm).toBe('aes256');
    });

    it('accepts the SDK config flags', async () => {
      const sessionKey = await proxy.generateSessionKey({
        recipientKeys: [publicKey],
        config: { ignoreSEIPDv2FeatureFlag: true },
      });
      expect(sessionKey.algorithm).toBe('aes256');

      const aeadKey = await proxy.generateKey({
        userIDs: [{ name: 'aead' }],
        type: 'ecc',
        curve: 'ed25519Legacy',
        config: { aeadProtect: true },
      });
      expect(aeadKey.isPrivate()).toBe(true);
    });
  });

  describe('encrypt/decrypt message', () => {
    it('encrypts and decrypts an armored message', async () => {
      const plaintext = encode('Hello, Proton Drive!');

      const { message } = await proxy.encryptMessage({ binaryData: plaintext, encryptionKeys: [publicKey] });
      expect(message).toContain('-----BEGIN PGP MESSAGE-----');

      const result = await proxy.decryptMessage({ format: 'binary', armoredMessage: message, decryptionKeys: key });
      expect(new TextDecoder().decode(result.data)).toBe('Hello, Proton Drive!');
      expect(result.verificationStatus).toBe(VERIFICATION_STATUS.NOT_SIGNED);
    });

    it('encrypts and decrypts a binary message with a session key and verifies the inline signature', async () => {
      const sessionKey = await proxy.generateSessionKey({ recipientKeys: [publicKey] });
      const plaintext = encode('Session key test');

      const { message } = await proxy.encryptMessage({
        format: 'binary',
        binaryData: plaintext,
        sessionKey,
        encryptionKeys: [publicKey],
        signingKeys: key,
      });
      expect(message).toBeInstanceOf(Uint8Array);

      const result = await proxy.decryptMessage({
        format: 'binary',
        binaryMessage: message,
        sessionKeys: sessionKey,
        verificationKeys: publicKey,
      });
      expect(new TextDecoder().decode(result.data)).toBe('Session key test');
      expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);
    });

    it('does not inline-sign the ciphertext when a detached signature is requested', async () => {
      const sessionKey = await proxy.generateSessionKey({ recipientKeys: [publicKey] });
      const plaintext = encode('detached');

      const { message, signature } = await proxy.encryptMessage({
        format: 'binary',
        binaryData: plaintext,
        sessionKey,
        encryptionKeys: [publicKey],
        signingKeys: key,
        detached: true,
      });

      const unsigned = await proxy.decryptMessage({
        format: 'binary',
        binaryMessage: message,
        sessionKeys: sessionKey,
        verificationKeys: publicKey,
      });
      expect(unsigned.verificationStatus).toBe(VERIFICATION_STATUS.NOT_SIGNED);
      expect(unsigned.signatures).toHaveLength(0);

      const verified = await proxy.decryptMessage({
        format: 'binary',
        binaryMessage: message,
        binarySignature: signature,
        sessionKeys: sessionKey,
        verificationKeys: publicKey,
      });
      expect(verified.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);
    });
  });

  describe('sign/verify', () => {
    it('signs and verifies a message', async () => {
      const data = encode('Sign this');

      const signature = await proxy.signMessage({ format: 'armored', binaryData: data, signingKeys: key, detached: true });
      expect(signature).toContain('-----BEGIN PGP SIGNATURE-----');

      const result = await proxy.verifyMessage({ binaryData: data, armoredSignature: signature, verificationKeys: publicKey });
      expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);
      expect(result.errors).toBeUndefined();
    });

    it('returns invalid for tampered data', async () => {
      const signature = await proxy.signMessage({ format: 'armored', binaryData: encode('Original'), signingKeys: key, detached: true });

      const result = await proxy.verifyMessage({ binaryData: encode('Tampered'), armoredSignature: signature, verificationKeys: publicKey });
      expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
      expect(result.errors).toHaveLength(1);
    });

    it('accepts a message signed by several keys when any signature verifies', async () => {
      const secondKey = await generateKey(proxy, 'second');
      const data = encode('two signers');
      const signature = await proxy.signMessage({ format: 'binary', binaryData: data, signingKeys: [key, secondKey], detached: true });

      const secondOnly = await proxy.verifyMessage({
        binaryData: data,
        binarySignature: signature,
        verificationKeys: await publicKeyOf(proxy, secondKey),
      });
      expect(secondOnly.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);

      const stranger = await proxy.verifyMessage({
        binaryData: data,
        binarySignature: signature,
        verificationKeys: await publicKeyOf(proxy, await generateKey(proxy, 'stranger')),
      });
      expect(stranger.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
      expect(stranger.errors).toHaveLength(2);
    });
  });

  describe('signature context (Proton domain separation)', () => {
    const data = encode('context-bound');

    it('writes the critical context@proton.ch notation and no Proton salt notation', async () => {
      const signature = await proxy.signMessage({
        format: 'binary',
        binaryData: data,
        signingKeys: key,
        detached: true,
        signatureContext: { critical: true, value: 'drive.share-member.member' },
      });

      // OpenPGP.js adds its own non-critical salt@notations.openpgpjs.org
      // notation to every v4 signature; Proton's clients carry it too.
      const notations = (await notationsOf(signature)).filter((n) => n.name !== 'salt@notations.openpgpjs.org');
      expect(notations).toHaveLength(1);
      expect(notations[0].name).toBe(CONTEXT_NOTATION);
      expect(notations[0].critical).toBe(true);
      expect(new TextDecoder().decode(notations[0].value)).toBe('drive.share-member.member');

      const plain = await proxy.signMessage({ format: 'binary', binaryData: data, signingKeys: key, detached: true });
      expect((await notationsOf(plain)).map((n) => n.name)).not.toContain(CONTEXT_NOTATION);
    });

    it('verifies only against the same required context', async () => {
      const signature = await proxy.signMessage({
        format: 'binary',
        binaryData: data,
        signingKeys: key,
        detached: true,
        signatureContext: { critical: true, value: 'drive.share-member.member' },
      });

      const same = await proxy.verifyMessage({
        binaryData: data,
        binarySignature: signature,
        verificationKeys: publicKey,
        signatureContext: { required: true, value: 'drive.share-member.member' },
      });
      expect(same.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);

      const mismatched = await proxy.verifyMessage({
        binaryData: data,
        binarySignature: signature,
        verificationKeys: publicKey,
        signatureContext: { required: true, value: 'drive.share-member.inviter' },
      });
      expect(mismatched.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
      expect(mismatched.errors?.[0]?.name).toBe('SignatureContextError');

      // A critical notation makes the signature unverifiable by a verifier
      // that does not declare the context.
      const unaware = await proxy.verifyMessage({ binaryData: data, binarySignature: signature, verificationKeys: publicKey });
      expect(unaware.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
    });

    it('rejects a context-less signature when a context is required', async () => {
      const signature = await proxy.signMessage({ format: 'binary', binaryData: data, signingKeys: key, detached: true });

      const result = await proxy.verifyMessage({
        binaryData: data,
        binarySignature: signature,
        verificationKeys: publicKey,
        signatureContext: { required: true, value: 'drive.share-member.member' },
      });
      expect(result.verificationStatus).toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
      expect(result.errors?.[0]?.name).toBe('SignatureContextError');
    });

    it('is driven by the SDK wrapper for sign() and verify()', async () => {
      const crypto = new OpenPGPCryptoWithCryptoProxy(proxy);
      const { signature } = await crypto.sign(data, key, 'drive.share-member.member');

      expect((await crypto.verify(data, signature, publicKey, 'drive.share-member.member')).verified)
        .toBe(VERIFICATION_STATUS.SIGNED_AND_VALID);
      expect((await crypto.verify(data, signature, publicKey, 'drive.share-member.inviter')).verified)
        .toBe(VERIFICATION_STATUS.SIGNED_AND_INVALID);
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

    const key = await proxy.generateKey({ userIDs: [{ name: 'Test' }], type: 'ecc', curve: 'ed25519Legacy' });
    // pmcrypto backdates generated keys by its key-generation offset so that
    // clocks slightly behind the server still accept them.
    expect(key.getCreationTime().getTime()).toBeLessThanOrEqual(serverNow.getTime());
    expect(Math.abs(key.getCreationTime().getTime() - serverNow.getTime())).toBeLessThan(120_000);

    const binarySignature = await proxy.signMessage({
      format: 'binary',
      binaryData: encode('hello'),
      signingKeys: key,
      detached: true,
    });
    const signature = await openpgp.readSignature({ binarySignature });
    const created = (signature.packets[0] as any).created as Date;

    expect(Math.abs(created.getTime() - serverNow.getTime())).toBeLessThan(2000);
  });
});
