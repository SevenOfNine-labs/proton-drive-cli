import type { ChildProcess } from 'child_process';
import open from 'open';

/** A launch still running after this long is taken to have opened the browser, which may run in the foreground. */
const LAUNCHER_SETTLE_MS = 5_000;

/**
 * Open an http(s) URL in the default browser with `open` (sindresorhus/open:
 * open(1) on macOS, an encoded PowerShell `Start` on Windows and on WSL
 * outside SSH sessions and containers, xdg-open(1) otherwise). Resolves true
 * when the launcher exits with status 0 or the launch is still running after
 * {@link LAUNCHER_SETTLE_MS}, false when it cannot be started or fails.
 */
export function openBrowserUrl(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.resolve(false);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => settle(true), LAUNCHER_SETTLE_MS);
    function settle(opened: boolean): void {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(opened);
      }
    }
    let launch: Promise<ChildProcess>;
    try {
      launch = open(url.href);
    } catch {
      settle(false);
      return;
    }
    launch.then(
      (launcher) => {
        if (launcher.exitCode !== null || launcher.signalCode !== null) {
          settle(launcher.exitCode === 0);
        } else {
          launcher.once('exit', (code) => settle(code === 0));
        }
      },
      () => settle(false),
    );
  });
}
