import { HttpClient } from './http-client';
import { User, Address } from '../types/crypto';
import { SessionManager } from '../auth/session';
import { DRIVE_SDK_VERSION_HEADER, getProtonAppVersion } from '../constants';
import { AppError, RateLimitError } from '../errors/types';
import { toAppError } from '../errors/classify';

/**
 * Proton error codes of GET /core/v4/keys/all meaning that no Proton account
 * owns the address (official account module, accountApi.ts:
 * ADDRESS_MISSING_CODE and DOMAIN_EXTERNAL_CODE map to AddressNotFoundError).
 */
const KEYS_ADDRESS_MISSING_CODE = 33_102;
const KEYS_DOMAIN_EXTERNAL_CODE = 33_103;

/** Public keys of an address as returned by GET /core/v4/keys/all. */
export interface AddressPublicKeys {
  Keys: Array<{ PublicKey: string; Flags?: number }>;
}

/** Response of GET /core/v4/auth/modulus, consumed by SRP verifier generation. */
export interface AuthModulus {
  Modulus: string;
  ModulusID: string;
}

/**
 * Query of GET /core/v4/addresses (official account module, accountApi.ts
 * addresses()).
 */
const ADDRESSES_QUERY = new URLSearchParams({ Page: '0', PageSize: '50' }).toString();

/**
 * Authenticated account API client: user and address records with their
 * keys, public keys of other addresses, and the SRP modulus.
 *
 * getUser and getAddresses serve the crypto-init cache (crypto-cache.json)
 * when it belongs to the current session, so bridge subprocesses share one
 * fetch per CRYPTO_CACHE_TTL_MS.
 */
export class UserApiClient {
  private client: HttpClient;
  private baseUrl: string;
  private readonly appVersion: string;

  /** Cache loaded from disk on first access; `{}` once a load found none. */
  private _cryptoCache: {
    user?: User;
    addresses?: Address[];
  } | null = null;

  /** Session UID each record was fetched under (`x-pm-uid` of its request). */
  private readonly recordUids = new Map<User | Address[], string>();

  constructor(
    baseUrl: string = 'https://drive-api.proton.me',
    appVersion?: string
  ) {
    this.baseUrl = baseUrl;
    this.appVersion = getProtonAppVersion(appVersion);
    this.client = HttpClient.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'x-pm-appversion': this.appVersion,
        'x-pm-drive-sdk-version': DRIVE_SDK_VERSION_HEADER,
      },
    });

    this.client.interceptors.request.use(
      async (config) => {
        const session = await SessionManager.loadSession();
        if (!session) {
          throw new Error('No valid session. Please login first.');
        }
        config.headers['Authorization'] = `Bearer ${session.accessToken}`;
        config.headers['x-pm-uid'] = session.uid;
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // HTTP 401: refresh once with the rejected access token, then retry
    // (official ApiClient refresh hook, apiClient.ts).
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response) {
          const { status, data, config: originalConfig } = error.response;

          if (status === 401 && !originalConfig?._retried) {
            originalConfig._retried = true;
            const rejected = {
              uid: String(originalConfig.headers?.['x-pm-uid'] ?? ''),
              accessToken: bearerToken(originalConfig.headers?.['Authorization']),
            };
            let freshSession;
            try {
              freshSession = await SessionManager.refreshSessionOrAdoptRotated(rejected, this.appVersion);
            } catch (refreshError) {
              throw toAppError(refreshError);
            }
            originalConfig.headers['Authorization'] = `Bearer ${freshSession.accessToken}`;
            originalConfig.headers['x-pm-uid'] = freshSession.uid;
            return this.client.request(originalConfig);
          }

          const classified = toAppError(error);
          if (data?.Error && !(classified instanceof RateLimitError)) {
            throw new AppError(
              `API Error (${data.Code}): ${data.Error}`,
              classified.code,
              { ...classified.details, protonCode: data.Code, status },
              classified.isRecoverable,
            );
          }
          throw classified;
        }
        throw toAppError(error);
      }
    );
  }

  private async loadCacheIfNeeded(): Promise<void> {
    if (this._cryptoCache !== null) return;
    const cache = await SessionManager.loadCryptoCache();
    this._cryptoCache = cache ? { user: cache.user, addresses: cache.addresses } : {};
    if (cache) {
      this.recordUids.set(cache.user, cache.sessionUid);
      this.recordUids.set(cache.addresses, cache.sessionUid);
    }
  }

  /**
   * Store the user and address records in the crypto-init cache when both
   * were fetched under the same session UID. Records served from the cache
   * are not written back, so the cache keeps the time of their fetch and
   * expires CRYPTO_CACHE_TTL_MS after it.
   */
  async saveCryptoCache(user: User, addresses: Address[]): Promise<void> {
    if (this._cryptoCache?.user === user && this._cryptoCache.addresses === addresses) {
      return;
    }
    const uid = this.recordUids.get(user);
    if (uid !== undefined && uid === this.recordUids.get(addresses)) {
      await SessionManager.saveCryptoCache(uid, user, addresses);
    }
  }

  /**
   * Get user information including keys
   * @returns User object with keys
   */
  async getUser(): Promise<User> {
    await this.loadCacheIfNeeded();
    if (this._cryptoCache?.user) return this._cryptoCache.user;

    const response = await this.client.get<{ Code: number; User: User }>('/core/v4/users');
    this.recordUids.set(response.data.User, String(response.config.headers?.['x-pm-uid'] ?? ''));
    return response.data.User;
  }

  /**
   * Get user addresses with keys
   * @returns Array of addresses
   */
  async getAddresses(): Promise<Address[]> {
    await this.loadCacheIfNeeded();
    if (this._cryptoCache?.addresses) return this._cryptoCache.addresses;

    const response = await this.client.get<{ Code: number; Addresses: Address[] }>(
      `/core/v4/addresses?${ADDRESSES_QUERY}`,
    );
    this.recordUids.set(response.data.Addresses, String(response.config.headers?.['x-pm-uid'] ?? ''));
    return response.data.Addresses;
  }

  /**
   * Public keys of a Proton address (GET /core/v4/keys/all, internal
   * addresses only, as the official account module requests them).
   *
   * @returns The address keys, or null when no Proton account owns the email
   */
  async getAddressPublicKeys(email: string): Promise<AddressPublicKeys | null> {
    const query = new URLSearchParams({ Email: email, InternalOnly: '1' });
    try {
      const response = await this.client.get<{ Code: number; Address?: AddressPublicKeys }>(
        `/core/v4/keys/all?${query.toString()}`,
      );
      return response.data.Address ?? null;
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.details?.protonCode === KEYS_ADDRESS_MISSING_CODE ||
          error.details?.protonCode === KEYS_DOMAIN_EXTERNAL_CODE)
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Signed SRP modulus for verifier generation (GET /core/v4/auth/modulus).
   */
  async getAuthModulus(): Promise<AuthModulus> {
    const response = await this.client.get<{ Code: number; Modulus: string; ModulusID: string }>(
      '/core/v4/auth/modulus',
    );
    const { Modulus, ModulusID } = response.data;
    if (!Modulus || !ModulusID) {
      throw new Error('Incomplete auth modulus response');
    }
    return { Modulus, ModulusID };
  }
}

/** Token of an `Authorization: Bearer <token>` header value, or '' when absent. */
function bearerToken(authorization: unknown): string {
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
}
