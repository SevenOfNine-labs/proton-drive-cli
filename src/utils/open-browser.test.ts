import { EventEmitter } from 'events';

interface FakeLauncher extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

const mockOpen = jest.fn();
jest.mock('open', () => ({ __esModule: true, default: (...args: unknown[]) => mockOpen(...args) }));

import { openBrowserUrl } from './open-browser';

const SIGN_IN_URL = 'https://account.proton.me/desktop/login?app=drive&pv=3#payload=0%3AAB%3Aexternal-drive';

function launcher(exitCode: number | null = null, signalCode: NodeJS.Signals | null = null): FakeLauncher {
  return Object.assign(new EventEmitter(), { exitCode, signalCode });
}

describe('openBrowserUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hands the whole URL, query and fragment included, to open', async () => {
    mockOpen.mockResolvedValue(launcher(0));

    await expect(openBrowserUrl(SIGN_IN_URL)).resolves.toBe(true);
    expect(mockOpen).toHaveBeenCalledWith(SIGN_IN_URL);
  });

  it('reports the exit status of a launcher open already waited for, as for PowerShell on Windows and WSL', async () => {
    mockOpen.mockResolvedValueOnce(launcher(1));
    await expect(openBrowserUrl(SIGN_IN_URL)).resolves.toBe(false);

    mockOpen.mockResolvedValueOnce(launcher(null, 'SIGKILL'));
    await expect(openBrowserUrl(SIGN_IN_URL)).resolves.toBe(false);
  });

  it('waits for a running launcher and reports a failing xdg-open as not opened', async () => {
    const running = launcher();
    mockOpen.mockResolvedValue(running);

    const opened = openBrowserUrl(SIGN_IN_URL);
    await new Promise(setImmediate);
    running.emit('exit', 3);

    await expect(opened).resolves.toBe(false);
  });

  it('reports a launcher still running after five seconds as opened, and not before', async () => {
    jest.useFakeTimers();
    mockOpen.mockResolvedValue(launcher());
    let settled: boolean | undefined;

    const opened = openBrowserUrl(SIGN_IN_URL).then((value) => {
      settled = value;
      return value;
    });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);

    await expect(opened).resolves.toBe(true);
  });

  it('settles after five seconds while open itself has not resolved, as with a PowerShell that hangs', async () => {
    jest.useFakeTimers();
    mockOpen.mockReturnValue(new Promise(() => undefined));

    const opened = openBrowserUrl(SIGN_IN_URL);
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(opened).resolves.toBe(true);
  });

  it('reports a launcher that cannot be started, also when open throws synchronously', async () => {
    mockOpen.mockRejectedValueOnce(Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));
    await expect(openBrowserUrl(SIGN_IN_URL)).resolves.toBe(false);

    mockOpen.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn ELOOP'), { code: 'ELOOP' });
    });
    await expect(openBrowserUrl(SIGN_IN_URL)).resolves.toBe(false);
  });

  it('rejects non-http URLs without starting a launcher', async () => {
    await expect(openBrowserUrl('javascript:alert(1)')).resolves.toBe(false);
    await expect(openBrowserUrl('not a url')).resolves.toBe(false);

    expect(mockOpen).not.toHaveBeenCalled();
  });
});
