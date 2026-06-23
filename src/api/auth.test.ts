import { HttpClient } from './http-client';
import { AuthApiClient } from './auth';
import { DEFAULT_PROTON_APP_VERSION } from '../constants';

jest.mock('./http-client');
const MockedHttpClient = HttpClient as jest.Mocked<typeof HttpClient>;

describe('AuthApiClient', () => {
  let client: AuthApiClient;
  let mockGet: jest.Mock;
  let mockPost: jest.Mock;
  let mockDelete: jest.Mock;

  beforeEach(() => {
    mockGet = jest.fn();
    mockPost = jest.fn();
    mockDelete = jest.fn();
    MockedHttpClient.create = jest.fn().mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
      interceptors: { request: { use: jest.fn(), _handlers: [] }, response: { use: jest.fn(), _handlers: [] } },
    } as any);

    client = new AuthApiClient('https://test-api.proton.me');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the external app version header by default', () => {
    expect(MockedHttpClient.create).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-pm-appversion': DEFAULT_PROTON_APP_VERSION,
        }),
      })
    );
  });

  it('allows an app version override', () => {
    new AuthApiClient('https://test-api.proton.me', 'external-drive-custom@9.9.9');

    expect(MockedHttpClient.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-pm-appversion': 'external-drive-custom@9.9.9',
        }),
      })
    );
  });

  it('starts Proton browser session-fork login', async () => {
    mockGet.mockResolvedValue({
      data: { Code: 1000, Selector: 'selector-123', UserCode: 'user-code-123' },
    });

    await expect(client.initSessionFork()).resolves.toMatchObject({
      Selector: 'selector-123',
      UserCode: 'user-code-123',
    });
    expect(mockGet).toHaveBeenCalledWith('/auth/v4/sessions/forks');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('polls Proton browser session-fork status', async () => {
    mockGet.mockResolvedValue({
      data: {
        Code: 1000,
        Payload: 'encrypted-payload',
        UID: 'uid-123',
        AccessToken: 'access-token',
        RefreshToken: 'refresh-token',
      },
    });

    await expect(client.getSessionForkStatus('selector/with spaces')).resolves.toMatchObject({
      UID: 'uid-123',
      AccessToken: 'access-token',
    });
    expect(mockGet).toHaveBeenCalledWith('/auth/v4/sessions/forks/selector%2Fwith%20spaces');
  });

  it('refreshes an existing session without account credentials', async () => {
    mockPost.mockResolvedValue({
      data: { AccessToken: 'new-access', RefreshToken: 'new-refresh', ExpiresIn: 3600 },
    });

    await expect(client.refreshToken('uid-123', 'refresh-token')).resolves.toEqual({
      AccessToken: 'new-access',
      RefreshToken: 'new-refresh',
      ExpiresIn: 3600,
    });
    expect(mockPost).toHaveBeenCalledWith(
      '/auth/v4/refresh',
      {
        UID: 'uid-123',
        RefreshToken: 'refresh-token',
        ResponseType: 'token',
        GrantType: 'refresh_token',
        RedirectURI: 'http://proton.me',
      },
      { headers: { 'x-pm-uid': 'uid-123' } },
    );
  });

  it('revokes the active session on logout', async () => {
    mockDelete.mockResolvedValue({ data: {} });

    await client.logout('access-token');

    expect(mockDelete).toHaveBeenCalledWith('/auth/v4', {
      headers: { Authorization: 'Bearer access-token' },
    });
  });

  it('does not expose direct account-password login methods', () => {
    expect('getAuthInfo' in client).toBe(false);
    expect('authenticate' in client).toBe(false);
    expect('complete2FA' in client).toBe(false);
  });
});
