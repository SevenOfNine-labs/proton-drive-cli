/**
 * Stdin credential provider.
 *
 * Reads a password from piped stdin (non-TTY). The username must be
 * supplied via options since stdin only carries the password.
 *
 * Security:
 * - Passwords piped via stdin don't leak through `ps` or /proc/pid/environ
 * - 5-second timeout prevents hanging when nothing is piped
 */

import type { CredentialProvider, Credentials } from './types';

const STDIN_TIMEOUT_MS = 5_000;

/**
 * Read password from stdin pipe.
 * Rejects if stdin is a TTY (nothing piped) or times out after 5 s.
 */
export function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => {
      reject(new Error('Timeout reading password from stdin'));
    }, STDIN_TIMEOUT_MS);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      const trimmed = data.trim();
      if (!trimmed) {
        reject(new Error('No password received from stdin'));
        return;
      }
      resolve(trimmed);
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    process.stdin.resume();
  });
}

export class StdinProvider implements CredentialProvider {
  readonly name = 'stdin' as const;

  async isAvailable(): Promise<boolean> {
    return !process.stdin.isTTY;
  }

  async resolve(options?: { username?: string }): Promise<Credentials> {
    if (!options?.username) {
      throw new Error('StdinProvider requires username in options (stdin only carries password)');
    }
    const password = await readPasswordFromStdin();
    return { username: options.username, password };
  }
}
