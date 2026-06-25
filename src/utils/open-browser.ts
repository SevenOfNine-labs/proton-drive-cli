import { spawn } from 'child_process';

export function openBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false;
    }

    const platform = process.platform;
    const command = platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
    const args = platform === 'win32'
      ? ['/c', 'start', '', rawUrl]
      : [rawUrl];

    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
