import * as openpgp from 'openpgp';
import { CryptoService } from './index';
import { keyCreationDate } from '../test/openpgp-keys';

async function generateDecryptedKey(name: string): Promise<openpgp.PrivateKey> {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ name }],
    format: 'object',
    date: keyCreationDate(),
  });
  return privateKey;
}

async function encryptToken(token: string, userKey: openpgp.PrivateKey): Promise<string> {
  return openpgp.encrypt({
    message: await openpgp.createMessage({ text: token }),
    encryptionKeys: userKey.toPublic(),
  }) as Promise<string>;
}

async function signToken(token: string, signingKey: openpgp.PrivateKey): Promise<string> {
  return openpgp.sign({
    message: await openpgp.createMessage({ text: token }),
    signingKeys: signingKey,
    detached: true,
  }) as Promise<string>;
}

describe('CryptoService.decryptAddressKeyToken', () => {
  const svc = new CryptoService();
  let userKey: openpgp.PrivateKey;
  let otherKey: openpgp.PrivateKey;

  beforeAll(async () => {
    userKey = await generateDecryptedKey('user');
    otherKey = await generateDecryptedKey('other');
  });

  test('returns the token when the signature verifies against a user key', async () => {
    const token = 'address-key-passphrase';
    const encrypted = await encryptToken(token, userKey);
    const signature = await signToken(token, userKey);

    await expect(svc.decryptAddressKeyToken(encrypted, signature, [otherKey, userKey])).resolves.toBe(token);
  });

  test('rejects a token signed by a key that is not a user key', async () => {
    const token = 'address-key-passphrase';
    const encrypted = await encryptToken(token, userKey);
    const signature = await signToken(token, otherKey);

    await expect(svc.decryptAddressKeyToken(encrypted, signature, [userKey]))
      .rejects.toThrow('Address key token signature verification failed');
  });

  test('rejects a token without signature', async () => {
    const encrypted = await encryptToken('token', userKey);

    await expect(svc.decryptAddressKeyToken(encrypted, null, [userKey]))
      .rejects.toThrow('Address key token has no signature');
  });

  test('rejects verification without user keys', async () => {
    const encrypted = await encryptToken('token', userKey);
    const signature = await signToken('token', userKey);

    await expect(svc.decryptAddressKeyToken(encrypted, signature, []))
      .rejects.toThrow('No user keys available');
  });
});
