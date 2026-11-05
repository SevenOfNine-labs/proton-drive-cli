import { HTTPClientAdapter } from './httpClientAdapter';
import { SessionManager } from '../auth/session';
import { RateLimitError } from '../errors/types';
import { DEFAULT_PROTON_APP_VERSION, VENDORED_DRIVE_SDK_VERSION } from '../constants';
import { isServerTimeSynced, resetServerTime, serverTime } from '../utils/server-time';
import { logger } from '../utils/logger';

// Mock dependencies
jest.mock('../auth/session');
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
    (SessionManager.refreshSession as jest.Mock).mockResolvedValue({
      ...fakeSession,
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    (SessionManager.assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
    (SessionManager.recordRateLimitCooldown as jest.Mock).mockResolvedValue({
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
      (SessionManager.assertNotRateLimited as jest.Mock).mockRejectedValue(
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
      (SessionManager.recordRateLimitCooldown as jest.Mock).mockResolvedValue({
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

      expect(SessionManager.recordRateLimitCooldown).toHaveBeenCalledWith({
        retryAfter: 120,
        message: 'Rate limit exceeded (HTTP 429)',
      });
      expect(SessionManager.refreshSession).not.toHaveBeenCalled();
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

      expect(SessionManager.recordRateLimitCooldown).toHaveBeenCalledWith({
        protonCode: 2028,
        message: 'Too many recent attempts',
      });
      expect(SessionManager.refreshSession).not.toHaveBeenCalled();
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
      expect(SessionManager.refreshSession).toHaveBeenCalledWith(
        fakeSession,
        DEFAULT_PROTON_APP_VERSION
      );
    });

    it('returns original 401 if refresh fails', async () => {
      mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

      (SessionManager.refreshSession as jest.Mock).mockRejectedValue(new Error('Refresh failed'));

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

      const refreshMock = (SessionManager.refreshSession as jest.Mock).mockResolvedValue({
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
      expect(SessionManager.refreshSession).not.toHaveBeenCalled();
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
      expect(SessionManager.refreshSession).not.toHaveBeenCalled();
    });

    it('refreshes on error code 10013 (invalid access token)', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Code: 10013, Error: 'Invalid access token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(new Response('{"Code": 1000}', { status: 200 }));

      (SessionManager.refreshSession as jest.Mock).mockResolvedValue({
        ...fakeSession,
        accessToken: 'new-token',
        refreshToken: 'new-refresh',
      });

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
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


describe('HTTPClientAdapter server time', () => {
  let adapter: HTTPClientAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    resetServerTime();
    adapter = new HTTPClientAdapter();
    (SessionManager.getValidSession as jest.Mock).mockResolvedValue(null);
    (SessionManager.assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
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
    (SessionManager.assertNotRateLimited as jest.Mock).mockResolvedValue(undefined);
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
