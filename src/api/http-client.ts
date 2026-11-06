import { assertNotRateLimited, recordRateLimitCooldown } from '../auth/rate-limit';
import { updateServerTimeFromHeaders } from '../utils/server-time';

export interface HttpClientConfig {
    baseURL: string;
    timeout?: number;
    headers?: Record<string, string>;
}

export interface RequestConfig {
    headers?: Record<string, string>;
    /** Internal flag for retry logic */
    _retried?: boolean;
    /** Internal: stored for retry support */
    _method?: string;
    _path?: string;
    _body?: any;
    [key: string]: unknown;
}

export interface HttpResponse<T = any> {
    data: T;
    status: number;
    headers: Record<string, string>;
    /** The request as sent, after the request interceptors. */
    config: RequestConfig;
}

export class HttpClientError extends Error {
    public response?: {
        data: any;
        status: number;
        headers: Record<string, string>;
        config: RequestConfig;
    };
    public code?: string;

    constructor(message: string, options?: {
        response?: HttpClientError['response'];
        code?: string;
    }) {
        super(message);
        this.name = 'HttpClientError';
        this.response = options?.response;
        this.code = options?.code;
    }
}

export function isHttpClientError(error: unknown): error is HttpClientError {
    return error instanceof HttpClientError;
}

export type RequestInterceptor = (config: RequestConfig & { headers: Record<string, string> }) =>
    Promise<RequestConfig & { headers: Record<string, string> }> |
    (RequestConfig & { headers: Record<string, string> });

export type ResponseErrorInterceptor = (error: any) => Promise<any>;

/**
 * Minimal HTTP client on the WHATWG Fetch API (Node.js global `fetch`) with
 * request and response interceptors; a non-2xx response or a network failure
 * rejects with {@link HttpClientError} after the error interceptors ran.
 */
export class HttpClient {
    private baseURL: string;
    private timeout: number;
    private defaultHeaders: Record<string, string>;

    public interceptors = {
        request: {
            _handlers: [] as Array<{ fulfilled: RequestInterceptor; rejected?: (err: any) => any }>,
            use(fulfilled: RequestInterceptor, rejected?: (err: any) => any) {
                this._handlers.push({ fulfilled, rejected });
            },
        },
        response: {
            _handlers: [] as Array<{ fulfilled?: (res: any) => any; rejected?: ResponseErrorInterceptor }>,
            use(fulfilled?: (res: any) => any, rejected?: ResponseErrorInterceptor) {
                this._handlers.push({ fulfilled, rejected });
            },
        },
    };

    private constructor(config: HttpClientConfig) {
        this.baseURL = config.baseURL.replace(/\/$/, '');
        this.timeout = config.timeout ?? 30000;
        this.defaultHeaders = { ...config.headers };
    }

    static create(config: HttpClientConfig): HttpClient {
        return new HttpClient(config);
    }

    async get<T = any>(path: string, config?: RequestConfig): Promise<HttpResponse<T>> {
        return this.request<T>('GET', path, undefined, config);
    }

    async post<T = any>(path: string, body?: any, config?: RequestConfig): Promise<HttpResponse<T>> {
        return this.request<T>('POST', path, body, config);
    }

    async delete<T = any>(path: string, config?: RequestConfig): Promise<HttpResponse<T>> {
        return this.request<T>('DELETE', path, undefined, config);
    }

    /**
     * Execute a request, given as method, path, body and config, or as the
     * config object of an earlier request (interceptor retries).
     */
    async request<T = any>(
        methodOrConfig: string | RequestConfig,
        path?: string,
        body?: any,
        config?: RequestConfig,
    ): Promise<HttpResponse<T>> {
        let method: string;
        if (typeof methodOrConfig === 'object') {
            const retryConfig = methodOrConfig;
            method = retryConfig._method || 'GET';
            path = retryConfig._path || '/';
            body = retryConfig._body;
            config = retryConfig;
        } else {
            method = methodOrConfig;
        }

        let mergedConfig: RequestConfig & { headers: Record<string, string> } = {
            ...config,
            _method: method,
            _path: path,
            _body: body,
            headers: {
                ...this.defaultHeaders,
                ...(config?.headers || {}),
            },
        };

        for (const handler of this.interceptors.request._handlers) {
            try {
                mergedConfig = await handler.fulfilled(mergedConfig);
            } catch (err) {
                if (handler.rejected) {
                    throw await handler.rejected(err);
                }
                throw err;
            }
        }

        const url = `${this.baseURL}${path}`;
        await assertNotRateLimited();

        let res: Response;
        let data: any;
        const responseHeaders: Record<string, string> = {};
        try {
            res = await fetch(url, {
                method,
                headers: mergedConfig.headers,
                // The budget covers the whole exchange, body included: the
                // signal stays armed until the body has been read.
                signal: AbortSignal.timeout(this.timeout),
                ...(body !== undefined && { body: JSON.stringify(body) }),
            });
            updateServerTimeFromHeaders(res.headers);
            res.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });
            data = this.parseBody(await res.text(), res.headers.get('content-type') || '');
        } catch (err: any) {
            if (err instanceof HttpClientError) {
                return this.rejectThroughInterceptors(err);
            }
            let code: string | undefined;
            let message = err?.message || 'Network error';
            if (isAbortError(err)) {
                code = 'ECONNABORTED';
                message = 'Request timed out';
            } else if (err?.cause?.code) {
                // Node.js fetch: the system error code is on `cause` (undici).
                code = err.cause.code;
            }
            return this.rejectThroughInterceptors(new HttpClientError(message, { code }));
        }

        if (!res.ok) {
            const protonCode = data?.Code;
            if (res.status === 429 || protonCode === 2028 || protonCode === 85131) {
                const retryAfterHeader = res.headers.get('retry-after');
                const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
                const cooldown = await recordRateLimitCooldown({
                    retryAfter,
                    protonCode,
                    message: data?.Error,
                });
                const error = new HttpClientError(
                    data?.Error || `Rate limit exceeded (HTTP ${res.status}, Proton Code ${protonCode})`,
                    {
                        response: {
                            data: { ...data, isRateLimit: true },
                            status: res.status,
                            headers: responseHeaders,
                            config: mergedConfig,
                        },
                        code: 'RATE_LIMITED',
                    }
                );
                (error as any).retryAfter = cooldown.retryAfter;
                (error as any).protonCode = protonCode;
                return this.rejectThroughInterceptors(error);
            }

            return this.rejectThroughInterceptors(new HttpClientError(
                `Request failed with status ${res.status}`,
                {
                    response: {
                        data,
                        status: res.status,
                        headers: responseHeaders,
                        config: mergedConfig,
                    },
                }
            ));
        }

        let result: any = { data, status: res.status, headers: responseHeaders, config: mergedConfig };
        for (const handler of this.interceptors.response._handlers) {
            if (handler.fulfilled) {
                result = handler.fulfilled(result);
            }
        }
        return result;
    }

    /**
     * Pass `error` through the response error interceptors: the first one
     * that resolves turns the failure into its result, otherwise the last
     * rejection is thrown.
     */
    private async rejectThroughInterceptors(error: HttpClientError): Promise<any> {
        let handled: any = error;
        for (const handler of this.interceptors.response._handlers) {
            if (handler.rejected) {
                try {
                    return await handler.rejected(handled);
                } catch (interceptorErr) {
                    handled = interceptorErr;
                }
            }
        }
        throw handled;
    }

    /**
     * A response body as JSON when it parses, the raw text otherwise, `null`
     * when empty; a body declared as JSON that does not parse is an HttpClientError.
     */
    private parseBody(text: string, contentType: string): any {
        if (!text) {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            if (contentType.includes('application/json')) {
                throw new HttpClientError(
                    `Malformed JSON response body: ${error instanceof Error ? error.message : String(error)}`,
                    { code: 'EBADJSON' },
                );
            }
            return text;
        }
    }
}

/**
 * `AbortSignal.timeout` rejects with a DOMException named TimeoutError, a
 * caller's signal with one named AbortError; matched by name because a
 * DOMException is not necessarily an `Error` of this realm.
 */
function isAbortError(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'AbortError' || name === 'TimeoutError';
}
