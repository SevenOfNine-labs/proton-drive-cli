import { HttpClient } from './http-client';
import { User, Address } from '../types/crypto';
import { SessionManager } from '../auth/session';

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

  // In-memory cache populated from disk on first access
  private _cryptoCache: {
    keySalts?: Array<{ ID: string; KeySalt: string | null }>;
    user?: User;
    addresses?: Address[];
  } | null = null;

  constructor(baseUrl: string = 'https://drive-api.proton.me') {
    this.baseUrl = baseUrl;
    this.client = HttpClient.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'x-pm-appversion': 'web-drive@5.2.0',
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
            try {
              const { AuthApiClient } = await import('./auth');
              const authApi = new AuthApiClient();
              try {
                const refreshResult = await authApi.refreshToken(session.uid, session.refreshToken);
                await SessionManager.saveSession({
                  ...session,
                  accessToken: refreshResult.AccessToken,
                  refreshToken: refreshResult.RefreshToken,
                });
              } catch {
                // Refresh token may be consumed by another process — re-read session
                const updated = await SessionManager.loadSession();
                if (!updated || updated.accessToken === session.accessToken) {
                  throw new Error('Session expired and refresh failed. Please login again.');
                }
              }
              // Retry with refreshed token
              const freshSession = await SessionManager.loadSession();
              if (freshSession) {
                originalConfig.headers['Authorization'] = `Bearer ${freshSession.accessToken}`;
                originalConfig.headers['x-pm-uid'] = freshSession.uid;
                return this.client.request(originalConfig);
              }
              throw new Error('Session expired and refresh failed. Please login again.');
            } catch (refreshErr) {
              if (refreshErr instanceof Error && refreshErr.message.includes('Session expired')) {
                throw refreshErr;
              }
              throw new Error('Session expired and refresh failed. Please login again.');
            }
          }

          // Handle other API errors
          if (data?.Error) {
            throw new Error(`API Error (${data.Code}): ${data.Error}`);
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
}
