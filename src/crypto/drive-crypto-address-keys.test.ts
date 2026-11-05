/**
 * Address-key unlock behaviour of DriveCryptoService with real OpenPGP keys.
 *
 * Proton address keys are encrypted with a random token that is itself
 * encrypted to the user keys and signed by them. These tests build such a key
 * hierarchy locally and verify that the service accepts only tokens whose
 * signature verifies against the user keys, like Proton's official clients.
 */
import { randomBytes } from 'crypto';
import * as openpgp from '@protontech/openpgp';
import { DriveCryptoService } from './drive-crypto';
import { UserApiClient } from '../api/user';
import { logger } from '../utils/logger';
import type { Address, User } from '../types/crypto';

jest.mock('../api/user');

const USER_KEY_PASSWORD = 'derived-user-key-password';

async function generateArmoredKey(name: string, passphrase: string): Promise<string> {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ name, email: `${name}@example.test` }],
    passphrase,
    format: 'armored',
  });
  return privateKey;
}

async function unlock(armoredKey: string, passphrase: string): Promise<openpgp.PrivateKey> {
  return openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey }),
    passphrase,
  });
}

interface Fixture {
  user: User;
  address: Address;
}

type TokenSigner = 'user' | 'other' | 'none';

/** Build one token-protected address key; `signer` controls who signs the token. */
async function buildAddressKey(
  id: string,
  userKey: openpgp.PrivateKey,
  signer: TokenSigner,
  primary: number,
): Promise<Address['Keys'][number]> {
  const token = randomBytes(32).toString('base64');
  const addressArmored = await generateArmoredKey(id, token);

  const encryptedToken = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: token }),
    encryptionKeys: userKey.toPublic(),
  });

  let signature: string | null = null;
  if (signer !== 'none') {
    const signingKey = signer === 'other'
      ? await unlock(await generateArmoredKey('other', 'other-pass'), 'other-pass')
      : userKey;
    signature = await openpgp.sign({
      message: await openpgp.createMessage({ text: token }),
      signingKeys: signingKey,
      detached: true,
    });
  }

  return {
    ID: id,
    Version: 3,
    Primary: primary,
    Flags: 3,
    PrivateKey: addressArmored,
    Token: encryptedToken as string,
    Signature: signature,
    Activation: null,
  };
}

/**
 * Build a user key plus token-protected address keys. `signer` controls who
 * signs the first key's token (defaults to the user key, as Proton does);
 * `leadingRejectedKey` prepends a key whose token no user key signed.
 */
async function buildFixture(options: {
  signer?: TokenSigner;
  leadingRejectedKey?: boolean;
} = {}): Promise<Fixture> {
  const userArmored = await generateArmoredKey('user', USER_KEY_PASSWORD);
  const userKey = await unlock(userArmored, USER_KEY_PASSWORD);

  const keys: Address['Keys'] = [];
  if (options.leadingRejectedKey) {
    keys.push(await buildAddressKey('akey-0', userKey, 'other', 1));
  }
  keys.push(await buildAddressKey('akey-1', userKey, options.signer ?? 'user', keys.length === 0 ? 1 : 0));

  return {
    user: {
      ID: 'user-1',
      Name: 'user',
      Email: 'user@example.test',
      Keys: [
        { ID: 'ukey-1', Version: 3, Primary: 1, PrivateKey: userArmored, Token: null, Fingerprint: '', Activation: null },
      ],
    },
    address: {
      ID: 'addr-1',
      Email: 'user@example.test',
      Status: 1,
      Type: 1,
      Order: 1,
      Priority: 1,
      Keys: keys,
    },
  };
}

function mockUserApi(fixture: Fixture): void {
  (UserApiClient as jest.Mock).mockImplementation(() => ({
    getKeySalts: jest.fn().mockResolvedValue([{ ID: 'ukey-1', KeySalt: null }]),
    getUser: jest.fn().mockResolvedValue(fixture.user),
    getAddresses: jest.fn().mockResolvedValue([fixture.address]),
    saveCryptoCache: jest.fn().mockResolvedValue(undefined),
  }));
}

describe('DriveCryptoService address-key token verification', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('unlocks an address key whose token is signed by the user key', async () => {
    mockUserApi(await buildFixture());
    const svc = new DriveCryptoService();

    await svc.initializeWithUserKeyPassword(USER_KEY_PASSWORD);

    expect(svc.getAddressKeysMap().get('addr-1')).toHaveLength(1);
    expect(svc.getAddressKeyEntries('addr-1').map((entry) => entry.id)).toEqual(['akey-1']);
    expect(svc.getPrimaryAddressId()).toBe('addr-1');
    expect(svc.getPrimaryAddressEmail()).toBe('user@example.test');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('keeps the right key ID when an earlier address key is rejected', async () => {
    mockUserApi(await buildFixture({ leadingRejectedKey: true }));
    const svc = new DriveCryptoService();

    await svc.initializeWithUserKeyPassword(USER_KEY_PASSWORD);

    // akey-0 (first in API order) fails verification; the surviving key must
    // still be reported as akey-1, never as akey-0 by position.
    expect(svc.getAddressKeyEntries('addr-1').map((entry) => entry.id)).toEqual(['akey-1']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('address key akey-0'));
  });

  test('rejects an address key whose token signature comes from another key', async () => {
    mockUserApi(await buildFixture({ signer: 'other' }));
    const svc = new DriveCryptoService();

    await svc.initializeWithUserKeyPassword(USER_KEY_PASSWORD);

    expect(svc.getAddressKeysMap().size).toBe(0);
    expect(svc.getPrimaryAddressId()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to decrypt address key'),
    );
  });

  test('rejects an address key whose token carries no signature', async () => {
    mockUserApi(await buildFixture({ signer: 'none' }));
    const svc = new DriveCryptoService();

    await svc.initializeWithUserKeyPassword(USER_KEY_PASSWORD);

    expect(svc.getAddressKeysMap().size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Address key token has no signature'),
    );
  });
});
