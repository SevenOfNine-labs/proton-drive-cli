/**
 * SRP adapter on @protontech/crypto/srp. The vectors were recorded from the
 * previous in-tree SRP and key-password implementation (same inputs, same
 * mocked randomness and modulus) so that the switch to the library is proven
 * bit-for-bit equivalent.
 */
import * as path from 'path';
import { getSrp } from '@protontech/crypto/srp';
import { SRPModuleAdapter } from './srpAdapter';
import type { UserApiClient } from '../api/user';

// The library verifies the Proton-signed modulus with the SRP_MODULUS_KEY; a
// test modulus cannot carry that signature, so verification is replaced.
// jest.mock is hoisted above the imports, hence the inline require of path.
jest.mock(
  require('path').join(require('path').dirname(require.resolve('@protontech/crypto/srp')), 'utils', 'modulus.ts'),
  () => ({ verifyAndGetModulus: jest.fn() }),
);

const modulusModule = path.join(path.dirname(require.resolve('@protontech/crypto/srp')), 'utils', 'modulus.ts');
const { verifyAndGetModulus } = require(modulusModule) as { verifyAndGetModulus: jest.Mock };

const KEY_PASSWORD_VECTORS: Array<[string, string, string]> = [
  ['testpassword', 'AAAAAAAAAAAAAAAAAAAAAA==', 'nk405PyegGmM8K9/vGk/sJU7cmUTq8m'],
  ['password1', 'AAAAAAAAAAAAAAAAAAAAAA==', '9xScOgQlq8FpJPVj8U4CBTckQFwZDBW'],
  ['correct horse battery staple', 'AQEBAQEBAQEBAQEBAQEBAQ==', 'VpR3lw8whhzm9y5YLuw7fUOIa4Cy2WS'],
  ['pässwörd ✓', 'zq1b3Qp1pPfyIRuY8c3ZIg==', 'uTf13Ac6SECtVUODdA6ofpBH1UiILBy'],
];

const SRP_VECTOR = {
  clientEphemeral: 'w5sba7cNyQUcxzQhxT7fwRw7xFNnO7/IF9ofcmTr6pjXftv67MwLFoFKRMV8GtyLZ8ODWiC2xn0Ia2JehJEkKJVD75396zngbG01YTcJgEpgrh8rNEEmVth/C8gnsdCQze0TsewuPfW7B4C9jF9OdvupqVIBm186MQvj527QKVDBKniQJpgzM9CLIDkypkdsfOJ5MxuYTsaz5fJ4MMqna9LJpvWGAqXpLUKATaZEIqFgkz1JTIlYInEUM2AI0kiKPqTPezq9hBNRdkRB58nU8JmBuNFfi5A6dLjGS/NtEdLP4dmku0j2KQKCZMWWt3cqWXL0f58AhNlpjHkWtIESjQ==',
  clientProof: 'v9SCfFwynvInjVvILFnHuxJuKj9QzADD+CL00NAQ3NZFv8tgwRgNXFerLOFovSMSfNxHsK6BnO5CHxsBBuK1g3tokZGVdvntpcqb0OVesgxVUxrBT3gc4LnrB1I5cNYD9a9lPrn/rb0dGiVN9jB5N0kYkQd9drSFfHlhSosqSPmYdhx1/fHr8Bx+0Ow3BPcN+WWfS+cGWFcwtD1eXG81gtOD6oU6RB2XYfexDZtVCB7/bTj3YdQW+1VVOw43N4V+XRl5mX3juqVPo1yh6WtE/lVUNzoHvVdXLRcBcgMWuoqLUTnDfpUlHEW/GYTBkHvWi7PdY9Sn+oUqf8XpeVyHWQ==',
  expectedServerProof: 'gs4o+tLguQDhOLMuIcBhHkUctUnzZaQDIipVQueh6zb8xKt20gnl19o7mryEMnYncbuN/MEAh6VZFSSORydveiL3Hb0Oelhd785yH5KmHlPaNg1Ug0pxdu9Hfjlt3qoJwx0gmQaOZVZ3EDkXTLqDIw4XWOsW/HJA/NSu5sVcoNycFdYPZVjDidNfKihZ9/b/APy9GFEKSQ6ctYr1AR5fGwiLkD1qusTmQHruXtQddYCsdW2AX0GK+ZoN8aB1cm8/VBaxBKIvaEMdLgUvlbwBEGHJ/z3F+/E/A+x44rqpOxRW2P6Jr8kaT+3rROeZL1gJ/ZACNKCEiNIDxdxgKJKd2w==',
};

/** 256-byte little-endian test modulus; the last byte keeps it 2048 bits wide. */
function testModulus(): Uint8Array {
  const modulus = new Uint8Array(256);
  modulus[0] = 0x07;
  modulus[255] = 0xff;
  return modulus;
}

function testServerEphemeral(): string {
  const ephemeral = new Uint8Array(256);
  ephemeral[0] = 0x42;
  ephemeral[255] = 0x80;
  return Buffer.from(ephemeral).toString('base64');
}

/** Deterministic client secret: the vector was recorded with the same pattern. */
function mockRandomValues(): jest.SpyInstance {
  return jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    for (let i = 0; i < array.length; i++) array[i] = (i * 7 + 3) & 0xff;
    return array;
  }) as any);
}

describe('SRPModuleAdapter', () => {
  let adapter: SRPModuleAdapter;
  const getAuthModulus = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    verifyAndGetModulus.mockResolvedValue(testModulus());
    adapter = new SRPModuleAdapter({ getAuthModulus } as unknown as UserApiClient);
  });

  describe('computeKeyPassword', () => {
    it.each(KEY_PASSWORD_VECTORS)('derives the same key passphrase as before for %j', async (password, salt, expected) => {
      const result = await adapter.computeKeyPassword(password, salt);
      expect(result).toBe(expected);
      expect(result).toHaveLength(31); // bcrypt hash portion
    });

    it('produces different results for different passwords and salts', async () => {
      const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
      expect(await adapter.computeKeyPassword('password1', salt)).not.toBe(await adapter.computeKeyPassword('password2', salt));
      expect(await adapter.computeKeyPassword('testpassword', salt))
        .not.toBe(await adapter.computeKeyPassword('testpassword', 'AQEBAQEBAQEBAQEBAQEBAQ=='));
    });
  });

  describe('generateKeySalt', () => {
    it('returns 16 random bytes as base64', () => {
      const salt = adapter.generateKeySalt();
      expect(salt).toHaveLength(24);
      expect(Buffer.from(salt, 'base64')).toHaveLength(16);
      expect(adapter.generateKeySalt()).not.toBe(salt);
    });
  });

  describe('getSrp', () => {
    it('computes the same version-4 proofs as the previous implementation', async () => {
      const randomSpy = mockRandomValues();
      try {
        const result = await adapter.getSrp(
          4,
          'signed-modulus',
          testServerEphemeral(),
          Buffer.from('test-salt-value').toString('base64'),
          'testpassword',
        );

        expect(result).toEqual(SRP_VECTOR);
        expect(Buffer.from(result.clientEphemeral, 'base64')).toHaveLength(256);
        expect(Buffer.from(result.clientProof, 'base64')).toHaveLength(256);
        expect(Buffer.from(result.expectedServerProof, 'base64')).toHaveLength(256);
        expect(verifyAndGetModulus).toHaveBeenCalledWith('signed-modulus');
      } finally {
        randomSpy.mockRestore();
      }
    }, 30_000);

    it('does not expose the shared session', async () => {
      const result = await adapter.getSrp(4, 'm', testServerEphemeral(), Buffer.from('sixteen-byte-salt').toString('base64'), 'pw');
      expect(Object.keys(result).sort()).toEqual(['clientEphemeral', 'clientProof', 'expectedServerProof']);
    }, 30_000);

    it('rejects a username mismatch for auth version 2 (library contract)', async () => {
      await expect(getSrp(
        { Version: 2, Modulus: 'm', ServerEphemeral: testServerEphemeral(), Salt: Buffer.from('salt').toString('base64'), Username: 'serveruser' },
        { username: 'differentuser', password: 'pass' },
      )).rejects.toThrow(/ProtonMail username/);
    });
  });

  describe('getSrpVerifier', () => {
    it('fetches the signed modulus and derives a random verifier', async () => {
      getAuthModulus.mockResolvedValue({ Modulus: 'signed-modulus', ModulusID: 'modulus-id' });

      const result = await adapter.getSrpVerifier('password');

      expect(result.modulusId).toBe('modulus-id');
      expect(result.version).toBe(4);
      expect(Buffer.from(result.salt, 'base64')).toHaveLength(10);
      expect(Buffer.from(result.verifier, 'base64')).toHaveLength(256);
      expect(verifyAndGetModulus).toHaveBeenCalledWith('signed-modulus');
    }, 30_000);
  });
});
