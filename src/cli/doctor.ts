// Offline preflight: the local session and key-password entry, checked
// without logging in, refreshing tokens or sending a request to the Proton API.

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';

import { SessionManager } from '../auth/session';
import { createKeyPasswordStore } from '../auth/key-password-store';
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
  /** Provider to verify in place of the one the saved session records. */
  keyPasswordProvider?: string;
  /** Credential host to verify in place of the one the saved session records. */
  keyPasswordHost?: string;
  driveCliBin?: string;
  sessionFile?: string;
  strict?: boolean;
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

function sessionFileOf(options: DoctorOptions): string {
  return options.sessionFile || SessionManager.getSessionFilePath();
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

async function checkKeyPasswordCredential(options: DoctorOptions): Promise<DoctorCheck> {
  const stored = await SessionManager.readStoredSession(sessionFileOf(options));
  if (stored.kind !== 'valid') {
    return makeCheck(
      'key-password-credential',
      'browser-fork key password',
      'skip',
      'No saved login session to verify a key-password entry for.',
      { remediation: 'Run proton-drive-cli login, then rerun doctor.' },
    );
  }
  const { session } = stored;

  try {
    const store = createKeyPasswordStore({
      provider: options.keyPasswordProvider || session.keyPasswordProvider,
      host: options.keyPasswordHost || session.keyPasswordHost,
    });
    try {
      await store.load(session.uid);
    } catch (error) {
      return makeCheck(
        'key-password-credential',
        'browser-fork key password',
        'fail',
        `No readable ${store.provider} key-password entry for session UID at ${store.host}: ${error instanceof Error ? error.message : String(error)}`,
        { remediation: 'Fix the credential provider, or run proton-drive-cli login again to store the key password.' },
      );
    }
    return makeCheck(
      'key-password-credential',
      'browser-fork key password',
      'pass',
      `Verified ${store.provider} key-password entry for session UID at ${store.host}.`,
    );
  } catch (error) {
    return makeCheck(
      'key-password-credential',
      'browser-fork key password',
      'fail',
      error instanceof Error ? error.message : 'Key-password provider check failed.',
      { remediation: 'Pass a supported --key-password-provider (pass-cli or git-credential) or run proton-drive-cli login.' },
    );
  }
}

async function checkSessionFile(options: DoctorOptions): Promise<DoctorCheck> {
  const sessionFile = sessionFileOf(options);
  if (!await fs.pathExists(sessionFile)) {
    return makeCheck(
      'session-file',
      'session file hygiene',
      'warn',
      `No saved session found at ${sessionFile}.`,
      { remediation: 'Run proton-drive-cli login.' },
    );
  }

  try {
    const stat = await fs.stat(sessionFile);
    if ((stat.mode & 0o077) !== 0) {
      return makeCheck(
        'session-file',
        'session file hygiene',
        'fail',
        `Session file permissions are too broad: ${(stat.mode & 0o777).toString(8)}.`,
        { remediation: `Run chmod 600 ${sessionFile}.` },
      );
    }
  } catch (error) {
    return makeCheck(
      'session-file',
      'session file hygiene',
      'fail',
      error instanceof Error ? `Could not read session file: ${error.message}` : 'Could not read session file.',
      { remediation: 'Fix or remove the session file before attempting transfers.' },
    );
  }

  const stored = await SessionManager.readStoredSession(sessionFile);
  if (stored.kind !== 'valid') {
    return makeCheck(
      'session-file',
      'session file hygiene',
      'fail',
      'Session file is not a proton-drive-cli login session (uid, accessToken, refreshToken, keyPasswordProvider and keyPasswordHost are required).',
      { remediation: 'Run proton-drive-cli login to replace it.' },
    );
  }
  return makeCheck(
    'session-file',
    'session file hygiene',
    'pass',
    `Session file shape and permissions are safe at ${sessionFile}.`,
  );
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    await checkDriveCliBin(options),
    await checkKeyPasswordCredential(options),
    await checkSessionFile(options),
  ];

  const summary = summarize(checks);
  const ok = summary.fail === 0 && (!options.strict || summary.warn === 0);
  const authState = await getBridgeAuthState(sessionFileOf(options));
  // bridge init refreshes a locally expired access token before use (sdk/client.ts).
  const canAttemptTransfer = ok && (authState.state === 'ready' || authState.state === 'session_expired');
  const canAttemptLiveCanary = ok && (authState.state === 'ready' || authState.state === 'needs_login');
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
    .option('--key-password-provider <type>', "Key-password provider to verify instead of the saved session's: pass-cli or git-credential")
    .option('--key-password-host <host>', "Key-password credential host to verify instead of the saved session's")
    .option('--drive-cli-bin <path>', 'proton-drive-cli entry point to check', defaultDriveCliBin())
    .option('--session-file <path>', 'Session file path to inspect', SessionManager.getSessionFilePath())
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
        // stdout writes can complete asynchronously; process.exit would drop them.
        process.exitCode = 1;
      }
    });
}
