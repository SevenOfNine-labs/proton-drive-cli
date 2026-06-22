/**
 * SRP module adapter for the Proton Drive SDK.
 *
 * Wraps the existing SRPClient.computeHandshake() and deriveKeyPassphrase()
 * to implement the SDK's 3-method SRPModule interface.
 */

import { SRPClient } from '../auth/srp';
import { deriveKeyPassphrase } from '../crypto/key-password';
import { randomBytes } from 'crypto';

// SRPModule interface is defined in the SDK's crypto internals but not
// re-exported from the top-level package. We implement the shape directly.
export class SRPModuleAdapter {
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
    // SRPClient.computeHandshake has different param ordering (username first)
    // but the SDK's SRPModule doesn't pass username — use empty string
    const result = await SRPClient.computeHandshake(
      '', // username (not used in SRP v4 computation itself)
      password,
      salt,
      modulus,
      serverEphemeral,
      version,
    );
    return {
      expectedServerProof: result.expectedServerProof,
      clientProof: result.clientProof,
      clientEphemeral: result.clientEphemeral,
    };
  }

  async getSrpVerifier(
    _password: string,
  ): Promise<{
    modulusId: string;
    version: number;
    salt: string;
    verifier: string;
  }> {
    // SRP verifier generation is used for password changes, not currently needed
    // for the Git LFS bridge. Throw a clear error if the SDK ever calls this.
    throw new Error('getSrpVerifier is not implemented — password change is not supported in this bridge');
  }

  async computeKeyPassword(password: string, salt: string): Promise<string> {
    return deriveKeyPassphrase(password, salt);
  }

  generateKeySalt(): string {
    return randomBytes(16).toString('base64');
  }
}
