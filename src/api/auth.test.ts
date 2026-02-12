import { HttpClient } from './http-client';
import { AuthApiClient } from './auth';
import { CaptchaError } from '../errors/types';

jest.mock('./http-client');
const MockedHttpClient = HttpClient as jest.Mocked<typeof HttpClient>;

describe('AuthApiClient', () => {
  let client: AuthApiClient;
  let mockPost: jest.Mock;
  let mockDelete: jest.Mock;

  beforeEach(() => {
    mockPost = jest.fn();
    mockDelete = jest.fn();
    MockedHttpClient.create = jest.fn().mockReturnValue({
      post: mockPost,
      delete: mockDelete,
      interceptors: { request: { use: jest.fn(), _handlers: [] }, response: { use: jest.fn(), _handlers: [] } },
    } as any);

    client = new AuthApiClient('https://test-api.proton.me');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getAuthInfo', () => {
    test('sends username to /auth/v4/info', async () => {
      const mockResponse = {
        Modulus: 'base64-modulus',
        ServerEphemeral: 'base64-ephemeral',
        Version: 4,
        Salt: 'base64-salt',
        SRPSession: 'session-123',
      };
      mockPost.mockResolvedValue({ data: mockResponse });

      const result = await client.getAuthInfo('user@proton.me');

      expect(mockPost).toHaveBeenCalledWith(
        '/auth/v4/info',
        { Username: 'user@proton.me' },
        { headers: {} }
      );
      expect(result).toEqual(mockResponse);
    });

    test('includes CAPTCHA headers when token provided', async () => {
      mockPost.mockResolvedValue({ data: {} });

      await client.getAuthInfo('user@proton.me', 'captcha-token-abc');

      expect(mockPost).toHaveBeenCalledWith(
        '/auth/v4/info',
        { Username: 'user@proton.me' },
        {
          headers: {
            'X-PM-Human-Verification-Token-Type': 'captcha',
            'X-PM-Human-Verification-Token': 'captcha-token-abc',
          },
        }
      );
    });

    test('throws CAPTCHA error with metadata on code 9001', async () => {
      mockPost.mockRejectedValue({
        response: {
          data: {
            Code: 9001,
            Details: {
              WebUrl: 'https://verify.proton.me',
              HumanVerificationToken: 'hvt-123',
              HumanVerificationMethods: ['captcha'],
            },
          },
        },
      });

      try {
        await client.getAuthInfo('user@proton.me');
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(CaptchaError);
        expect(error.message).toBe('CAPTCHA verification required');
        expect(error.captchaUrl).toBe('https://verify.proton.me');
        expect(error.captchaToken).toBe('hvt-123');
        expect(error.verificationMethods).toEqual(['captcha']);
      }
    });

    test('rethrows non-CAPTCHA errors', async () => {
      const apiError = new Error('Network Error');
      (apiError as any).response = {
        status: 500,
        data: { Code: 1000, Error: 'Internal Server Error' },
      };
      mockPost.mockRejectedValue(apiError);

      await expect(client.getAuthInfo('user@proton.me'))
        .rejects.toThrow('Network Error');
    });
  });

  describe('authenticate', () => {
    test('sends SRP proof to /auth/v4', async () => {
      const mockResponse = {
        UID: 'uid-abc',
        AccessToken: 'access-token',
        RefreshToken: 'refresh-token',
        TokenType: 'Bearer',
        Scopes: ['full'],
        ServerProof: 'proof',
        PasswordMode: 1,
        '2FA': { Enabled: 0, FIDO2: { RegisteredKeys: [] }, TOTP: 0 },
      };
      mockPost.mockResolvedValue({ data: mockResponse });

      const result = await client.authenticate(
        'user@proton.me',
        'client-ephemeral',
        'client-proof',
        'srp-session-123'
      );

      expect(mockPost).toHaveBeenCalledWith(
        '/auth/v4',
        {
          Username: 'user@proton.me',
          ClientEphemeral: 'client-ephemeral',
          ClientProof: 'client-proof',
          SRPSession: 'srp-session-123',
        },
        { headers: {} }
      );
      expect(result.UID).toBe('uid-abc');
      expect(result.AccessToken).toBe('access-token');
    });

    test('includes CAPTCHA headers when token provided', async () => {
      mockPost.mockResolvedValue({ data: {
        UID: 'u', AccessToken: 'a', RefreshToken: 'r', ServerProof: 's',
        Scopes: [], PasswordMode: 1, TokenType: 'Bearer',
        '2FA': { Enabled: 0, FIDO2: { RegisteredKeys: [] }, TOTP: 0 },
      } });

      await client.authenticate('user', 'eph', 'proof', 'session', 'captcha-xyz');

      expect(mockPost).toHaveBeenCalledWith(
        '/auth/v4',
        expect.any(Object),
        {
          headers: {
            'X-PM-Human-Verification-Token-Type': 'captcha',
            'X-PM-Human-Verification-Token': 'captcha-xyz',
          },
        }
      );
    });

    test('throws CAPTCHA error on code 9001', async () => {
      mockPost.mockRejectedValue({
        response: {
          data: {
            Code: 9001,
            Details: {
              WebUrl: 'https://verify.proton.me',
              HumanVerificationToken: 'hvt',
              HumanVerificationMethods: ['captcha'],
            },
          },
        },
      });

      try {
        await client.authenticate('user', 'eph', 'proof', 'session');
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(CaptchaError);
      }
    });
  });

  describe('refreshToken', () => {
    test('sends refresh request with correct headers', async () => {
      mockPost.mockResolvedValue({
        data: { AccessToken: 'new-access', RefreshToken: 'new-refresh' },
      });

      const result = await client.refreshToken('uid-123', 'refresh-token-old');

      expect(mockPost).toHaveBeenCalledWith(
        '/auth/v4/refresh',
        {
          UID: 'uid-123',
          RefreshToken: 'refresh-token-old',
          ResponseType: 'token',
          GrantType: 'refresh_token',
          RedirectURI: 'http://proton.me',
        },
        { headers: { 'x-pm-uid': 'uid-123' } }
      );
      expect(result.AccessToken).toBe('new-access');
      expect(result.RefreshToken).toBe('new-refresh');
    });
  });

  describe('logout', () => {
    test('sends DELETE to /auth/v4 with bearer token', async () => {
      mockDelete.mockResolvedValue({});

      await client.logout('my-access-token');

      expect(mockDelete).toHaveBeenCalledWith('/auth/v4', {
        headers: { Authorization: 'Bearer my-access-token' },
      });
    });
  });
});
