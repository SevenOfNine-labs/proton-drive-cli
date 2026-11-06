/** OpenPGP crypto endpoint for the Proton Drive SDK (`@protontech/crypto` Api). */

import '../crypto/polyfill';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';

// Proton's OpenPGP configuration (accepted algorithms, S2K parameters, no
// SEIPDv2 messages); idempotent.
CryptoApi.init({});

let sharedKeyStore: unknown;

function adoptSharedKeyStore<T>(candidate: T): T {
  if (sharedKeyStore === undefined) {
    sharedKeyStore = candidate;
  }
  return sharedKeyStore as T;
}

/**
 * The SDK's OpenPGPCryptoWithCryptoProxy consumes `@protontech/crypto`'s
 * CryptoApiInterface, whose reference implementation is that package's `Api`
 * endpoint (the SDK pairs the two in its own integration tests,
 * src/integration-tests/nodesCrypto.test.ts). Extending it gives the SDK
 * Proton's exact OpenPGP behaviour: signature contexts as the critical
 * `context@proton.ch` notation and their verification, verification that
 * accepts any valid signature and reports every failure, detached signing
 * without an inline signature, key compatibility checks, and the config the
 * SDK passes per call (`ignoreSEIPDv2FeatureFlag`, `aeadProtect`).
 *
 * Every operation is dated with the Proton server clock: pmcrypto defaults
 * `date` to its server time (plus its verification tolerance), which
 * utils/server-time.ts keeps in sync with the API responses.
 *
 * All instances share one key store, as Proton's per-process CryptoProxy
 * does: a key reference minted by the account adapter must be valid in the
 * endpoint instance the SDK calls, whichever instance that is.
 */
export class ProtonOpenPGPCryptoProxy extends CryptoApi {
  constructor() {
    super();
    this.keyStore = adoptSharedKeyStore(this.keyStore);
  }
}
