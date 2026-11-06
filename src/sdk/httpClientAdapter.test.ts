import { HTTPClientAdapter } from './httpClientAdapter';
import { SessionManager } from '../auth/session';
import { assertNotRateLimited, recordRateLimitCooldown } from '../auth/rate-limit';
import { RateLimitError } from '../errors/types';
import { DEFAULT_PROTON_APP_VERSION, VENDORED_DRIVE_SDK_VERSION } from '../constants';
import { isServerTimeSynced, resetServerTime, serverTime } from '../utils/server-time';
import { logger } from '../utils/logger';

// Mock dependencies
jest.mock('../auth/session');
jest.mock('../auth/rate-limit');
jest.mock('../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('HTTPClientAdapter', () => {
  let adapter: HTTPClientAdapter;

  const fakeSession = {
    uid: 'test-uid-123',
    accessToken: 'access-token-abc',
    refreshToken: 'refresh-token-xyz',
    username: 'test@proton.me',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new HTTPClientAdapter();

    // Mock both getValidSession (for auth header injection) and loadSession (for refresh flow)
    (SessionManager.getValidSession as jest.Mock).mockResolvedValue(fakeSession);
    (SessionManager.loadSession as jest.Mock).mockResolvedValue(fakeSession);
    (SessionManager.refreshSessionOrAdoptRotated as jest.Mock).mockResolvedValue({
      ...fakeSession,
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    (assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
    (recordRateLimitCooldown as jest.Mock).mockResolvedValue({
      cooldownUntil: Date.now() + 60_000,
      retryAfter: 60,
      recordedAt: new Date().toISOString(),
    });
    mockFetch.mockResolvedValue(new Response('{"Code": 1000}', { status: 200 }));
  });

  describe('fetchJson', () => {
    it('injects auth headers into the request', async () => {
      const headers = new Headers();
      await adapter.fetchJson({
        url: '/drive/v2/volumes',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(headers.get('Authorization')).toBe('Bearer access-token-abc');
      expect(headers.get('x-pm-uid')).toBe('test-uid-123');
    });

    it('resolves relative URLs to API base', async () => {
      await adapter.fetchJson({
        url: '/drive/v2/volumes',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://drive-api.proton.me/drive/v2/volumes',
        expect.any(Object)
      );
    });

    it('passes through absolute URLs unchanged', async () => {
      await adapter.fetchJson({
        url: 'https://custom.api.com/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.api.com/endpoint',
        expect.any(Object)
      );
    });

    it('sets Content-Type and body for JSON payloads', async () => {
      const headers = new Headers();
      await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'POST',
        headers,
        timeoutMs: 30000,
        json: { key: 'value' },
      });

      expect(headers.get('Content-Type')).toBe('application/json');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'value' }),
        })
      );
    });

    it('skips auth headers when no session exists', async () => {
      (SessionManager.getValidSession as jest.Mock).mockResolvedValue(null);
      const headers = new Headers();

      await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(headers.has('Authorization')).toBe(false);
      expect(headers.has('x-pm-uid')).toBe(false);
    });
  });

  describe('fetchBlob', () => {
    it('injects auth headers and resolves URL', async () => {
      const headers = new Headers();
      await adapter.fetchBlob({
        url: '/drive/v2/blocks/abc',
        method: 'GET',
        headers,
        timeoutMs: 60000,
      });

      expect(headers.get('Authorization')).toBe('Bearer access-token-abc');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://drive-api.proton.me/drive/v2/blocks/abc',
        expect.any(Object)
      );
    });

    it('includes body when provided', async () => {
      const body = new Uint8Array([1, 2, 3]);
      await adapter.fetchBlob({
        url: '/api/upload',
        method: 'PUT',
        headers: new Headers(),
        timeoutMs: 60000,
        body: body as any,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PUT',
          body,
        })
      );
    });
  });

  describe('rate-limit cooldown', () => {
    it('fails fast during persisted cooldown without calling fetch', async () => {
      (assertNotRateLimited as jest.Mock).mockRejectedValue(
        new RateLimitError('Rate limited by Proton API', { retryAfter: 30 })
      );

      await expect(adapter.fetchJson({
        url: '/drive/v2/volumes',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      })).rejects.toThrow(RateLimitError);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('records cooldown on HTTP 429 before throwing', async () => {
      (recordRateLimitCooldown as jest.Mock).mockResolvedValue({
        cooldownUntil: Date.now() + 120_000,
        retryAfter: 120,
        recordedAt: new Date().toISOString(),
      });
      mockFetch.mockResolvedValue(new Response('Too Many Requests', {
        status: 429,
        headers: { 'retry-after': '120' },
      }));

      await expect(adapter.fetchJson({
        url: '/drive/v2/volumes',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      })).rejects.toMatchObject({ retryAfter: 120 });

      expect(recordRateLimitCooldown).toHaveBeenCalledWith({
        retryAfter: 120,
        message: 'Rate limit exceeded (HTTP 429)',
      });
      expect(SessionManager.refreshSessionOrAdoptRotated).not.toHaveBeenCalled();
    });

    it('records cooldown on Proton rate-limit error codes before throwing', async () => {
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify({ Code: 2028, Error: 'Too many recent attempts' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ));

      await expect(adapter.fetchBlob({
        url: '/drive/v2/blocks/abc',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      })).rejects.toMatchObject({
        retryAfter: 60,
        protonCode: 2028,
      });

      expect(recordRateLimitCooldown).toHaveBeenCalledWith({
        protonCode: 2028,
        message: 'Too many recent attempts',
      });
      expect(SessionManager.refreshSessionOrAdoptRotated).not.toHaveBeenCalled();
    });
  });

  describe('x-pm-appversion header', () => {
    it('injects x-pm-appversion when not present', async () => {
      const headers = new Headers();
      await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(headers.get('x-pm-appversion')).toBe(DEFAULT_PROTON_APP_VERSION);
    });

    it('allows constructor app version override', async () => {
      adapter = new HTTPClientAdapter('external-drive-custom@2.0.0');
      const headers = new Headers();
      await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(headers.get('x-pm-appversion')).toBe('external-drive-custom@2.0.0');
    });

    it('reports the pinned SDK release instead of the package.json placeholder', async () => {
      const headers = new Headers({ 'x-pm-drive-sdk-version': 'js@0.0.1' });
      await adapter.fetchJson({
        url: '/drive/v2/volumes',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(headers.get('x-pm-drive-sdk-version')).toBe(`js@${VENDORED_DRIVE_SDK_VERSION}`);
    });

    it('overrides a pre-set x-pm-appversion with the validated identity', async () => {
      const headers = new Headers({ 'x-pm-appversion': 'custom@1.0.0' });
      await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(headers.get('x-pm-appversion')).toBe(DEFAULT_PROTON_APP_VERSION);
    });
  });

  describe('401 token refresh', () => {
    it('refreshes token and retries on 401', async () => {
      const refreshedSession = { ...fakeSession, accessToken: 'new-access-token' };

      mockFetch
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response('{"Code": 1000}', { status: 200 }));

      // Mock getValidSession for auth header injection
      (SessionManager.getValidSession as jest.Mock)
        .mockResolvedValueOnce(fakeSession)   // initial auth injection
        .mockResolvedValueOnce(refreshedSession); // retry auth injection after refresh

      // Mock loadSession for refresh flow
      (SessionManager.loadSession as jest.Mock)
        .mockResolvedValueOnce(fakeSession);   // refresh load

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(SessionManager.refreshSessionOrAdoptRotated).toHaveBeenCalledWith(
        fakeSession,
        DEFAULT_PROTON_APP_VERSION
      );
    });

    it('returns original 401 if refresh fails', async () => {
      mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

      (SessionManager.refreshSessionOrAdoptRotated as jest.Mock).mockRejectedValue(new Error('Refresh failed'));

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(401);
    });

    it('refreshes token on fetchBlob 401', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response('blob-data', { status: 200 }));

      const response = await adapter.fetchBlob({
        url: '/api/download',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 60000,
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent refresh attempts', async () => {
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const refreshMock = (SessionManager.refreshSessionOrAdoptRotated as jest.Mock).mockResolvedValue({
        ...fakeSession,
        accessToken: 'new-token',
        refreshToken: 'new-refresh',
      });

      // Fire two requests concurrently
      const [res1, res2] = await Promise.all([
        adapter.fetchJson({ url: '/a', method: 'GET', headers: new Headers(), timeoutMs: 30000 }),
        adapter.fetchBlob({ url: '/b', method: 'GET', headers: new Headers(), timeoutMs: 30000 }),
      ]);

      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('403/9101 insufficient scope is not refreshable', () => {
    // Official Proton clients only refresh on HTTP 401. A refreshed token
    // keeps the session's scopes, so refreshing on 9101 cannot succeed and
    // would just rotate refresh tokens across concurrent bridge subprocesses.
    const make9101Response = () =>
      new Response(JSON.stringify({ Code: 9101, Error: 'Access token does not have sufficient scope' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });

    it('returns the 403 without refreshing or retrying (fetchJson)', async () => {
      mockFetch.mockResolvedValueOnce(make9101Response());

      const response = await adapter.fetchJson({
        url: '/drive/v2/volumes',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(403);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(SessionManager.refreshSessionOrAdoptRotated).not.toHaveBeenCalled();
      // The body is left intact for the bridge's INSUFFICIENT_SCOPE classification.
      await expect(response.json()).resolves.toMatchObject({ Code: 9101 });
    });

    it('returns the 403 without refreshing or retrying (fetchBlob)', async () => {
      mockFetch.mockResolvedValueOnce(make9101Response());

      const response = await adapter.fetchBlob({
        url: '/drive/v2/blocks/abc',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 60000,
      });

      expect(response.status).toBe(403);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(SessionManager.refreshSessionOrAdoptRotated).not.toHaveBeenCalled();
    });

    it('does NOT refresh on code 10013 (invalid refresh token) unless the status is 401', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ Code: 10013, Error: 'Invalid refresh token' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const response = await adapter.fetchJson({
        url: '/auth/v4/refresh',
        method: 'POST',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(400);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(SessionManager.refreshSessionOrAdoptRotated).not.toHaveBeenCalled();
    });

    it('refreshes on a 401 whatever Proton code it carries', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Code: 10013, Error: 'Invalid access token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(new Response('{"Code": 1000}', { status: 200 }));

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(SessionManager.refreshSessionOrAdoptRotated).toHaveBeenCalledTimes(1);
    });

    it('does NOT refresh on non-auth 403 (e.g. forbidden resource)', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ Code: 2000, Error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(403);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT refresh on 403 with non-JSON body', async () => {
      mockFetch.mockResolvedValue(
        new Response('Forbidden', { status: 403 })
      );

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(403);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT refresh on successful 200 responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('{"Code": 1000}', { status: 200 })
      );

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});


describe('HTTPClientAdapter abort signals', () => {
  let adapter: HTTPClientAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new HTTPClientAdapter();
    (SessionManager.getValidSession as jest.Mock).mockResolvedValue(null);
    (assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
  });

  it('passes an already-aborted SDK signal through to fetch', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by the SDK'));
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
      return new Response('{"Code": 1000}', { status: 200 });
    });

    await expect(adapter.fetchJson({
      url: '/drive/v2/volumes',
      method: 'GET',
      headers: new Headers(),
      timeoutMs: 1000,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts the request when the SDK aborts it later', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response('{"Code": 1000}', { status: 200 });
    });

    await adapter.fetchBlob({ url: '/drive/v2/blocks/abc', method: 'GET', headers: new Headers(), timeoutMs: 1000, signal: controller.signal });

    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('arms a timeout signal when the SDK passes none', async () => {
    let signal: AbortSignal | undefined;
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response('{"Code": 1000}', { status: 200 });
    });

    await adapter.fetchJson({ url: '/drive/v2/volumes', method: 'GET', headers: new Headers(), timeoutMs: 1000 });

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});

describe('HTTPClientAdapter server time', () => {
  let adapter: HTTPClientAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    resetServerTime();
    adapter = new HTTPClientAdapter();
    (SessionManager.getValidSession as jest.Mock).mockResolvedValue(null);
    (assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetServerTime();
  });

  it('learns the server clock from the date header of every response', async () => {
    const serverDate = new Date(Date.now() - 3_600_000);
    mockFetch.mockResolvedValue(
      new Response('{"Code": 1000}', { status: 200, headers: { date: serverDate.toUTCString() } }),
    );

    await adapter.fetchJson({ url: '/drive/v2/volumes', method: 'GET', headers: new Headers(), timeoutMs: 1000 });

    expect(isServerTimeSynced()).toBe(true);
    expect(Math.abs(serverTime().getTime() - serverDate.getTime())).toBeLessThan(2000);
  });

  it('keeps device time when responses carry no date header', async () => {
    mockFetch.mockResolvedValue(new Response('{"Code": 1000}', { status: 200 }));

    await adapter.fetchJson({ url: '/drive/v2/volumes', method: 'GET', headers: new Headers(), timeoutMs: 1000 });

    expect(isServerTimeSynced()).toBe(false);
  });
});


describe('HTTPClientAdapter Drive requirement notices', () => {
  let adapter: HTTPClientAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new HTTPClientAdapter();
    (SessionManager.getValidSession as jest.Mock).mockResolvedValue(null);
    (assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
  });

  const request = () =>
    adapter.fetchJson({ url: '/drive/v2/volumes', method: 'GET', headers: new Headers(), timeoutMs: 1000 });

  it('warns once per process when Proton requires a newer SDK', async () => {
    mockFetch.mockResolvedValue(
      new Response('{"Code": 1000}', {
        status: 200,
        headers: { 'x-pm-drive-platform-requirements': 'required=99.0.0 suggested=99.1.0' },
      }),
    );

    await request();
    await request();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`requires SDK 99.0.0 or newer; this build uses js@${VENDORED_DRIVE_SDK_VERSION}`),
    );
  });

  it('warns about unsupported feature bits', async () => {
    mockFetch.mockResolvedValue(
      new Response('{"Code": 1000}', { status: 200, headers: { 'x-pm-drive-requirements': 'drive=128' } }),
    );

    await request();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('drive feature this build does not support'));
  });

  it('stays silent when requirements are met', async () => {
    mockFetch.mockResolvedValue(
      new Response('{"Code": 1000}', {
        status: 200,
        headers: { 'x-pm-drive-requirements': 'drive=1', 'x-pm-drive-platform-requirements': 'required=0.1.0' },
      }),
    );

    await request();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
