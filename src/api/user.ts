import { HttpClient } from './http-client';
import { User, Address } from '../types/crypto';
import { SessionManager } from '../auth/session';
import { getProtonAppVersion } from '../constants';
import { AppError, ErrorCode } from '../errors/types';

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
 * User API client for fetching user keys and addresses.
 *
 * Supports an optional crypto-init cache: when present, getKeySalts/getUser/
 * getAddresses return cached data (from a previous subprocess) instead of
 * making API calls. The cache is tied to the session UID and auto-invalidates
 * on re-login.
 */
export class UserApiClient {
  private client: HttpClient;
  private baseUrl: string;
  private readonly appVersion: string;

  // In-memory cache populated from disk on first access
  private _cryptoCache: {
    keySalts?: Array<{ ID: string; KeySalt: string | null }>;
    user?: User;
    addresses?: Address[];
  } | null = null;

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
      },
    });

    // Add request interceptor to include auth token
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

    // Add response interceptor with token refresh on 401
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response) {
          const { status, data, config: originalConfig } = error.response;

          // Handle 401 Unauthorized - try token refresh before giving up
          if (status === 401 && !originalConfig?._retried) {
            originalConfig._retried = true;
            const session = await SessionManager.loadSession();
            if (!session) {
              throw new Error('Session expired and refresh failed. Please login again.');
            }
            let freshSession;
            try {
              freshSession = await SessionManager.refreshSessionOrAdoptRotated(session, this.appVersion);
            } catch {
              throw new Error('Session expired and refresh failed. Please login again.');
            }
            originalConfig.headers['Authorization'] = `Bearer ${freshSession.accessToken}`;
            originalConfig.headers['x-pm-uid'] = freshSession.uid;
            return this.client.request(originalConfig);
          }

          // Handle other API errors
          if (data?.Error) {
            throw new AppError(
              `API Error (${data.Code}): ${data.Error}`,
              ErrorCode.API_ERROR,
              { protonCode: data.Code, status },
            );
          }
        }
        throw error;
      }
    );
  }

  /**
   * Load crypto cache from disk (once per process).
   * Populates in-memory cache for subsequent calls.
   */
  private async loadCacheIfNeeded(): Promise<void> {
    if (this._cryptoCache !== null) return; // Already attempted
    const cache = await SessionManager.loadCryptoCache();
    if (cache) {
      this._cryptoCache = {
        keySalts: cache.keySalts,
        user: cache.user,
        addresses: cache.addresses,
      };
    } else {
      this._cryptoCache = {}; // Mark as attempted (no cache available)
    }
  }

  /**
   * Save current API responses to disk cache.
   * Called after all 3 API calls complete during crypto initialization.
   */
  async saveCryptoCache(
    keySalts: Array<{ ID: string; KeySalt: string | null }>,
    user: User,
    addresses: Address[],
  ): Promise<void> {
    const session = await SessionManager.loadSession();
    if (session) {
      await SessionManager.saveCryptoCache(session.uid, keySalts, user, addresses);
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
    return response.data.User;
  }

  /**
   * Get user addresses with keys
   * @returns Array of addresses
   */
  async getAddresses(): Promise<Address[]> {
    await this.loadCacheIfNeeded();
    if (this._cryptoCache?.addresses) return this._cryptoCache.addresses;

    const response = await this.client.get<{ Code: number; Addresses: Address[] }>('/core/v4/addresses');
    return response.data.Addresses;
  }

  /**
   * Get salts for key decryption
   * @returns Array of key salts
   */
  async getKeySalts(): Promise<Array<{ ID: string; KeySalt: string | null }>> {
    await this.loadCacheIfNeeded();
    if (this._cryptoCache?.keySalts) return this._cryptoCache.keySalts;

    const response = await this.client.get<{
      Code: number;
      KeySalts: Array<{ ID: string; KeySalt: string | null }>;
    }>('/core/v4/keys/salts');
    return response.data.KeySalts;
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
