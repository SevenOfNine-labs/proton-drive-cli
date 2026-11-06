import { createCipheriv, randomBytes } from 'crypto';
import * as openpgp from 'openpgp';

export interface RecordedRequest {
  t: number;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
}

const API = 'https://drive-api.proton.me';

/**
 * In-process Proton API for authentication conformance tests: real OpenPGP
 * keys, the browser's half of the session fork (the sign-in URL payload as
 * read by account.proton.me), single-use refresh tokens, recorded requests.
 * Response shapes follow sdk/incubating/account/js/src/{accountApi,apiClient}.ts.
 */
export class FakeProtonApi {
  readonly requests: RecordedRequest[] = [];
  /** Requests as `METHOD path status` and client sleeps as `sleep ms`, in order. */
  readonly timeline: string[] = [];
  readonly keyPassword = randomBytes(23).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 31);
  readonly uid = 'uid-fake-1';
  readonly selector = 'selector-fake-1';
  readonly userCode = 'ABCD-EFGH';
  accessToken = 'access-1';
  refreshToken = 'refresh-1';
  private tokenGeneration = 1;
  private forkCompleted = false;
  private forkEncryptionKey: Buffer | null = null;
  private pendingPollsLeft = 1;
  /** The next request to this path answers 401 once. */
  expireOnNextRequestTo: string | null = null;
  signInUrl = '';
  signInUrlAt = 0;
  private readonly t0 = Date.now();

  userKeyArmored = '';
  userPublicArmored = '';
  goodAddressKeyArmored = '';
  goodAddressPublicArmored = '';
  goodAddressFingerprint = '';
  tokenlessAddressKeyArmored = '';
  tokenlessAddressFingerprint = '';
  forgedAddressKeyArmored = '';
  friendPublicArmored = '';
  friendFingerprint = '';
  goodToken = '';
  goodTokenArmored = '';
  goodTokenSignature = '';
  forgedTokenArmored = '';
  forgedTokenSignature = '';

  static async create(): Promise<FakeProtonApi> {
    const fake = new FakeProtonApi();
    await fake.generateKeys();
    return fake;
  }

  private async generateKeys(): Promise<void> {
    const user = await openpgp.generateKey({
      userIDs: [{ email: 'user@proton.me' }],
      passphrase: this.keyPassword,
      format: 'armored',
    });
    this.userKeyArmored = user.privateKey;
    this.userPublicArmored = user.publicKey;
    const userPrivate = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: user.privateKey }),
      passphrase: this.keyPassword,
    });
    const userPublic = await openpgp.readKey({ armoredKey: user.publicKey });

    // Address key whose passphrase is a token encrypted to and signed by the user key.
    this.goodToken = randomBytes(32).toString('hex');
    const good = await openpgp.generateKey({
      userIDs: [{ email: 'user@proton.me' }],
      passphrase: this.goodToken,
      format: 'armored',
    });
    this.goodAddressKeyArmored = good.privateKey;
    this.goodAddressPublicArmored = good.publicKey;
    this.goodAddressFingerprint = (await openpgp.readKey({ armoredKey: good.publicKey })).getFingerprint();
    const tokenMessage = await openpgp.createMessage({ text: this.goodToken });
    this.goodTokenArmored = (await openpgp.encrypt({ message: tokenMessage, encryptionKeys: userPublic })) as string;
    this.goodTokenSignature = (await openpgp.sign({ message: tokenMessage, signingKeys: userPrivate, detached: true })) as string;

    // Address key whose token signature comes from a foreign key.
    const attacker = await openpgp.generateKey({ userIDs: [{ email: 'attacker@example.com' }], format: 'object' });
    const forgedToken = randomBytes(32).toString('hex');
    const forged = await openpgp.generateKey({
      userIDs: [{ email: 'user@proton.me' }],
      passphrase: forgedToken,
      format: 'armored',
    });
    this.forgedAddressKeyArmored = forged.privateKey;
    const forgedMessage = await openpgp.createMessage({ text: forgedToken });
    this.forgedTokenArmored = (await openpgp.encrypt({ message: forgedMessage, encryptionKeys: userPublic })) as string;
    this.forgedTokenSignature = (await openpgp.sign({
      message: forgedMessage,
      signingKeys: attacker.privateKey,
      detached: true,
    })) as string;

    // Address key without Token, encrypted with the key password.
    const tokenless = await openpgp.generateKey({
      userIDs: [{ email: 'alias@proton.me' }],
      passphrase: this.keyPassword,
      format: 'armored',
    });
    this.tokenlessAddressKeyArmored = tokenless.privateKey;
    this.tokenlessAddressFingerprint = (await openpgp.readKey({ armoredKey: tokenless.publicKey })).getFingerprint();

    const friend = await openpgp.generateKey({ userIDs: [{ email: 'friend@proton.me' }], format: 'armored' });
    this.friendPublicArmored = friend.publicKey;
    this.friendFingerprint = (await openpgp.readKey({ armoredKey: friend.publicKey })).getFingerprint();
  }

  /** Record a client sleep of `ms` milliseconds in the timeline. */
  recordSleep(ms: number): void {
    this.timeline.push(`sleep ${ms}`);
  }

  /** Completes the sign-in the way account.proton.me does with the printed URL. */
  browserCompletesSignIn(signInUrl: string): void {
    this.signInUrl = signInUrl;
    this.signInUrlAt = Date.now() - this.t0;
    const url = new URL(signInUrl);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const payload = fragment.get('payload') ?? '';
    const [version, userCode, base64Key, clientId] = payload.split(':');
    if (version !== '0' || userCode !== this.userCode || clientId !== 'external-drive') {
      throw new Error(`unexpected sign-in payload ${payload}`);
    }
    this.forkEncryptionKey = Buffer.from(base64Key, 'base64');
    this.forkCompleted = true;
  }

  private forkPayload(): string {
    if (!this.forkEncryptionKey) throw new Error('fork key missing');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.forkEncryptionKey, nonce);
    cipher.setAAD(Buffer.from('fork', 'utf8'));
    const body = JSON.stringify({ type: 'default', keyPassword: this.keyPassword });
    const ciphertext = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const respond = (status: number, json: unknown): Response => {
      this.timeline.push(`${request.method} ${url.pathname} ${status}`);
      this.requests.push({
        t: Date.now() - this.t0,
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers,
        body,
        status,
      });
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } });
    };

    if (url.origin !== API) return respond(421, { Code: 2000, Error: `wrong origin ${url.origin}` });
    const path = url.pathname;

    if (request.method === 'GET' && path === '/auth/v4/sessions/forks') {
      return respond(200, { Code: 1000, Selector: this.selector, UserCode: this.userCode });
    }
    if (request.method === 'GET' && path === `/auth/v4/sessions/forks/${this.selector}`) {
      if (!this.forkCompleted || this.pendingPollsLeft > 0) {
        this.pendingPollsLeft -= 1;
        return respond(422, { Code: 2501, Error: 'Session not yet ready' });
      }
      return respond(200, {
        Code: 1000,
        UID: this.uid,
        AccessToken: this.accessToken,
        RefreshToken: this.refreshToken,
        Payload: this.forkPayload(),
        LocalID: 0,
        Scopes: ['full', 'self', 'user', 'loggedin', 'drive'],
      });
    }
    if (request.method === 'POST' && path === '/auth/v4/refresh') {
      const sent = (body as { RefreshToken?: string } | undefined)?.RefreshToken;
      if (sent !== this.refreshToken) {
        return respond(422, { Code: 10013, Error: 'Invalid refresh token' });
      }
      this.tokenGeneration += 1;
      this.accessToken = `access-${this.tokenGeneration}`;
      this.refreshToken = `refresh-${this.tokenGeneration}`;
      return respond(200, {
        Code: 1000,
        UID: this.uid,
        AccessToken: this.accessToken,
        RefreshToken: this.refreshToken,
        TokenType: 'Bearer',
        Scopes: ['full', 'self', 'user', 'loggedin', 'drive'],
        ExpiresIn: 86400,
      });
    }

    if (headers['x-pm-uid'] !== this.uid || headers['authorization'] !== `Bearer ${this.accessToken}`) {
      return respond(401, { Code: 401, Error: 'Invalid access token' });
    }
    if (this.expireOnNextRequestTo === path) {
      this.expireOnNextRequestTo = null;
      return respond(401, { Code: 401, Error: 'Access token expired' });
    }

    if (request.method === 'DELETE' && path === '/auth/v4') return respond(200, { Code: 1000 });
    if (request.method === 'GET' && path === '/core/v4/settings') {
      return respond(200, { Code: 1000, UserSettings: { Telemetry: 0 } });
    }
    if (request.method === 'GET' && path === '/core/v4/users') {
      return respond(200, {
        Code: 1000,
        User: {
          ID: 'user-1',
          Name: 'user',
          Email: 'user@proton.me',
          Keys: [{ ID: 'user-key-1', Version: 3, Primary: 1, Active: 1, PrivateKey: this.userKeyArmored }],
        },
      });
    }
    if (request.method === 'GET' && path === '/core/v4/addresses') {
      return respond(200, {
        Code: 1000,
        Total: 2,
        Addresses: [
          {
            ID: 'address-1',
            Email: 'user@proton.me',
            Order: 1,
            Status: 1,
            Type: 1,
            Receive: 1,
            Send: 1,
            Keys: [
              {
                ID: 'address-key-good',
                Version: 3,
                Primary: 1,
                Active: 1,
                Flags: 3,
                PrivateKey: this.goodAddressKeyArmored,
                Token: this.goodTokenArmored,
                Signature: this.goodTokenSignature,
              },
              {
                ID: 'address-key-forged',
                Version: 3,
                Primary: 0,
                Active: 1,
                Flags: 3,
                PrivateKey: this.forgedAddressKeyArmored,
                Token: this.forgedTokenArmored,
                Signature: this.forgedTokenSignature,
              },
            ],
          },
          {
            ID: 'address-2',
            Email: 'alias@proton.me',
            Order: 2,
            Status: 1,
            Type: 2,
            Receive: 1,
            Send: 1,
            Keys: [
              { ID: 'address-key-tokenless', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: this.tokenlessAddressKeyArmored },
            ],
          },
        ],
      });
    }
    if (request.method === 'GET' && path === '/core/v4/keys/all') {
      const email = url.searchParams.get('Email');
      if (email === 'friend@proton.me') {
        return respond(200, { Code: 1000, Address: { Keys: [{ Flags: 3, PublicKey: this.friendPublicArmored }] } });
      }
      return respond(422, { Code: 33102, Error: 'This address does not exist' });
    }
    if (request.method === 'GET' && path === '/drive/v2/volumes') {
      return respond(200, { Code: 1000, Volumes: [] });
    }
    return respond(404, { Code: 2501, Error: `fake has no route for ${request.method} ${path}` });
  };
}
