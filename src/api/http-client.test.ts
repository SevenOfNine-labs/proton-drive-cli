import { HttpClient, HttpClientError } from './http-client';
import { assertNotRateLimited, recordRateLimitCooldown } from '../auth/rate-limit';
import { RateLimitError } from '../errors/types';

jest.mock('../auth/rate-limit');

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('HttpClient rate-limit cooldown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
    (recordRateLimitCooldown as jest.Mock).mockResolvedValue({
      cooldownUntil: Date.now() + 60_000,
      retryAfter: 60,
      recordedAt: new Date().toISOString(),
    });
  });

  it('fails fast during persisted cooldown without making a request', async () => {
    (assertNotRateLimited as jest.Mock).mockRejectedValue(
      new RateLimitError('Rate limited by Proton API', { retryAfter: 45 })
    );
    const client = HttpClient.create({ baseURL: 'https://drive-api.proton.me' });

    await expect(client.get('/auth/v4/info')).rejects.toThrow(RateLimitError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records cooldown when HTTP 429 is returned', async () => {
    (recordRateLimitCooldown as jest.Mock).mockResolvedValue({
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

    expect(recordRateLimitCooldown).toHaveBeenCalledWith({
      retryAfter: 90,
      protonCode: 2028,
      message: 'Too many requests',
    });
  });
});

describe('HttpClient response handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
  });

  it('reports a malformed JSON body as HttpClientError instead of a bare SyntaxError', async () => {
    mockFetch.mockResolvedValue(new Response('{"Code": 1000', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = HttpClient.create({ baseURL: 'https://drive-api.proton.me' });

    const error = await client.get('/core/v4/users').catch((e) => e);

    expect(error).toBeInstanceOf(HttpClientError);
    expect(error.code).toBe('EBADJSON');
    expect(error.message).toMatch(/Malformed JSON response body/);
  });

  it('returns plain text bodies as text', async () => {
    mockFetch.mockResolvedValue(new Response('pong', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const client = HttpClient.create({ baseURL: 'https://drive-api.proton.me' });

    await expect(client.get('/ping')).resolves.toMatchObject({ data: 'pong', status: 200 });
  });

  it('arms one timeout signal for the whole exchange and maps it to ECONNABORTED', async () => {
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const client = HttpClient.create({ baseURL: 'https://drive-api.proton.me', timeout: 50 });

    await expect(client.get('/slow')).rejects.toMatchObject({ code: 'ECONNABORTED', message: 'Request timed out' });
  });
});
