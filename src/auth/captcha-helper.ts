import * as http from 'http';
import * as https from 'https';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';

/**
 * CAPTCHA verification helper
 *
 * Flow:
 * 1. Start a local HTTP server that proxies the Proton CAPTCHA page
 * 2. Inject a script that captures the token via postMessage listener
 * 3. Auto-open the proxy URL in the browser (user sees Proton-branded page)
 * 4. When CAPTCHA is solved, the injected script sends the token to /callback
 * 5. CLI receives the token and retries login
 *
 * Why proxy? verify.proton.me blocks iframe embedding (CSP frame-ancestors).
 * By proxying, we serve the page from localhost with injected token capture.
 * The user sees the real Proton CAPTCHA — they don't interact with localhost.
 */

const CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch HTML from a URL using Node's built-in https module.
 */
function fetchHTML(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
            },
        }, (res) => {
            // Follow redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchHTML(res.headers.location).then(resolve, reject);
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Build a proxied CAPTCHA page: fetch Proton's HTML, inject token capture,
 * rewrite URLs to absolute, strip CSP + SRI so the SPA loads from localhost.
 *
 * The Proton CAPTCHA page is a React SPA that enforces:
 *   - CSP `script-src 'self'` (blocks scripts when origin != verify.proton.me)
 *   - SRI integrity hashes on <script>/<link> (fail cross-origin without CORS)
 *   - Its own `<base href="/">` (relative URLs resolve to localhost, not Proton)
 *
 * We fix all three: strip CSP meta, remove SRI attrs, rewrite the <base> tag.
 */
async function buildProxiedCaptchaPage(captchaUrl: string, callbackPort: number): Promise<string> {
    const proxyUrl = captchaUrl.includes('ForceWebMessaging')
        ? captchaUrl
        : `${captchaUrl}${captchaUrl.includes('?') ? '&' : '?'}ForceWebMessaging=1`;

    let html = await fetchHTML(proxyUrl);
    const baseUrl = new URL(captchaUrl).origin;

    // 1. Remove CSP <meta> tags — they block scripts from loading cross-origin
    html = html.replace(/<meta\s+http-equiv=["']content-security-policy["'][^>]*>/gi, '');

    // 2. Replace existing <base href="/"> with absolute Proton origin
    //    (or inject one if none exists)
    if (/<base\s+href=/i.test(html)) {
        html = html.replace(/<base\s+href=["'][^"']*["'][^>]*>/gi, `<base href="${baseUrl}/">`);
    } else {
        html = html.replace('<head>', `<head><base href="${baseUrl}/">`);
    }

    // 3. Remove integrity + crossorigin attributes from <script> and <link>
    //    SRI fails when the resource origin differs from the page origin
    html = html.replace(/\s+integrity=["'][^"']*["']/gi, '');
    html = html.replace(/\s+crossorigin=["'][^"']*["']/gi, '');
    html = html.replace(/\s+crossorigin(?=[\s>])/gi, '');

    // 4. Rewrite relative src/href to absolute URLs (catches /assets/static/...)
    html = html.replace(/(src|href)=["'](\/[^"']*?)["']/gi, (match, attr, path) => {
        // Don't rewrite data: URIs, anchors, or already-absolute URLs
        if (path.startsWith('//') || path.startsWith('data:')) return match;
        return `${attr}="${baseUrl}${path}"`;
    });

    // 5. Inject trust banner + token capture script before </body>
    const injection = `
<div id="plfs-banner" style="position:fixed;top:0;left:0;right:0;z-index:99999;
    background:#1a1a2e;border-bottom:2px solid #6d4aff;padding:12px 20px;
    font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;
    display:flex;align-items:center;justify-content:center;gap:12px;font-size:14px;">
    <span style="background:#6d4aff;color:white;padding:2px 8px;border-radius:4px;
        font-weight:600;font-size:12px;letter-spacing:0.5px;">PROTON GIT LFS</span>
    <span>This verification page is served by your local CLI tool.
    Complete the CAPTCHA below &mdash; the result is sent directly to your terminal.</span>
</div>
<div style="height:52px;"></div>
<script>
(function() {
    var tokenSent = false;
    function captureToken(token) {
        if (tokenSent) return;
        tokenSent = true;
        fetch('http://localhost:${callbackPort}/callback?token=' + encodeURIComponent(token))
            .then(function() {
                document.getElementById('plfs-banner').innerHTML =
                    '<span style="color:#4caf50;font-size:16px;">&#10003; Verification complete! You can close this tab.</span>';
                document.getElementById('plfs-banner').style.borderColor = '#4caf50';
            });
    }
    window.addEventListener('message', function(e) {
        if (e.data && typeof e.data === 'string' && e.data.length > 10) {
            captureToken(e.data);
        }
        if (e.data && typeof e.data === 'object' && e.data.token) {
            captureToken(e.data.token);
        }
    });
})();
</script>`;

    html = html.replace('</body>', injection + '</body>');

    return html;
}

/**
 * Open a URL in the system default browser.
 * Silently fails if no browser is available.
 */
function openInBrowser(url: string): void {
    try {
        const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
        execSync(`${cmd} ${JSON.stringify(url)}`, { stdio: 'ignore' });
    } catch {
        // Non-fatal — fallback URL is printed to the terminal
    }
}

/**
 * Drain any pending input from a TTY stream.
 */
async function drainTTYInput(ttyStream: import('tty').ReadStream): Promise<void> {
    return new Promise((resolve) => {
        const drainTimeout = setTimeout(() => {
            ttyStream.removeAllListeners('data');
            ttyStream.pause();
            resolve();
        }, 10);

        let dataReceived = false;
        ttyStream.on('data', () => {
            dataReceived = true;
        });

        ttyStream.resume();

        if (!dataReceived) {
            clearTimeout(drainTimeout);
            ttyStream.removeAllListeners('data');
            ttyStream.pause();
            resolve();
        }
    });
}

/**
 * Create a readline interface that works even after stdin has been consumed.
 */
async function createReadlineInterface(): Promise<{ rl: readline.Interface; cleanup: () => void }> {
    if (input.isTTY) {
        return {
            rl: readline.createInterface({ input, output }),
            cleanup: () => {}
        };
    }

    try {
        const ttyFd = fs.openSync('/dev/tty', 'r');
        const ttyInput = new (await import('tty')).ReadStream(ttyFd);
        await drainTTYInput(ttyInput);

        const rl = readline.createInterface({ input: ttyInput, output });

        return {
            rl,
            cleanup: () => { rl.close(); ttyInput.destroy(); }
        };
    } catch {
        return {
            rl: readline.createInterface({ input, output }),
            cleanup: () => {}
        };
    }
}

/**
 * Main CAPTCHA prompt.
 *
 * Starts a local proxy server that serves the Proton CAPTCHA page with
 * injected token capture. Auto-opens the proxy in the browser.
 * The terminal shows the real Proton URL as reference.
 */
export async function promptForToken(captchaUrl: string, _challengeToken: string): Promise<string | null> {
    const captchaServer = await startCaptchaServer(captchaUrl);

    console.log('\n  CAPTCHA verification required by Proton');
    console.log('  ─────────────────────────────────────────');
    console.log('  A verification page is opening in your browser.');
    console.log('  Complete the CAPTCHA and the CLI will continue automatically.\n');
    console.log(`  If the page didn't open, visit:\n    ${captchaUrl}\n`);
    console.log('  Waiting...\n');

    // Auto-open the proxy page (user sees Proton-branded CAPTCHA)
    openInBrowser(`http://localhost:${captchaServer.port}/captcha`);

    try {
        const token = await captchaServer.waitForToken();
        console.log('  Token received. Retrying authentication...\n');
        return token;
    } catch (err: any) {
        logger.debug('CAPTCHA server error:', err.message);

        // Fallback: manual token paste
        console.log('  CAPTCHA verification timed out or the token was not captured.');
        console.log('  You can paste a verification token manually:\n');

        const { rl, cleanup } = await createReadlineInterface();
        try {
            const userInput = await rl.question('  Paste token (or press Enter to cancel) > ');
            const trimmed = userInput.trim();
            return trimmed || null;
        } finally {
            cleanup();
        }
    } finally {
        captchaServer.close();
    }
}

/**
 * Start the CAPTCHA proxy server.
 */
function startCaptchaServer(captchaUrl: string): Promise<{
    port: number;
    waitForToken: () => Promise<string>;
    close: () => void;
}> {
    return new Promise((resolve) => {
        let tokenResolve: (token: string) => void;
        let tokenReject: (err: Error) => void;
        const tokenPromise = new Promise<string>((res, rej) => {
            tokenResolve = res;
            tokenReject = rej;
        });

        let tokenReceived = false;
        let cachedPage: string | null = null;

        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url || '/', 'http://localhost');

            if (url.pathname === '/captcha' || url.pathname === '/') {
                try {
                    // Cache the proxied page for the session
                    if (!cachedPage) {
                        const addr = server.address() as { port: number };
                        cachedPage = await buildProxiedCaptchaPage(captchaUrl, addr.port);
                    }
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store',
                    });
                    res.end(cachedPage);
                } catch (err: any) {
                    logger.debug('Failed to proxy CAPTCHA page:', err.message);
                    // Fallback: redirect to the real URL (token capture won't work)
                    res.writeHead(302, { 'Location': captchaUrl });
                    res.end();
                }
            } else if (url.pathname === '/callback') {
                const token = url.searchParams.get('token');
                res.writeHead(200, {
                    'Content-Type': 'text/plain',
                    'Access-Control-Allow-Origin': '*',
                });
                res.end('OK');
                if (token && !tokenReceived) {
                    tokenReceived = true;
                    tokenResolve!(token);
                }
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        server.listen(0, 'localhost', () => {
            const addr = server.address() as { port: number };
            logger.debug(`CAPTCHA proxy server on port ${addr.port}`);
            resolve({
                port: addr.port,
                waitForToken: () => tokenPromise,
                close: () => { try { server.close(); } catch {} },
            });
        });

        server.on('error', () => {
            server.listen(0, 'localhost', () => {
                const addr = server.address() as { port: number };
                resolve({
                    port: addr.port,
                    waitForToken: () => tokenPromise,
                    close: () => { try { server.close(); } catch {} },
                });
            });
        });

        // Timeout
        setTimeout(() => {
            if (!tokenReceived) {
                tokenReceived = true;
                try { server.close(); } catch {}
                tokenReject!(new Error('CAPTCHA verification timed out'));
            }
        }, CAPTCHA_TIMEOUT_MS);
    });
}
