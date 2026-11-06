import { HttpClient } from './http-client';
import { UserApiClient } from './user';
import { SessionManager } from '../auth/session';
import { DEFAULT_PROTON_APP_VERSION, VENDORED_DRIVE_SDK_VERSION } from '../constants';
import { AppError, ErrorCode, RateLimitError } from '../errors/types';

jest.mock('./http-client');
jest.mock('../auth/session');

const MockedHttpClient = HttpClient as jest.Mocked<typeof HttpClient>;
const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;

let mockHttpInstance: any;
let requestInterceptorFulfill: Function;
let responseInterceptorReject: Function;

const fakeSession = {
  accessToken: 'test-token',
  uid: 'test-uid',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockHttpInstance = {
    interceptors: {
      request: { use: jest.fn(), _handlers: [] },
      response: { use: jest.fn(), _handlers: [] },
    },
    get: jest.fn(),
    request: jest.fn(),
  };
  MockedHttpClient.create = jest.fn().mockReturnValue(mockHttpInstance as any);
  mockedSessionManager.loadSession.mockResolvedValue(fakeSession as any);
  mockedSessionManager.refreshSessionOrAdoptRotated.mockResolvedValue({
    ...fakeSession,
    accessToken: 'new-token',
  } as any);
});

function captureInterceptors() {
  [requestInterceptorFulfill] =
    mockHttpInstance.interceptors.request.use.mock.calls[0];
  [, responseInterceptorReject] =
    mockHttpInstance.interceptors.response.use.mock.calls[0];
}

describe('UserApiClient', () => {
  describe('constructor', () => {
    test('creates HTTP client with correct config', () => {
      new UserApiClient('https://test.example.com');
      expect(MockedHttpClient.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://test.example.com',
          timeout: 30000,
          headers: expect.objectContaining({
            'x-pm-appversion': DEFAULT_PROTON_APP_VERSION,
          }),
        })
      );
    });

    test('sends the vendored SDK version, as the official ApiClient does on every request', () => {
      new UserApiClient('https://test.example.com');
      expect(MockedHttpClient.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-pm-drive-sdk-version': `js@${VENDORED_DRIVE_SDK_VERSION}`,
          }),
        })
      );
    });

    test('allows app version override', () => {
      new UserApiClient('https://test.example.com', 'external-drive-custom@1.0.0');

      expect(MockedHttpClient.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-pm-appversion': 'external-drive-custom@1.0.0',
          }),
        })
      );
    });
  });

  describe('request interceptor', () => {
    test('adds auth headers from session', async () => {
      new UserApiClient();
      captureInterceptors();

      const config = { headers: {} as Record<string, string> };
      const result = await requestInterceptorFulfill(config);

      expect(result.headers['Authorization']).toBe('Bearer test-token');
      expect(result.headers['x-pm-uid']).toBe('test-uid');
    });

    test('throws when no session', async () => {
      new UserApiClient();
      captureInterceptors();
      mockedSessionManager.loadSession.mockResolvedValue(null);

      await expect(
        requestInterceptorFulfill({ headers: {} })
      ).rejects.toThrow('No valid session');
    });
  });

  describe('response interceptor', () => {
    test('refreshes with the rejected access token on 401 and retries the request', async () => {
      new UserApiClient();
      captureInterceptors();

      const originalConfig = { headers: { Authorization: 'Bearer rejected-token', 'x-pm-uid': 'test-uid' }, _retried: false };
      const error = {
        response: {
          status: 401,
          data: {},
          config: originalConfig,
        },
      };

      mockHttpInstance.request.mockResolvedValue({ data: { Code: 1000 } });

      await responseInterceptorReject(error);

      expect(mockedSessionManager.refreshSessionOrAdoptRotated).toHaveBeenCalledWith(
        { uid: 'test-uid', accessToken: 'rejected-token' },
        DEFAULT_PROTON_APP_VERSION
      );
      expect(mockHttpInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer new-token',
            'x-pm-uid': 'test-uid',
          }),
        })
      );
    });

    test('propagates the sign-out of a rejected refresh token', async () => {
      new UserApiClient();
      captureInterceptors();
      const signedOut = new AppError('signed out', ErrorCode.SESSION_EXPIRED, { signedOut: true }, false);
      mockedSessionManager.refreshSessionOrAdoptRotated.mockRejectedValue(signedOut);

      const error = {
        response: {
          status: 401,
          data: {},
          config: { headers: { Authorization: 'Bearer rejected-token' }, _retried: false },
        },
      };
      await expect(responseInterceptorReject(error)).rejects.toBe(signedOut);
    });

    test('keeps the code of a refresh failure a later attempt can overcome', async () => {
      new UserApiClient();
      captureInterceptors();
      const rateLimited = new RateLimitError('Too many requests', { retryAfter: 30, protonCode: 2028 });
      mockedSessionManager.refreshSessionOrAdoptRotated.mockRejectedValue(rateLimited);

      const error = {
        response: {
          status: 401,
          data: {},
          config: { headers: {}, _retried: false },
        },
      };
      await expect(responseInterceptorReject(error)).rejects.toBe(rateLimited);
    });

    test('throws API error with code and message, keeping the Proton code', async () => {
      new UserApiClient();
      captureInterceptors();

      const error = {
        response: {
          status: 422,
          data: { Code: 2000, Error: 'Something went wrong' },
          config: { headers: {} },
        },
      };
      await expect(responseInterceptorReject(error)).rejects.toThrow(
        'API Error (2000): Something went wrong'
      );
      await expect(responseInterceptorReject(error)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { protonCode: 2000, status: 422 },
      });
    });

    test('keeps a rate limit on the user and address endpoints a rate limit', async () => {
      new UserApiClient();
      captureInterceptors();

      const error = {
        response: {
          status: 429,
          headers: { 'retry-after': '30' },
          data: { Code: 2028, Error: 'Too many requests' },
          config: { headers: {} },
        },
      };
      await expect(responseInterceptorReject(error)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 30 });
    });
  });

  describe('getUser', () => {
    test('calls /core/v4/users and returns User', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({
        data: { Code: 1000, User: { ID: 'user-1', Name: 'Test' } },
        config: { headers: { 'x-pm-uid': 'test-uid' } },
      });

      const result = await client.getUser();
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/core/v4/users');
      expect(result.ID).toBe('user-1');
    });
  });

  describe('crypto-init cache', () => {
    const user = { ID: 'user-1', Name: 'Test', Keys: [] } as any;
    const addresses = [{ ID: 'addr-1', Email: 'user@proton.me', Keys: [] }] as any;

    test('does not write back records served from the cache, so their fetch time stays', async () => {
      mockedSessionManager.loadCryptoCache.mockResolvedValue({
        sessionUid: 'test-uid',
        user,
        addresses,
        cachedAt: new Date(0).toISOString(),
      });
      const client = new UserApiClient();

      await client.saveCryptoCache(await client.getUser(), await client.getAddresses());

      expect(mockHttpInstance.get).not.toHaveBeenCalled();
      expect(mockedSessionManager.saveCryptoCache).not.toHaveBeenCalled();
    });

    test('stores records fetched from the API', async () => {
      mockedSessionManager.loadCryptoCache.mockResolvedValue(null);
      mockHttpInstance.get
        .mockResolvedValueOnce({ data: { Code: 1000, User: user }, config: { headers: { 'x-pm-uid': 'test-uid' } } })
        .mockResolvedValueOnce({ data: { Code: 1000, Addresses: addresses }, config: { headers: { 'x-pm-uid': 'test-uid' } } });
      const client = new UserApiClient();

      await client.saveCryptoCache(await client.getUser(), await client.getAddresses());

      expect(mockedSessionManager.saveCryptoCache).toHaveBeenCalledWith('test-uid', user, addresses);
    });

    test('does not store records fetched under different session UIDs', async () => {
      mockedSessionManager.loadCryptoCache.mockResolvedValue(null);
      mockHttpInstance.get
        .mockResolvedValueOnce({ data: { Code: 1000, User: user }, config: { headers: { 'x-pm-uid': 'uid-before-login' } } })
        .mockResolvedValueOnce({ data: { Code: 1000, Addresses: addresses }, config: { headers: { 'x-pm-uid': 'uid-after-login' } } });
      const client = new UserApiClient();

      await client.saveCryptoCache(await client.getUser(), await client.getAddresses());

      expect(mockedSessionManager.saveCryptoCache).not.toHaveBeenCalled();
    });
  });

  describe('getAddresses', () => {
    test('calls /core/v4/addresses with the official paging and returns the array', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({
        data: {
          Code: 1000,
          Addresses: [{ ID: 'addr-1', Email: 'user@proton.me' }],
        },
        config: { headers: { 'x-pm-uid': 'test-uid' } },
      });

      const result = await client.getAddresses();
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/core/v4/addresses?Page=0&PageSize=50');
      expect(result).toHaveLength(1);
      expect(result[0].Email).toBe('user@proton.me');
    });
  });

  describe('getAddressPublicKeys', () => {
    test('queries /core/v4/keys/all for internal keys of the email', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({
        data: { Code: 1000, Address: { Keys: [{ PublicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----', Flags: 3 }] } },
      });

      const result = await client.getAddressPublicKeys('Other@Proton.me');

      expect(mockHttpInstance.get).toHaveBeenCalledWith('/core/v4/keys/all?Email=Other%40Proton.me&InternalOnly=1');
      expect(result?.Keys).toHaveLength(1);
    });

    test.each([33102, 33103])('returns null when Proton reports no account for the address (code %s)', async (code) => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockRejectedValue(
        new AppError(`API Error (${code}): Address not found`, ErrorCode.API_ERROR, { protonCode: code, status: 422 }),
      );

      await expect(client.getAddressPublicKeys('nobody@example.com')).resolves.toBeNull();
    });

    test('propagates other failures', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockRejectedValue(new Error('network down'));

      await expect(client.getAddressPublicKeys('other@proton.me')).rejects.toThrow('network down');
    });
  });

  describe('getAuthModulus', () => {
    test('returns the signed modulus and its ID', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({ data: { Code: 1000, Modulus: 'signed', ModulusID: 'mod-1' } });

      await expect(client.getAuthModulus()).resolves.toEqual({ Modulus: 'signed', ModulusID: 'mod-1' });
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/core/v4/auth/modulus');
    });

    test('rejects an incomplete response', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({ data: { Code: 1000, Modulus: 'signed' } });

      await expect(client.getAuthModulus()).rejects.toThrow('Incomplete auth modulus response');
    });
  });
});
