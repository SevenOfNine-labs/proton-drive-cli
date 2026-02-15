import { InteractiveProvider } from './interactive';

jest.mock('inquirer', () => ({
  prompt: jest.fn(),
}));

import inquirer from 'inquirer';
const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;

describe('InteractiveProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockPrompt.mockReset();
  });

  it('isAvailable returns true when both stdin and stdout are TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const provider = new InteractiveProvider();
    expect(await provider.isAvailable()).toBe(true);

    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('isAvailable returns false when stdin is not TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const provider = new InteractiveProvider();
    expect(await provider.isAvailable()).toBe(false);

    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('resolve prompts for username and password when neither provided', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    mockPrompt.mockResolvedValue({ username: 'user@proton.me', password: 'secret' } as any);

    const provider = new InteractiveProvider();
    const creds = await provider.resolve();

    expect(creds).toEqual({ username: 'user@proton.me', password: 'secret' });
    expect(mockPrompt).toHaveBeenCalledTimes(1);

    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('resolve skips username prompt when username provided in options', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    mockPrompt.mockResolvedValue({ password: 'secret' } as any);

    const provider = new InteractiveProvider();
    const creds = await provider.resolve({ username: 'given@proton.me' });

    expect(creds.username).toBe('given@proton.me');
    expect(creds.password).toBe('secret');

    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('resolve throws when not in TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const provider = new InteractiveProvider();
    await expect(provider.resolve()).rejects.toThrow('Interactive prompts require a TTY');

    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });
});
