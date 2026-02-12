/**
 * Minimal HTTP client built on native fetch.
 *
 * Replaces axios to eliminate the `url.parse()` deprecation warning
 * from `follow-redirects` (a transitive dep of axios).
 *
 * API surface mirrors the axios subset used by this project:
 *   - HttpClient.create({ baseURL, timeout, headers })
 *   - instance.get<T>(path) → { data: T }
 *   - instance.post<T>(path, body?, config?) → { data: T }
 *   - instance.delete(path, config?) → { data: any }
 *   - instance.interceptors.request.use(fn)
 *   - instance.interceptors.response.use(onFulfilled, onRejected)
 *   - isHttpClientError(err) type guard
 */

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

type RequestInterceptor = (config: RequestConfig & { headers: Record<string, string> }) =>
    Promise<RequestConfig & { headers: Record<string, string> }> |
    (RequestConfig & { headers: Record<string, string> });

type ResponseErrorInterceptor = (error: any) => Promise<any>;

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
     * Execute a request. Can be called with explicit args or with a
     * single config object (for interceptor retries).
     */
    async request<T = any>(
        methodOrConfig: string | RequestConfig,
        path?: string,
        body?: any,
        config?: RequestConfig,
    ): Promise<HttpResponse<T>> {
        // Support retry via config object: this.client.request(originalConfig)
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

        // Build merged config
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

        // Run request interceptors
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        try {
            const fetchOptions: RequestInit = {
                method,
                headers: mergedConfig.headers,
                signal: controller.signal,
            };

            if (body !== undefined) {
                fetchOptions.body = JSON.stringify(body);
            }

            const res = await fetch(url, fetchOptions);
            clearTimeout(timer);

            // Parse response headers
            const responseHeaders: Record<string, string> = {};
            res.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });

            // Parse body (handle empty responses)
            let data: any;
            const contentType = res.headers.get('content-type') || '';
            const text = await res.text();
            if (text && contentType.includes('application/json')) {
                data = JSON.parse(text);
            } else if (text) {
                try { data = JSON.parse(text); } catch { data = text; }
            } else {
                data = null;
            }

            if (!res.ok) {
                const error = new HttpClientError(
                    `Request failed with status ${res.status}`,
                    {
                        response: {
                            data,
                            status: res.status,
                            headers: responseHeaders,
                            config: mergedConfig,
                        },
                    }
                );

                // Run response error interceptors
                let handled: any = error;
                for (const handler of this.interceptors.response._handlers) {
                    if (handler.rejected) {
                        try {
                            handled = await handler.rejected(handled);
                            // If interceptor resolved (returned a value), treat as success
                            return handled;
                        } catch (interceptorErr) {
                            handled = interceptorErr;
                        }
                    }
                }
                throw handled;
            }

            const response: HttpResponse<T> = { data, status: res.status, headers: responseHeaders };

            // Run response success interceptors
            let result: any = response;
            for (const handler of this.interceptors.response._handlers) {
                if (handler.fulfilled) {
                    result = handler.fulfilled(result);
                }
            }

            return result;
        } catch (err: any) {
            clearTimeout(timer);

            // Already an HttpClientError (from !res.ok above) — rethrow
            if (err instanceof HttpClientError) throw err;
            // Already processed by interceptors — rethrow
            if (err instanceof Error && !(err instanceof TypeError) && err.name !== 'AbortError') throw err;

            // Map network/timeout errors
            let code: string | undefined;
            let message = err?.message || 'Network error';
            if (err?.name === 'AbortError') {
                code = 'ECONNABORTED';
                message = 'Request timed out';
            } else if (err?.cause?.code) {
                code = err.cause.code;  // Node.js fetch includes cause with system error code
            }

            const clientError = new HttpClientError(message, { code });

            // Run response error interceptors
            let handled: any = clientError;
            for (const handler of this.interceptors.response._handlers) {
                if (handler.rejected) {
                    try {
                        handled = await handler.rejected(handled);
                        return handled;
                    } catch (interceptorErr) {
                        handled = interceptorErr;
                    }
                }
            }
            throw handled;
        }
    }
}
