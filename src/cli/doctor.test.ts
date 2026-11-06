const mockKeyPasswordLoad = jest.fn();
const mockReadStoredSession = jest.fn();

jest.mock('../auth/session', () => ({
  SessionManager: {
    getSessionFilePath: jest.fn(() => '/tmp/proton-session.json'),
    readStoredSession: mockReadStoredSession,
    validateSession: jest.fn(async () => true),
  },
}));

jest.mock('../auth/key-password-store', () => ({
  createKeyPasswordStore: jest.fn((options: { provider?: string; host?: string }) => ({
    provider: options.provider ?? 'pass-cli',
    host: options.host ?? 'proton-drive-key.proton-lfs-cli.local',
    load: mockKeyPasswordLoad,
  })),
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  stat: jest.fn(),
}));

import * as nodeFs from 'fs';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
  DOCTOR_CHECK_FIELDS,
  DOCTOR_REPORT_FIELDS,
  DOCTOR_STATUSES,
  DOCTOR_SUMMARY_FIELDS,
  createDoctorCommand,
  formatDoctorReport,
  runDoctor,
} from './doctor';
import { SessionManager } from '../auth/session';
import { createKeyPasswordStore } from '../auth/key-password-store';
import { assertValidAgainstSchema } from '../test/schema-validator';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const mockCreateKeyPasswordStore = createKeyPasswordStore as jest.MockedFunction<typeof createKeyPasswordStore>;
const driveCliBin = '/tmp/proton-drive-cli/dist/index.js';
const sessionFile = '/tmp/proton-drive-cli/session.json';

function readDoctorContract(name: string): any {
  const file = path.resolve(__dirname, '..', '..', 'schemas', 'doctor', 'v1', name);
  return JSON.parse(nodeFs.readFileSync(file, 'utf8'));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

const session = {
  uid: 'uid-1',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  scopes: ['full'],
  keyPasswordProvider: 'git-credential' as const,
  keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
};

describe('createDoctorCommand', () => {
  it('offers exactly the offline preflight options', () => {
    const cmd = createDoctorCommand();
    expect(cmd.name()).toBe('doctor');

    expect(sorted(cmd.options.map((option: any) => option.long))).toEqual([
      '--drive-cli-bin',
      '--json',
      '--key-password-host',
      '--key-password-provider',
      '--session-file',
      '--strict',
    ]);
  });

  it('leaves the key-password provider and host to the saved session unless given', () => {
    const cmd = createDoctorCommand();
    for (const long of ['--key-password-provider', '--key-password-host']) {
      expect(cmd.options.find((o: any) => o.long === long)?.defaultValue).toBeUndefined();
    }
  });

  it('sets exitCode 1 instead of exiting when the report is not ok', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockFs.pathExists.mockImplementation(async () => false);
    mockReadStoredSession.mockResolvedValue({ kind: 'none' });
    try {
      await createDoctorCommand().parseAsync(['--json', '--drive-cli-bin', '/nonexistent/cli.js', '--session-file', '/nonexistent/session.json'], { from: 'user' });
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      const report = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n'));
      expect(report.ok).toBe(false);
      assertValidAgainstSchema('doctor/v1/report.schema.json', report);
    } finally {
      process.exitCode = undefined;
      jest.restoreAllMocks();
    }
  });
});

describe('doctor report contract', () => {
  it('keeps doctor report schema aligned with runtime fields', () => {
    const schema = readDoctorContract('report.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(sorted(Object.keys(schema.properties))).toEqual(sorted(DOCTOR_REPORT_FIELDS));
    expect(sorted(schema.required)).toEqual(sorted(DOCTOR_REPORT_FIELDS));
    expect(sorted(Object.keys(schema.properties.summary.properties))).toEqual(sorted(DOCTOR_SUMMARY_FIELDS));
    expect(sorted(schema.properties.summary.required)).toEqual(sorted(DOCTOR_SUMMARY_FIELDS));
    expect(sorted(Object.keys(schema.properties.checks.items.properties))).toEqual(sorted(DOCTOR_CHECK_FIELDS));
    expect(sorted(schema.properties.checks.items.properties.status.enum)).toEqual(sorted(DOCTOR_STATUSES));
    expect(schema.properties.authState.$ref).toBe('../../bridge/v1/auth-state-payload.schema.json');
  });
});

describe('runDoctor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKeyPasswordLoad.mockResolvedValue('stored-key-password');
    mockReadStoredSession.mockResolvedValue({ kind: 'valid', session });
    mockedSessionManager.validateSession.mockResolvedValue(true);
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin || target === sessionFile);
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o600 });
  });

  it('passes when the entry point, the key password and the session file are in order', async () => {
    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ['drive-cli-bin', 'pass'],
      ['key-password-credential', 'pass'],
      ['session-file', 'pass'],
    ]);
    expect(report.authState.state).toBe('ready');
    expect(report.authState.willAttemptNetwork).toBe(false);
    expect(report.canAttemptTransfer).toBe(true);
    expect(report.canAttemptLiveCanary).toBe(true);
    expect(mockReadStoredSession.mock.calls.every(([file]) => file === sessionFile)).toBe(true);
    assertValidAgainstSchema('doctor/v1/report.schema.json', report);
  });

  it("verifies the key password where the saved session's login stored it", async () => {
    await runDoctor({ driveCliBin, sessionFile });

    expect(mockCreateKeyPasswordStore).toHaveBeenCalledWith({
      provider: 'git-credential',
      host: 'proton-drive-key.proton-lfs-cli.local',
    });
    expect(mockKeyPasswordLoad).toHaveBeenCalledWith('uid-1');
  });

  it('verifies the provider and host given on the command line instead', async () => {
    await runDoctor({ driveCliBin, sessionFile, keyPasswordProvider: 'pass-cli', keyPasswordHost: 'other-host' });

    expect(mockCreateKeyPasswordStore).toHaveBeenCalledWith({ provider: 'pass-cli', host: 'other-host' });
  });

  it('fails when the key-password entry is missing', async () => {
    mockKeyPasswordLoad.mockRejectedValue(new Error('No pass-cli key-password entry found for this session'));

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'key-password-credential',
        status: 'fail',
        message: expect.stringContaining('No pass-cli key-password entry found for this session'),
      }),
    ]));
    expect(report.authState.state).toBe('needs_key_password');
    expect(report.canAttemptTransfer).toBe(false);
  });

  it('reports transfers as possible for a locally expired access token, which bridge init refreshes', async () => {
    mockedSessionManager.validateSession.mockResolvedValue(false);

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.authState.state).toBe('session_expired');
    expect(report.canAttemptTransfer).toBe(true);
    assertValidAgainstSchema('doctor/v1/report.schema.json', report);
  });

  it('fails when the session file permissions are too broad', async () => {
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o644 });

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-file', status: 'fail' }),
    ]));
  });

  it('fails on a session file that proton-drive-cli login did not write', async () => {
    mockReadStoredSession.mockResolvedValue({ kind: 'invalid' });

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-file', status: 'fail', remediation: 'Run proton-drive-cli login to replace it.' }),
      expect.objectContaining({ id: 'key-password-credential', status: 'skip' }),
    ]));
    expect(report.authState.state).toBe('session_invalid');
    assertValidAgainstSchema('doctor/v1/report.schema.json', report);
  });

  it('allows a guarded live canary to start from needs_login without transfer readiness', async () => {
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin);
    mockReadStoredSession.mockResolvedValue({ kind: 'none' });

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({ pass: 1, warn: 1, fail: 0, skip: 1 });
    expect(report.authState.state).toBe('needs_login');
    expect(report.canAttemptTransfer).toBe(false);
    expect(report.canAttemptLiveCanary).toBe(true);
  });

  it('treats warnings as failures with --strict', async () => {
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin);
    mockReadStoredSession.mockResolvedValue({ kind: 'none' });

    const report = await runDoctor({ driveCliBin, sessionFile, strict: true });

    expect(report.ok).toBe(false);
    expect(report.canAttemptLiveCanary).toBe(false);
  });
});

describe('formatDoctorReport', () => {
  beforeEach(() => {
    mockKeyPasswordLoad.mockResolvedValue('stored-key-password');
    mockReadStoredSession.mockResolvedValue({ kind: 'valid', session });
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin || target === sessionFile);
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o600 });
  });

  it('includes auth readiness and canary readiness', async () => {
    const report = await runDoctor({ driveCliBin, sessionFile });

    const output = formatDoctorReport(report);
    expect(output).toContain('Auth state: ready');
    expect(output).toContain('Transfer: ready');
    expect(output).toContain('Live canary: ready');
  });
});
