import { StdinProvider, readPasswordFromStdin } from './stdin';

describe('readPasswordFromStdin', () => {
  const originalStdin = process.stdin;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects on timeout', async () => {
    // Mock stdin that never emits data
    jest.useFakeTimers();
    const stdinMock = {
      setEncoding: jest.fn(),
      on: jest.fn(),
      resume: jest.fn(),
      isTTY: false,
    };
    Object.defineProperty(process, 'stdin', { value: stdinMock, writable: true });

    const promise = readPasswordFromStdin();

    jest.advanceTimersByTime(5001);

    await expect(promise).rejects.toThrow('Timeout reading password from stdin');

    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true });
    jest.useRealTimers();
  });
});

describe('StdinProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('isAvailable returns true when stdin is not TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const provider = new StdinProvider();
    expect(await provider.isAvailable()).toBe(true);
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  });

  it('isAvailable returns false when stdin is TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const provider = new StdinProvider();
    expect(await provider.isAvailable()).toBe(false);
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  });

  it('resolve throws if username is not provided', async () => {
    const provider = new StdinProvider();
    await expect(provider.resolve()).rejects.toThrow('StdinProvider requires username');
  });
});
