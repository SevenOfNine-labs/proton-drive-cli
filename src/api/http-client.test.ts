import { HttpClient } from './http-client';
import { SessionManager } from '../auth/session';
import { RateLimitError } from '../errors/types';

jest.mock('../auth/session');

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('HttpClient rate-limit cooldown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (SessionManager.assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
    (SessionManager.recordRateLimitCooldown as jest.Mock).mockResolvedValue({
      cooldownUntil: Date.now() + 60_000,
      retryAfter: 60,
      recordedAt: new Date().toISOString(),
    });
  });

  it('fails fast during persisted cooldown without making a request', async () => {
    (SessionManager.assertNotRateLimited as jest.Mock).mockRejectedValue(
      new RateLimitError('Rate limited by Proton API', { retryAfter: 45 })
    );
    const client = HttpClient.create({ baseURL: 'https://drive-api.proton.me' });

    await expect(client.get('/auth/v4/info')).rejects.toThrow(RateLimitError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records cooldown when HTTP 429 is returned', async () => {
    (SessionManager.recordRateLimitCooldown as jest.Mock).mockResolvedValue({
      cooldownUntil: Date.now() + 90_000,
      retryAfter: 90,
      recordedAt: new Date().toISOString(),
    });
    mockFetch.mockResolvedValue(new Response(
      JSON.stringify({ Code: 2028, Error: 'Too many requests' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '90',
        },
      }
    ));
    const client = HttpClient.create({ baseURL: 'https://drive-api.proton.me' });

    await expect(client.get('/auth/v4/info')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfter: 90,
      protonCode: 2028,
    });

    expect(SessionManager.recordRateLimitCooldown).toHaveBeenCalledWith({
      retryAfter: 90,
      protonCode: 2028,
      message: 'Too many requests',
    });
  });
});
