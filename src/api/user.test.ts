import { HttpClient } from './http-client';
import { UserApiClient } from './user';
import { SessionManager } from '../auth/session';

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
    test('throws session expired on 401 when refresh fails', async () => {
      new UserApiClient();
      captureInterceptors();
      // Return null session so refresh cannot proceed
      mockedSessionManager.loadSession.mockResolvedValue(null);

      const error = {
        response: {
          status: 401,
          data: {},
          config: { headers: {}, _retried: false },
        },
      };
      await expect(responseInterceptorReject(error)).rejects.toThrow(
        'Session expired'
      );
    });

    test('throws API error with code and message', async () => {
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
    });
  });

  describe('getUser', () => {
    test('calls /core/v4/users and returns User', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({
        data: { Code: 1000, User: { ID: 'user-1', Name: 'Test' } },
      });

      const result = await client.getUser();
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/core/v4/users');
      expect(result.ID).toBe('user-1');
    });
  });

  describe('getAddresses', () => {
    test('calls /core/v4/addresses and returns array', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({
        data: {
          Code: 1000,
          Addresses: [{ ID: 'addr-1', Email: 'user@proton.me' }],
        },
      });

      const result = await client.getAddresses();
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/core/v4/addresses');
      expect(result).toHaveLength(1);
      expect(result[0].Email).toBe('user@proton.me');
    });
  });

  describe('getKeySalts', () => {
    test('calls /core/v4/keys/salts and returns salts', async () => {
      const client = new UserApiClient();
      mockHttpInstance.get.mockResolvedValue({
        data: {
          Code: 1000,
          KeySalts: [{ ID: 'key-1', KeySalt: 'abcdef' }],
        },
      });

      const result = await client.getKeySalts();
      expect(mockHttpInstance.get).toHaveBeenCalledWith('/core/v4/keys/salts');
      expect(result[0].KeySalt).toBe('abcdef');
    });
  });
});
