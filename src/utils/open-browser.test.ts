const mockUnref = jest.fn();
const mockSpawn = jest.fn(() => ({ unref: mockUnref }));

jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

import { openBrowserUrl } from './open-browser';

describe('openBrowserUrl', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('opens http URLs with the platform browser command', () => {
    const opened = openBrowserUrl('https://account.proton.me/desktop/login');

    expect(opened).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith('xdg-open', [
      'https://account.proton.me/desktop/login',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('rejects non-http URLs without spawning a process', () => {
    expect(openBrowserUrl('javascript:alert(1)')).toBe(false);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockUnref).not.toHaveBeenCalled();
  });
});
