/**
 * Offline preflight checks for auth readiness.
 *
 * The doctor command validates local credential/session hygiene without
 * attempting Proton SRP login, token refresh, or any remote API call.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';

import { SessionManager } from '../auth/session';
import { createProvider, normalizeProviderName } from '../credentials';
import type { ProviderName } from '../credentials';
import { PROTON_CREDENTIAL_HOST, PROTON_DATA_CREDENTIAL_HOST } from '../constants';
import { getBridgeAuthState } from './bridge';
import type { BridgeAuthStatePayload } from './bridge';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
  remediation?: string;
}

export interface DoctorOptions {
  credentialProvider?: string;
  credentialHost?: string;
  dataCredentialProvider?: string;
  dataCredentialHost?: string;
  driveCliBin?: string;
  requireDataPassword?: boolean;
  sessionFile?: string;
  strict?: boolean;
  username?: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: Record<DoctorStatus, number>;
  authState: BridgeAuthStatePayload;
  canAttemptTransfer: boolean;
  canAttemptLiveCanary: boolean;
  checks: DoctorCheck[];
}

export const DOCTOR_STATUSES = ['pass', 'warn', 'fail', 'skip'] as const satisfies readonly DoctorStatus[];

export const DOCTOR_REPORT_FIELDS = [
  'ok',
  'summary',
  'authState',
  'canAttemptTransfer',
  'canAttemptLiveCanary',
  'checks',
] as const satisfies readonly (keyof DoctorReport)[];

export const DOCTOR_SUMMARY_FIELDS = DOCTOR_STATUSES;

export const DOCTOR_CHECK_FIELDS = [
  'id',
  'title',
  'status',
  'message',
  'detail',
  'remediation',
] as const satisfies readonly (keyof DoctorCheck)[];

const SECRET_ENV_NAMES = [
  'PROTON_DATA_PASSWORD',
  'PROTON_SECOND_FACTOR_CODE',
];

function defaultDriveCliBin(): string {
  return process.env.PROTON_DRIVE_CLI_BIN?.trim() || process.argv[1] || path.resolve(process.cwd(), 'dist/index.js');
}

function makeCheck(
  id: string,
  title: string,
  status: DoctorStatus,
  message: string,
  extra: Pick<DoctorCheck, 'detail' | 'remediation'> = {},
): DoctorCheck {
  return { id, title, status, message, ...extra };
}

function summarize(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return checks.reduce<Record<DoctorStatus, number>>(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 },
  );
}

function normalizeStoredProvider(providerName: string): ProviderName {
  const normalized = normalizeProviderName(providerName);
  if (normalized === 'stdin' || normalized === 'interactive') {
    throw new Error(`Doctor requires a stored credential provider, got ${providerName}`);
  }
  return normalized;
}

async function checkDriveCliBin(options: DoctorOptions): Promise<DoctorCheck> {
  const cliBin = options.driveCliBin || defaultDriveCliBin();
  const exists = await fs.pathExists(cliBin);
  if (!exists) {
    return makeCheck(
      'drive-cli-bin',
      'proton-drive-cli entry point',
      'fail',
      `Bridge entry point not found: ${cliBin}`,
      { remediation: 'Run yarn build, make build-drive-cli, or pass --drive-cli-bin /path/to/dist/index.js.' },
    );
  }

  return makeCheck(
    'drive-cli-bin',
    'proton-drive-cli entry point',
    'pass',
    `Bridge entry point exists: ${cliBin}`,
  );
}

function checkSecretEnvironment(): DoctorCheck {
  const present = SECRET_ENV_NAMES.filter((name) => Boolean(process.env[name]));
  if (present.length === 0) {
    return makeCheck(
      'secret-env',
      'secret environment variables',
      'pass',
      'No legacy secret environment variables are set.',
    );
  }

  return makeCheck(
    'secret-env',
    'secret environment variables',
    'fail',
    `Legacy secret environment variable(s) set: ${present.join(', ')}`,
    { remediation: 'Unset these variables and use git-credential or pass-cli entries instead.' },
  );
}

async function checkCredential(
  id: string,
  title: string,
  providerName: string,
  host: string,
  username?: string,
): Promise<DoctorCheck> {
  try {
    const normalized = normalizeStoredProvider(providerName);
    const provider = createProvider(normalized, { host });
    const credentials = await provider.resolve({ username });
    return makeCheck(
      id,
      title,
      'pass',
      `Resolved ${normalized} entry for ${credentials.username} at ${host}.`,
    );
  } catch (error) {
    return makeCheck(
      id,
      title,
      'fail',
      error instanceof Error ? error.message : 'Credential provider check failed.',
      { remediation: `Store or verify credentials for host ${host} before attempting SDK transfers.` },
    );
  }
}

async function checkDataCredential(options: DoctorOptions): Promise<DoctorCheck> {
  const providerName = options.dataCredentialProvider?.trim();
  const host = options.dataCredentialHost || PROTON_DATA_CREDENTIAL_HOST;
  if (!providerName) {
    if (options.requireDataPassword) {
      return makeCheck(
        'data-credential',
        'mailbox/data credential',
        'fail',
        'No data credential provider configured for a required mailbox/data password.',
        { remediation: `Store the mailbox/data password under ${host} and pass --data-credential-provider.` },
      );
    }
    return makeCheck(
      'data-credential',
      'mailbox/data credential',
      'skip',
      'No data credential provider configured; this is okay for single-password accounts.',
    );
  }

  return checkCredential(
    'data-credential',
    'mailbox/data credential',
    providerName,
    host,
    options.username,
  );
}

function isValidSessionShape(session: unknown): boolean {
  const candidate = session as Record<string, unknown>;
  return Boolean(
    candidate &&
      typeof candidate === 'object' &&
      candidate.sessionId &&
      candidate.uid &&
      candidate.accessToken &&
      candidate.refreshToken &&
      Array.isArray(candidate.scopes) &&
      typeof candidate.passwordMode === 'number',
  );
}

async function checkSessionFile(options: DoctorOptions): Promise<DoctorCheck> {
  const sessionFile = options.sessionFile || SessionManager.getSessionFilePath();
  const exists = await fs.pathExists(sessionFile);
  if (!exists) {
    return makeCheck(
      'session-file',
      'session file hygiene',
      'warn',
      `No saved session found at ${sessionFile}.`,
      { remediation: 'Run one interactive proton-drive login after offline gates pass.' },
    );
  }

  const stat = await fs.stat(sessionFile);
  const looseBits = stat.mode & 0o077;
  if (looseBits !== 0) {
    return makeCheck(
      'session-file',
      'session file hygiene',
      'fail',
      `Session file permissions are too broad: ${((stat.mode & 0o777)).toString(8)}.`,
      { remediation: `Run chmod 600 ${sessionFile}.` },
    );
  }

  try {
    const session = await fs.readJson(sessionFile);
    if (!isValidSessionShape(session)) {
      return makeCheck(
        'session-file',
        'session file hygiene',
        'fail',
        'Session file exists but does not contain the required token fields.',
        { remediation: 'Move the corrupted session file aside and run interactive proton-drive login after offline gates pass.' },
      );
    }
    if ('mailboxPassword' in session || 'password' in session) {
      return makeCheck(
        'session-file',
        'session file hygiene',
        'fail',
        'Session file contains password-like fields.',
        { remediation: 'Delete the session file, rotate the exposed password, and re-login interactively.' },
      );
    }
    if (session.passwordMode === 2 && !options.dataCredentialProvider && !options.requireDataPassword) {
      return makeCheck(
        'session-file',
        'session file hygiene',
        'warn',
        'Saved session is for a two-password account but no data credential provider is configured.',
        { remediation: 'Configure --data-credential-provider before running transfers.' },
      );
    }
    return makeCheck(
      'session-file',
      'session file hygiene',
      'pass',
      `Session file shape and permissions are safe at ${sessionFile}.`,
    );
  } catch (error) {
    return makeCheck(
      'session-file',
      'session file hygiene',
      'fail',
      error instanceof Error ? `Could not read session file: ${error.message}` : 'Could not read session file.',
      { remediation: 'Fix or remove the session file before attempting transfers.' },
    );
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const credentialProvider = options.credentialProvider || process.env.PROTON_CREDENTIAL_PROVIDER || 'pass-cli';
  const credentialHost = options.credentialHost || PROTON_CREDENTIAL_HOST;
  const dataCredentialProvider = options.dataCredentialProvider || process.env.PROTON_DATA_CREDENTIAL_PROVIDER;
  const dataCredentialHost = options.dataCredentialHost || process.env.PROTON_DATA_CREDENTIAL_HOST || PROTON_DATA_CREDENTIAL_HOST;

  const normalizedOptions: DoctorOptions = {
    ...options,
    credentialProvider,
    credentialHost,
    dataCredentialProvider,
    dataCredentialHost,
  };

  const checks: DoctorCheck[] = [
    await checkDriveCliBin(normalizedOptions),
    checkSecretEnvironment(),
    await checkCredential(
      'login-credential',
      'login credential',
      credentialProvider,
      credentialHost,
      normalizedOptions.username,
    ),
    await checkDataCredential(normalizedOptions),
    await checkSessionFile(normalizedOptions),
  ];

  const summary = summarize(checks);
  const ok = summary.fail === 0 && (!normalizedOptions.strict || summary.warn === 0);
  const authState = await getBridgeAuthState({
    username: normalizedOptions.username,
    credentialProvider,
    dataCredentialProvider,
    dataCredentialHost,
  });
  const canAttemptTransfer = ok && authState.state === 'ready';
  const canAttemptLiveCanary = ok && (
    authState.state === 'ready' ||
    authState.state === 'login_available'
  );
  return {
    ok,
    summary,
    authState,
    canAttemptTransfer,
    canAttemptLiveCanary,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const labels: Record<DoctorStatus, string> = {
    pass: chalk.green('[PASS]'),
    warn: chalk.yellow('[WARN]'),
    fail: chalk.red('[FAIL]'),
    skip: chalk.dim('[SKIP]'),
  };

  const lines = [
    chalk.bold('Proton Drive offline doctor'),
    '',
    ...report.checks.flatMap((check) => {
      const row = `${labels[check.status]} ${check.title}: ${check.message}`;
      if (!check.remediation) return [row];
      return [row, `       ${chalk.dim(check.remediation)}`];
    }),
    '',
    `Auth state: ${report.authState.state}`,
    `Transfer: ${report.canAttemptTransfer ? 'ready' : 'blocked'}`,
    `Live canary: ${report.canAttemptLiveCanary ? 'ready' : 'blocked'}`,
    '',
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skip} skip`,
  ];
  return lines.join('\n');
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Run offline auth/session preflight checks without logging in')
    .option('--credential-provider <type>', 'Stored login credential provider: git-credential or pass-cli', process.env.PROTON_CREDENTIAL_PROVIDER || 'pass-cli')
    .option('--credential-host <host>', 'Login credential host/key', PROTON_CREDENTIAL_HOST)
    .option('--data-credential-provider <type>', 'Optional mailbox/data password credential provider', process.env.PROTON_DATA_CREDENTIAL_PROVIDER)
    .option('--data-credential-host <host>', 'Mailbox/data password credential host/key', process.env.PROTON_DATA_CREDENTIAL_HOST || PROTON_DATA_CREDENTIAL_HOST)
    .option('--require-data-password', 'Fail if no mailbox/data password provider is configured')
    .option('--drive-cli-bin <path>', 'proton-drive-cli entry point to check', defaultDriveCliBin())
    .option('--session-file <path>', 'Session file path to inspect', SessionManager.getSessionFilePath())
    .option('-u, --username <account>', 'Username hint for credential lookup')
    .option('--json', 'Print machine-readable JSON')
    .option('--strict', 'Treat warnings as a non-zero preflight result')
    .action(async (options) => {
      const report = await runDoctor(options);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatDoctorReport(report));
      }
      if (!report.ok) {
        process.exit(1);
      }
    });
}
