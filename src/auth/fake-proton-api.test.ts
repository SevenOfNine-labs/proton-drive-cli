import { AuthApiClient } from '../api/auth';
import { HttpClient } from '../api/http-client';

jest.mock('../api/http-client');
const MockedHttpClient = HttpClient as jest.Mocked<typeof HttpClient>;

describe('fake Proton auth harness', () => {
  let mockGet: jest.Mock;

  beforeEach(() => {
    mockGet = jest.fn();
    MockedHttpClient.create = jest.fn().mockReturnValue({
      get: mockGet,
      post: jest.fn(),
      delete: jest.fn(),
      interceptors: { request: { use: jest.fn(), _handlers: [] }, response: { use: jest.fn(), _handlers: [] } },
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('models browser session-fork instead of direct SRP login', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: { Code: 1000, Selector: 'selector-1', UserCode: 'user-code-1' },
      })
      .mockResolvedValueOnce({
        data: {
          Code: 1000,
          Payload: 'encrypted-payload',
          UID: 'uid-1',
          AccessToken: 'access-token',
          RefreshToken: 'refresh-token',
          Scopes: ['full'],
          PasswordMode: 2,
        },
      });

    const client = new AuthApiClient('https://fake.proton.test');
    await expect(client.initSessionFork()).resolves.toMatchObject({
      Selector: 'selector-1',
      UserCode: 'user-code-1',
    });
    await expect(client.getSessionForkStatus('selector-1')).resolves.toMatchObject({
      UID: 'uid-1',
      AccessToken: 'access-token',
    });

    expect(mockGet).toHaveBeenNthCalledWith(1, '/auth/v4/sessions/forks');
    expect(mockGet).toHaveBeenNthCalledWith(2, '/auth/v4/sessions/forks/selector-1');
  });
});
