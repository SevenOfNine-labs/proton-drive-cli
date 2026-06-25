const mockCreateProvider = jest.fn();
const mockKeyPasswordVerify = jest.fn();
const mockNormalizeProviderName = jest.fn((name: string) => {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'git') return 'git-credential';
  if (normalized === 'pass') return 'pass-cli';
  if (['git-credential', 'pass-cli', 'stdin', 'interactive'].includes(normalized)) return normalized;
  throw new Error(`Unknown credential provider: ${name}`);
});

jest.mock('../credentials', () => ({
  createProvider: mockCreateProvider,
  normalizeProviderName: mockNormalizeProviderName,
}));

jest.mock('../auth/session', () => ({
  SessionManager: {
    getSessionFilePath: jest.fn(() => '/tmp/proton-session.json'),
    loadSession: jest.fn(),
    validateSession: jest.fn(async () => true),
  },
}));

jest.mock('../auth/key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({
    provider: 'git-credential',
    host: 'proton-drive-key.proton-lfs-cli.local',
    verify: mockKeyPasswordVerify,
  })),
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  stat: jest.fn(),
  readJson: jest.fn(),
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

const mockFs = fs as jest.Mocked<typeof fs>;
const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const driveCliBin = '/tmp/proton-drive-cli/dist/index.js';
const sessionFile = '/tmp/proton-drive-cli/session.json';

function readDoctorContract(name: string): any {
  const file = path.resolve(__dirname, '..', '..', 'schemas', 'doctor', 'v1', name);
  return JSON.parse(nodeFs.readFileSync(file, 'utf8'));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function mockProvider(username: string = 'data-password') {
  return {
    name: 'pass-cli',
    isAvailable: jest.fn().mockResolvedValue(true),
    resolve: jest.fn().mockResolvedValue({ username, password: 'secret-password' }),
  };
}

function mockSession(passwordMode: number = 1) {
  return {
    sessionId: 'session-1',
    uid: 'uid-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['full'],
    passwordMode,
    authMode: 'browser-fork',
    keyPasswordPersisted: true,
    keyPasswordProvider: 'git-credential',
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  };
}

describe('createDoctorCommand', () => {
  it('creates a doctor command with browser-fork preflight options', () => {
    const cmd = createDoctorCommand();
    expect(cmd.name()).toBe('doctor');

    const optionNames = cmd.options.map((option: any) => option.long);
    expect(optionNames).toEqual(expect.arrayContaining([
      '--key-password-provider',
      '--key-password-host',
      '--data-credential-provider',
      '--data-credential-host',
      '--require-data-password',
      '--drive-cli-bin',
      '--session-file',
      '--json',
      '--strict',
    ]));
    expect(optionNames).not.toContain('--credential-provider');
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
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PROTON_DATA_PASSWORD;
    delete process.env.PROTON_SECOND_FACTOR_CODE;
    mockCreateProvider.mockReturnValue(mockProvider());
    mockKeyPasswordVerify.mockResolvedValue(true);
    mockedSessionManager.loadSession.mockResolvedValue(mockSession() as any);
    mockedSessionManager.validateSession.mockResolvedValue(true);
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin || target === sessionFile);
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o600 });
    mockFs.readJson.mockResolvedValue(mockSession());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes when bridge binary, browser-fork key password, and session file are safe', async () => {
    const report = await runDoctor({
      keyPasswordProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.authState.state).toBe('ready');
    expect(report.authState.willAttemptNetwork).toBe(false);
    expect(report.canAttemptTransfer).toBe(true);
    expect(report.canAttemptLiveCanary).toBe(true);
    expect(mockCreateProvider).not.toHaveBeenCalledWith('git-credential', { host: 'proton.me' });
  });

  it('passes two-password browser-fork sessions when key password is stored', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(mockSession(2) as any);
    mockFs.readJson.mockResolvedValue(mockSession(2));

    const report = await runDoctor({
      keyPasswordProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(true);
    expect(report.summary.warn).toBe(0);
    expect(report.authState.state).toBe('ready');
    expect(report.authState.passwordMode).toBe(2);
    expect(report.canAttemptTransfer).toBe(true);
    expect(report.canAttemptLiveCanary).toBe(true);
  });

  it('fails when a required mailbox/data credential provider is missing', async () => {
    const report = await runDoctor({
      keyPasswordProvider: 'git-credential',
      requireDataPassword: true,
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'data-credential', status: 'fail' }),
    ]));
  });

  it('fails when the session file permissions are too broad', async () => {
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o644 });

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-file', status: 'fail' }),
    ]));
  });

  it('rejects legacy non-browser-fork sessions', async () => {
    mockFs.readJson.mockResolvedValue({
      ...mockSession(),
      authMode: undefined,
      keyPasswordPersisted: undefined,
    });
    mockedSessionManager.loadSession.mockResolvedValue({
      ...mockSession(),
      authMode: undefined,
      keyPasswordPersisted: undefined,
    } as any);

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-file', status: 'fail' }),
      expect.objectContaining({ id: 'key-password-credential', status: 'fail' }),
    ]));
  });

  it('allows a guarded live canary to start from needs_login without transfer readiness', async () => {
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin);
    mockFs.readJson.mockRejectedValue(new Error('missing'));
    mockedSessionManager.loadSession.mockResolvedValue(null);
    mockedSessionManager.validateSession.mockResolvedValue(false);

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(true);
    expect(report.authState.state).toBe('needs_login');
    expect(report.canAttemptTransfer).toBe(false);
    expect(report.canAttemptLiveCanary).toBe(true);
  });

  it('fails when legacy secret environment variables are set', async () => {
    process.env.PROTON_DATA_PASSWORD = 'secret';

    const report = await runDoctor({ driveCliBin, sessionFile });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'secret-env', status: 'fail' }),
    ]));
  });
});

describe('formatDoctorReport', () => {
  it('includes auth readiness and canary readiness', async () => {
    const report = await runDoctor({
      keyPasswordProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    const output = formatDoctorReport(report);
    expect(output).toContain('Auth state: ready');
    expect(output).toContain('Transfer: ready');
    expect(output).toContain('Live canary: ready');
  });
});
