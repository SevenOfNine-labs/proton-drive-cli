/**
 * SRPModule of the Proton Drive SDK on `@protontech/crypto/srp`, as the official account module
 * does (srp.ts); the SDK uses it for password-derived keys, never for account login.
 */

import '../crypto/polyfill';
import { CryptoProxy } from '@protontech/crypto';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import { UserApiClient } from '../api/user';
import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';

// The SRP helpers verify Proton's signed modulus through the package's
// CryptoProxy singleton (srp/utils/modulus.ts), which the application points
// at its endpoint once per process.
CryptoProxy.setEndpoint(new ProtonOpenPGPCryptoProxy());

export class SRPModuleAdapter {
  constructor(private readonly userApi: UserApiClient = new UserApiClient()) {}

  async getSrp(
    version: number,
    modulus: string,
    serverEphemeral: string,
    salt: string,
    password: string,
  ): Promise<{
    expectedServerProof: string;
    clientProof: string;
    clientEphemeral: string;
  }> {
    const { expectedServerProof, clientProof, clientEphemeral } = await getSrp(
      {
        Version: version,
        Modulus: modulus,
        ServerEphemeral: serverEphemeral,
        Salt: salt,
      },
      { password },
    );
    return { expectedServerProof, clientProof, clientEphemeral };
  }

  async getSrpVerifier(password: string): Promise<{
    modulusId: string;
    version: number;
    salt: string;
    verifier: string;
  }> {
    const { Modulus, ModulusID } = await this.userApi.getAuthModulus();
    const { version, salt, verifier } = await getRandomSrpVerifier({ Modulus }, { password });
    return { modulusId: ModulusID, version, salt, verifier };
  }

  async computeKeyPassword(password: string, salt: string): Promise<string> {
    return computeKeyPassword(password, salt);
  }

  generateKeySalt(): string {
    return generateKeySalt();
  }
}
