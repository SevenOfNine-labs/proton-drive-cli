/**
 * Proton's official account module (submodules/sdk/incubating/account/js/src, wired as sdk
 * cli/src/api/index.ts wires it) and this CLI against one in-process Proton API: same requests,
 * headers, fork delays and refresh body; this CLI omits the telemetry read GET /core/v4/settings.
 */
import '../crypto/polyfill';
import * as fs from 'fs-extra';
import * as os from 'os';
import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import { VERIFICATION_STATUS } from '@protontech/crypto/constants';
import { OpenPGPCryptoWithCryptoProxy } from '@protontech/drive-sdk';
import { FakeProtonApi } from '../test/fake-proton-api';
import { BrowserForkAuthService } from './browser-fork';
import { SessionManager } from './session';
import { memorySessionSecrets } from '../test/memory-session-secrets';
import { DriveCryptoService } from '../crypto/drive-crypto';
import { AccountAdapter } from '../sdk/accountAdapter';
import { ProtonOpenPGPCryptoProxy } from '../sdk/cryptoProxy';
import { HTTPClientAdapter } from '../sdk/httpClientAdapter';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-conformance-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');
jest.mock('./session-secrets', () => jest.requireActual('../test/memory-session-secrets').mockSessionSecretsModule());
let mockRecordOfficialSleep: (ms: number) => void = () => undefined;
jest.mock('../../submodules/sdk/incubating/account/js/src/sleep', () => ({
  sleepMs: async (ms: number) => {
    mockRecordOfficialSleep(ms);
  },
}));

interface OfficialAddress {
  email: string;
  primaryKeyIndex: number;
  keys: Array<{ id: string; key: unknown }>;
}
interface OfficialAccountModule {
  ApiClient: new (options: Record<string, unknown>) => {
    authenticatedRequest: { get(url: string, options: { throwHttpErrors: boolean }): Promise<Response> };
  };
  initAccount(options: Record<string, unknown>): Promise<{
    auth: { authViaWeb(onSignInUrl: (url: string) => void): Promise<void> };
    addresses: {
      getOwnPrimaryAddress(): Promise<OfficialAddress>;
      getOwnAddresses(): Promise<OfficialAddress[]>;
      getPublicKeys(email: string): Promise<Array<{ getFingerprint(): string }>>;
    };
  }>;
}

// Loaded at run time so that tsc (rootDir src) does not compile the official module.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const official: OfficialAccountModule = require('../../submodules/sdk/incubating/account/js/src');

const APP_VERSION = 'external-drive-protonlfscli@0.1.2';
const SDK_VERSION_HEADER = 'js@0.23.0';

interface WireRequest {
  method: string;
  path: string;
  query: string;
  status: number;
  headers: string[];
  body?: unknown;
}

const UNAUTHENTICATED = ['x-pm-appversion', 'x-pm-drive-sdk-version'];
const AUTHENTICATED = ['authorization', 'x-pm-appversion', 'x-pm-drive-sdk-version', 'x-pm-uid'];

const EXPECTED_SEQUENCE: WireRequest[] = [
  { method: 'GET', path: '/auth/v4/sessions/forks', query: '', status: 200, headers: UNAUTHENTICATED },
  { method: 'GET', path: '/auth/v4/sessions/forks/selector-fake-1', query: '', status: 422, headers: UNAUTHENTICATED },
  { method: 'GET', path: '/auth/v4/sessions/forks/selector-fake-1', query: '', status: 200, headers: UNAUTHENTICATED },
  { method: 'GET', path: '/core/v4/users', query: '', status: 200, headers: AUTHENTICATED },
  { method: 'GET', path: '/core/v4/addresses', query: '?Page=0&PageSize=50', status: 200, headers: AUTHENTICATED },
  { method: 'GET', path: '/core/v4/keys/all', query: '?Email=friend%40proton.me&InternalOnly=1', status: 200, headers: AUTHENTICATED },
  { method: 'GET', path: '/core/v4/keys/all', query: '?Email=nobody%40example.com&InternalOnly=1', status: 422, headers: AUTHENTICATED },
  { method: 'GET', path: '/drive/v2/volumes', query: '', status: 401, headers: AUTHENTICATED },
  {
    method: 'POST',
    path: '/auth/v4/refresh',
    query: '',
    status: 200,
    headers: AUTHENTICATED,
    body: { ResponseType: 'token', GrantType: 'refresh_token', RefreshToken: 'refresh-1' },
  },
  { method: 'GET', path: '/drive/v2/volumes', query: '', status: 200, headers: AUTHENTICATED },
];

/** authWeb.ts: FORK_INITIAL_DELAY_MS before the first poll, FORK_POLL_INTERVAL_MS after a pending one. */
const EXPECTED_FORK_TIMELINE = [
  'GET /auth/v4/sessions/forks 200',
  'sleep 5000',
  'GET /auth/v4/sessions/forks/selector-fake-1 422',
  'sleep 5000',
  'GET /auth/v4/sessions/forks/selector-fake-1 200',
];

interface AccountOutcome {
  keyPassword: string | undefined;
  primaryKeyIds: string[];
  addressKeyIds: Array<[string, string[]]>;
  ownFingerprints: string[];
  friendFingerprints: string[];
  unknownKeyCount: number;
  manifestVerification: unknown;
  retriedStatus: number;
}

function wireRequests(fake: FakeProtonApi): WireRequest[] {
  return fake.requests.map((request) => ({
    method: request.method,
    path: request.path,
    query: request.query,
    status: request.status,
    headers: AUTHENTICATED.filter((name) => name in request.headers).sort(),
    ...(request.body !== undefined && request.body !== '' ? { body: request.body } : {}),
  }));
}

function sorted(sequence: WireRequest[]): WireRequest[] {
  return sequence.map((request) => ({ ...request, headers: [...request.headers].sort() }));
}

/** The manifest check path: sign with the primary address key, verify with the returned public keys. */
async function verifyManifestSignature(
  primary: OfficialAddress,
  publicKeys: unknown[],
  crypto: OpenPGPCryptoWithCryptoProxy,
): Promise<unknown> {
  const data = new TextEncoder().encode('manifest');
  const signingKey = primary.keys[primary.primaryKeyIndex].key;
  const { signature } = await crypto.sign(data, signingKey as never, 'drive.manifest');
  const { verified } = await crypto.verify(data, signature, publicKeys as never, 'drive.manifest');
  return verified;
}

/** In-memory SessionCredentials of the official module (sessionCredentials.ts). */
class MemoryCredentials {
  private info?: { uid: string; accessToken: string; refreshToken?: string };
  private keyPassword?: string;
  private readonly callbacks: Array<() => void> = [];
  get uid() { return this.info?.uid; }
  get accessToken() { return this.info?.accessToken; }
  get refreshToken() { return this.info?.refreshToken; }
  on(_event: 'sessionInfoChanged', callback: () => void) { this.callbacks.push(callback); }
  isLoggedIn() { return this.keyPassword !== undefined && this.info !== undefined; }
  isTelemetryEnabled() { return false; }
  getUserKeyPassword() { return this.keyPassword; }
  async load() {}
  async setUserKeyPassword(keyPassword: string) { this.keyPassword = keyPassword; this.notify(); }
  async setSessionInfo(info: { uid: string; accessToken: string; refreshToken?: string }) { this.info = info; this.notify(); }
  async setTelemetryEnabled() {}
  async signOut() { this.info = undefined; this.keyPassword = undefined; }
  private notify() { this.callbacks.forEach((callback) => callback()); }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function runOfficialModule(fake: FakeProtonApi): Promise<AccountOutcome> {
  mockRecordOfficialSleep = (ms) => fake.recordSleep(ms);
  CryptoApi.init({});
  CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
  const credentials = new MemoryCredentials();
  const apiClient = new official.ApiClient({
    baseUrl: 'drive-api.proton.me',
    appVersion: APP_VERSION,
    credentials,
    logger: silentLogger,
    headers: { 'x-pm-drive-sdk-version': SDK_VERSION_HEADER },
  });
  const { auth, addresses } = await official.initAccount({
    authClientId: 'external-drive',
    apiClient,
    credentials,
    cryptoProxy: CryptoProxy,
    srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
    logger: silentLogger,
    accountUrl: 'account.proton.me',
  });

  await auth.authViaWeb((url) => fake.browserCompletesSignIn(url));
  const primary = await addresses.getOwnPrimaryAddress();
  const own = await addresses.getOwnAddresses();
  const ownPublicKeys = await addresses.getPublicKeys('user@proton.me');
  const friendPublicKeys = await addresses.getPublicKeys('friend@proton.me');
  const unknownPublicKeys = await addresses.getPublicKeys('nobody@example.com');
  const manifestVerification = await verifyManifestSignature(
    primary,
    ownPublicKeys,
    new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
  );

  fake.expireOnNextRequestTo = '/drive/v2/volumes';
  const retried = await apiClient.authenticatedRequest.get('https://drive-api.proton.me/drive/v2/volumes', {
    throwHttpErrors: false,
  });

  return {
    keyPassword: credentials.getUserKeyPassword(),
    primaryKeyIds: primary.keys.map((key) => key.id),
    addressKeyIds: own.map((address) => [address.email, address.keys.map((key) => key.id)]),
    ownFingerprints: ownPublicKeys.map((key) => key.getFingerprint()),
    friendFingerprints: friendPublicKeys.map((key) => key.getFingerprint()),
    unknownKeyCount: unknownPublicKeys.length,
    manifestVerification,
    retriedStatus: retried.status,
  };
}

async function runThisCli(fake: FakeProtonApi): Promise<AccountOutcome> {
  await new BrowserForkAuthService({
    appVersion: APP_VERSION,
    sleepMs: async (ms) => { fake.recordSleep(ms); },
  }).login({ onSignInUrl: (url) => fake.browserCompletesSignIn(url) });

  const keyPassword = memorySessionSecrets.get('pass-cli', 'proton-drive-cli.invalid', fake.uid)?.keyPassword;
  const driveCrypto = new DriveCryptoService(APP_VERSION);
  await driveCrypto.initialize(keyPassword ?? '');
  const proxy = new ProtonOpenPGPCryptoProxy();
  const account = new AccountAdapter(driveCrypto, proxy);
  const primary = await account.getOwnPrimaryAddress();
  const own = await account.getOwnAddresses();
  const ownPublicKeys = await account.getPublicKeys('user@proton.me');
  const friendPublicKeys = await account.getPublicKeys('friend@proton.me');
  const unknownPublicKeys = await account.getPublicKeys('nobody@example.com');
  const manifestVerification = await verifyManifestSignature(
    primary as unknown as OfficialAddress,
    ownPublicKeys,
    new OpenPGPCryptoWithCryptoProxy(proxy),
  );

  fake.expireOnNextRequestTo = '/drive/v2/volumes';
  const retried = await new HTTPClientAdapter(APP_VERSION).fetchJson({
    url: 'https://drive-api.proton.me/drive/v2/volumes',
    method: 'GET',
    headers: new Headers(),
    timeoutMs: 30_000,
  });

  return {
    keyPassword,
    primaryKeyIds: primary.keys.map((key) => key.id),
    addressKeyIds: own.map((address) => [address.email, address.keys.map((key) => key.id)]),
    ownFingerprints: ownPublicKeys.map((key) => key.getFingerprint()),
    friendFingerprints: friendPublicKeys.map((key) => key.getFingerprint()),
    unknownKeyCount: unknownPublicKeys.length,
    manifestVerification,
    retriedStatus: retried.status,
  };
}

/** Both clients keep the signed address key and the tokenless one, and drop the forged key. */
function expectedOutcome(fake: FakeProtonApi): AccountOutcome {
  return {
    keyPassword: fake.keyPassword,
    primaryKeyIds: ['address-key-good'],
    addressKeyIds: [
      ['user@proton.me', ['address-key-good']],
      ['alias@proton.me', ['address-key-tokenless']],
    ],
    ownFingerprints: [fake.goodAddressFingerprint],
    friendFingerprints: [fake.friendFingerprint],
    unknownKeyCount: 0,
    manifestVerification: VERIFICATION_STATUS.SIGNED_AND_VALID,
    retriedStatus: 200,
  };
}

function expectRefreshAndHeaders(fake: FakeProtonApi): void {
  const refresh = fake.requests.find((request) => request.path === '/auth/v4/refresh');
  expect(refresh?.headers['authorization']).toBe('Bearer access-1');
  expect(refresh?.headers['x-pm-uid']).toBe(fake.uid);
  for (const request of fake.requests) {
    expect(request.headers['x-pm-appversion']).toBe(APP_VERSION);
    expect(request.headers['x-pm-drive-sdk-version']).toBe(SDK_VERSION_HEADER);
  }
}

describe('authentication conformance with the official account module', () => {
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await SessionManager.clearSession();
  });

  afterAll(async () => {
    await fs.remove(os.homedir());
  });

  it('records the expected requests, delays and results from the official module', async () => {
    const fake = await FakeProtonApi.create();
    globalThis.fetch = fake.fetch as typeof fetch;

    await expect(runOfficialModule(fake)).resolves.toEqual(expectedOutcome(fake));

    const settings = { method: 'GET', path: '/core/v4/settings', query: '', status: 200, headers: AUTHENTICATED };
    expect(wireRequests(fake)).toEqual(sorted([...EXPECTED_SEQUENCE.slice(0, 3), settings, ...EXPECTED_SEQUENCE.slice(3)]));
    expect(fake.timeline.slice(0, 5)).toEqual(EXPECTED_FORK_TIMELINE);
    expectRefreshAndHeaders(fake);
  });

  it('logs in, unlocks keys, resolves public keys and refreshes like the official module', async () => {
    const fake = await FakeProtonApi.create();
    globalThis.fetch = fake.fetch as typeof fetch;

    await expect(runThisCli(fake)).resolves.toEqual(expectedOutcome(fake));

    expect(wireRequests(fake)).toEqual(sorted(EXPECTED_SEQUENCE));
    expect(fake.timeline.slice(0, 5)).toEqual(EXPECTED_FORK_TIMELINE);
    expect(fake.timeline.filter((entry) => entry.startsWith('sleep'))).toHaveLength(2);
    expect(await SessionManager.loadSession()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(memorySessionSecrets.get('pass-cli', 'proton-drive-cli.invalid', fake.uid)).toEqual({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      keyPassword: fake.keyPassword,
    });
    expectRefreshAndHeaders(fake);
  });
});
