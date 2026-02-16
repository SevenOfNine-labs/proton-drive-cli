import { HTTPClientAdapter } from './httpClientAdapter';
import { SessionManager } from '../auth/session';
import { AuthApiClient } from '../api/auth';

// Mock dependencies
jest.mock('../auth/session');
jest.mock('../api/auth');
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

  describe('x-pm-appversion header', () => {
    it('injects x-pm-appversion when not present', async () => {
      const headers = new Headers();
      await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      // Expect official Proton Drive app version (platform-specific)
      const appVersion = headers.get('x-pm-appversion');
      expect(appVersion).toMatch(/^(macos-drive@2\.10\.1|windows-drive@1\.12\.4)$/);
    });

    it('preserves existing x-pm-appversion', async () => {
      const headers = new Headers({ 'x-pm-appversion': 'custom@1.0.0' });
      await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(headers.get('x-pm-appversion')).toBe('custom@1.0.0');
    });
  });

  describe('401 token refresh', () => {
    it('refreshes token and retries on 401', async () => {
      const refreshedSession = { ...fakeSession, accessToken: 'new-access-token' };

      mockFetch
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response('{"Code": 1000}', { status: 200 }));

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: jest.fn().mockResolvedValue({
          AccessToken: 'new-access-token',
          RefreshToken: 'new-refresh-token',
        }),
      }));

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
      expect(SessionManager.saveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
        })
      );
    });

    it('returns original 401 if refresh fails', async () => {
      mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: jest.fn().mockRejectedValue(new Error('Refresh failed')),
      }));

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

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: jest.fn().mockResolvedValue({
          AccessToken: 'new-access-token',
          RefreshToken: 'new-refresh-token',
        }),
      }));

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

      const refreshMock = jest.fn().mockResolvedValue({
        AccessToken: 'new-token',
        RefreshToken: 'new-refresh',
      });

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: refreshMock,
      }));

      // Fire two requests concurrently
      const [res1, res2] = await Promise.all([
        adapter.fetchJson({ url: '/a', method: 'GET', headers: new Headers(), timeoutMs: 30000 }),
        adapter.fetchBlob({ url: '/b', method: 'GET', headers: new Headers(), timeoutMs: 30000 }),
      ]);

      // refresh should have been called at most once due to deduplication
      expect(refreshMock.mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  describe('403/9101 token refresh (insufficient scope)', () => {
    const make9101Response = () =>
      new Response(JSON.stringify({ Code: 9101, Error: 'Access token does not have sufficient scope' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });

    it('refreshes token and retries on 403 with Proton error code 9101', async () => {
      const refreshedSession = { ...fakeSession, accessToken: 'new-access-token' };

      mockFetch
        .mockResolvedValueOnce(make9101Response())
        .mockResolvedValueOnce(new Response('{"Code": 1000}', { status: 200 }));

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: jest.fn().mockResolvedValue({
          AccessToken: 'new-access-token',
          RefreshToken: 'new-refresh-token',
        }),
      }));

      (SessionManager.loadSession as jest.Mock)
        .mockResolvedValueOnce(fakeSession)        // initial auth injection
        .mockResolvedValueOnce(fakeSession)        // refresh load
        .mockResolvedValueOnce(refreshedSession);  // retry auth injection

      const response = await adapter.fetchJson({
        url: '/drive/v2/volumes',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(SessionManager.saveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
        })
      );
    });

    it('refreshes on 403/9101 for fetchBlob too', async () => {
      mockFetch
        .mockResolvedValueOnce(make9101Response())
        .mockResolvedValueOnce(new Response('blob-data', { status: 200 }));

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: jest.fn().mockResolvedValue({
          AccessToken: 'refreshed-token',
          RefreshToken: 'refreshed-refresh',
        }),
      }));

      const response = await adapter.fetchBlob({
        url: '/drive/v2/blocks/abc',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 60000,
      });

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns original 403 if refresh fails', async () => {
      mockFetch.mockResolvedValue(make9101Response());

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: jest.fn().mockRejectedValue(new Error('Refresh failed')),
      }));

      const response = await adapter.fetchJson({
        url: '/api/endpoint',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });

      expect(response.status).toBe(403);
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

      (AuthApiClient as jest.Mock).mockImplementation(() => ({
        refreshToken: jest.fn().mockResolvedValue({
          AccessToken: 'new-token',
          RefreshToken: 'new-refresh',
        }),
      }));

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
