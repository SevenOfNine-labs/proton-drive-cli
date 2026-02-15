/**
 * Interactive credential provider.
 *
 * Prompts the user for username and/or password via inquirer when a TTY
 * is available. Falls back gracefully if not in an interactive terminal.
 */

import inquirer from 'inquirer';

import type { CredentialProvider, Credentials } from './types';

export class InteractiveProvider implements CredentialProvider {
  readonly name = 'interactive' as const;

  async isAvailable(): Promise<boolean> {
    return !!process.stdin.isTTY && !!process.stdout.isTTY;
  }

  async resolve(options?: { username?: string }): Promise<Credentials> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Interactive prompts require a TTY');
    }

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: 'Email or username:',
        when: !options?.username,
        validate: (input: string) => input.trim().length > 0 || 'Email or username is required',
      },
      {
        type: 'password',
        name: 'password',
        message: 'Password:',
        mask: '*',
        validate: (input: string) => input.length > 0 || 'Password is required',
      },
    ]);

    return {
      username: options?.username || answers.username,
      password: answers.password,
    };
  }
}
