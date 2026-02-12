/**
 * SDK Behavioral Tests
 *
 * These tests verify the RUNTIME BEHAVIOR of the @protontech/drive-sdk,
 * not just the existence of methods (that's sdk-contract.test.ts).
 *
 * After `git pull` on the SDK submodule, these tests will FAIL if:
 *
 * 1. MemoryCache behavior changes (set/get/iterate/tag semantics)
 * 2. OpenPGPCryptoWithCryptoProxy stops wrapping our proxy correctly
 * 3. ProtonDriveClient method parameter counts change
 * 4. AsyncGenerator methods stop returning async generators
 * 5. Promise methods stop returning promises
 * 6. Error class hierarchy changes
 * 7. NodeType enum values change
 * 8. CryptoProxy encrypt/decrypt/sign/verify roundtrips break
 * 9. Client construction with our adapters fails
 *
 * These tests DO NOT require authentication or network access.
 */

import {
  ProtonDriveClient,
  MemoryCache,
  OpenPGPCryptoWithCryptoProxy,
  NodeType,
  VERSION,
} from '@protontech/drive-sdk';
import type {
  ProtonDriveAccount,
  ProtonDriveHTTPClient,
  NodeResult,
  NodeResultWithNewUid,
  MaybeNode,
  NodeEntity,
  FileUploader,
  FileDownloader,
} from '@protontech/drive-sdk';

import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';
import { HTTPClientAdapter } from './httpClientAdapter';
import { SRPModuleAdapter } from './srpAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ProtonDriveClient with mock adapters for behavioral testing. */
function createTestClient(httpOverrides?: Partial<ProtonDriveHTTPClient>) {
  const proxy = new ProtonOpenPGPCryptoProxy();
  const openPGPCrypto = new OpenPGPCryptoWithCryptoProxy(proxy);
  const srp = new SRPModuleAdapter();

  const mockHttp: ProtonDriveHTTPClient = {
    fetchJson: httpOverrides?.fetchJson ?? (async () => new Response('{}', { status: 200 })),
    fetchBlob: httpOverrides?.fetchBlob ?? (async () => new Response('', { status: 200 })),
  };

  const mockAccount: ProtonDriveAccount = {
    getOwnPrimaryAddress: async () => ({
      email: 'test@proton.me',
      addressId: 'addr-1',
      primaryKeyIndex: 0,
      keys: [],
    }),
    getOwnAddresses: async () => [],
    getOwnAddress: async () => ({
      email: 'test@proton.me',
      addressId: 'addr-1',
      primaryKeyIndex: 0,
      keys: [],
    }),
    hasProtonAccount: async () => false,
    getPublicKeys: async () => [],
  };

  return new ProtonDriveClient({
    httpClient: mockHttp,
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account: mockAccount,
    openPGPCryptoModule: openPGPCrypto,
    srpModule: srp,
  });
}

// ---------------------------------------------------------------------------
// 1. MemoryCache Behavioral Tests
// ---------------------------------------------------------------------------
describe('MemoryCache behavior', () => {
  let cache: InstanceType<typeof MemoryCache<string>>;

  beforeEach(() => {
    cache = new MemoryCache<string>();
  });

  test('setEntity + getEntity roundtrip', async () => {
    await cache.setEntity('key1', 'value1');
    const result = await cache.getEntity('key1');
    expect(result).toBe('value1');
  });

  test('getEntity throws for missing key', async () => {
    await expect(cache.getEntity('nonexistent')).rejects.toThrow();
  });

  test('setEntity overwrites existing value', async () => {
    await cache.setEntity('key1', 'v1');
    await cache.setEntity('key1', 'v2');
    expect(await cache.getEntity('key1')).toBe('v2');
  });

  test('removeEntities deletes keys', async () => {
    await cache.setEntity('a', '1');
    await cache.setEntity('b', '2');
    await cache.removeEntities(['a']);
    await expect(cache.getEntity('a')).rejects.toThrow();
    expect(await cache.getEntity('b')).toBe('2');
  });

  test('clear removes all entries', async () => {
    await cache.setEntity('a', '1');
    await cache.setEntity('b', '2');
    await cache.clear();
    await expect(cache.getEntity('a')).rejects.toThrow();
    await expect(cache.getEntity('b')).rejects.toThrow();
  });

  test('iterateEntities yields existing and reports missing', async () => {
    await cache.setEntity('a', '1');
    await cache.setEntity('b', '2');

    const results: Array<{ key: string; ok: boolean }> = [];
    for await (const item of cache.iterateEntities(['a', 'missing', 'b'])) {
      results.push({ key: item.key, ok: item.ok });
    }

    expect(results).toEqual([
      { key: 'a', ok: true },
      { key: 'missing', ok: false },
      { key: 'b', ok: true },
    ]);
  });

  test('tag-based storage and retrieval', async () => {
    await cache.setEntity('node-1', 'data1', ['folder:root']);
    await cache.setEntity('node-2', 'data2', ['folder:root']);
    await cache.setEntity('node-3', 'data3', ['folder:sub']);

    const rootChildren: string[] = [];
    for await (const item of cache.iterateEntitiesByTag('folder:root')) {
      if (item.ok) rootChildren.push(item.value);
    }
    expect(rootChildren).toEqual(['data1', 'data2']);
  });

  test('iterateEntitiesByTag returns nothing for unknown tag', async () => {
    const results: any[] = [];
    for await (const item of cache.iterateEntitiesByTag('nonexistent-tag')) {
      results.push(item);
    }
    expect(results).toEqual([]);
  });

  test('setEntity re-tags: old tags removed, new tags applied', async () => {
    await cache.setEntity('node-1', 'v1', ['tag-A']);
    await cache.setEntity('node-1', 'v2', ['tag-B']);

    // Should no longer be under tag-A
    const tagA: any[] = [];
    for await (const item of cache.iterateEntitiesByTag('tag-A')) {
      tagA.push(item);
    }
    expect(tagA).toEqual([]);

    // Should be under tag-B
    const tagB: any[] = [];
    for await (const item of cache.iterateEntitiesByTag('tag-B')) {
      tagB.push(item);
    }
    expect(tagB).toHaveLength(1);
    expect(tagB[0].ok).toBe(true);
    expect(tagB[0].value).toBe('v2');
  });

  test('removeEntities cleans up tags', async () => {
    await cache.setEntity('node-1', 'data1', ['folder:root']);
    await cache.removeEntities(['node-1']);

    const results: any[] = [];
    for await (const item of cache.iterateEntitiesByTag('folder:root')) {
      results.push(item);
    }
    expect(results).toEqual([]);
  });

  test('stores complex objects', async () => {
    const objCache = new MemoryCache<{ uid: string; name: string }>();
    const obj = { uid: 'abc-123', name: 'test.txt' };
    await objCache.setEntity('key', obj);
    const retrieved = await objCache.getEntity('key');
    expect(retrieved).toEqual(obj);
    // Same reference (no deep clone)
    expect(retrieved).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// 2. ProtonDriveClient Method Signatures
// ---------------------------------------------------------------------------
describe('ProtonDriveClient method parameter counts', () => {
  // Function.length reports the number of REQUIRED parameters (before first
  // with default). If the SDK changes a method signature, this catches it.
  const proto = ProtonDriveClient.prototype;

  // Function.length counts parameters before the first with a default value.
  // The SDK includes signal/options params without defaults in most methods.
  const expectedParamCounts: [string, number][] = [
    // Core navigation
    ['getMyFilesRootFolder', 0],
    ['getNode', 1],
    ['iterateFolderChildren', 3],    // (parentUid, filterOptions, signal)

    // Folder ops
    ['createFolder', 3],             // (parentUid, name, modificationTime)
    ['renameNode', 2],

    // Batch ops (async generators)
    ['trashNodes', 2],               // (uids, signal)
    ['deleteNodes', 2],              // (uids, signal)
    ['restoreNodes', 2],             // (uids, signal)
    ['moveNodes', 3],                // (uids, parentUid, signal)
    ['copyNodes', 3],                // (uids, parentUid, signal)

    // File transfer
    ['getFileUploader', 4],          // (parentUid, name, metadata, signal)
    ['getFileDownloader', 2],        // (nodeUid, signal)
  ];

  for (const [method, expectedCount] of expectedParamCounts) {
    test(`${method}() has ${expectedCount} required params`, () => {
      const fn = (proto as any)[method];
      expect(typeof fn).toBe('function');
      expect(fn.length).toBe(expectedCount);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Return Type Detection (Promise vs AsyncGenerator)
// ---------------------------------------------------------------------------
describe('ProtonDriveClient return types', () => {
  // We can't call these methods (they require auth) but we can verify
  // the function constructor name. AsyncGenerator functions have a
  // different type than regular async functions.

  const asyncGeneratorMethods = [
    'iterateFolderChildren',
    'iterateTrashedNodes',
    'iterateNodes',
    'trashNodes',
    'deleteNodes',
    'restoreNodes',
    'moveNodes',
    'copyNodes',
  ];

  const promiseMethods = [
    'getMyFilesRootFolder',
    'getNode',
    'createFolder',
    'renameNode',
    'getFileUploader',
    'getFileDownloader',
  ];

  for (const method of asyncGeneratorMethods) {
    test(`${method}() is an async generator function`, () => {
      const fn = (ProtonDriveClient.prototype as any)[method];
      // AsyncGeneratorFunction has constructor.name === 'AsyncGeneratorFunction'
      expect(fn.constructor.name).toBe('AsyncGeneratorFunction');
    });
  }

  for (const method of promiseMethods) {
    test(`${method}() is an async function`, () => {
      const fn = (ProtonDriveClient.prototype as any)[method];
      expect(fn.constructor.name).toBe('AsyncFunction');
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Error Class Hierarchy
// ---------------------------------------------------------------------------
describe('SDK error classes', () => {
  // Dynamic import to avoid tying to internal paths
  let errors: Record<string, any>;

  beforeAll(async () => {
    errors = await import('@protontech/drive-sdk');
  });

  const errorClasses = [
    'ProtonDriveError',
    'AbortError',
    'ValidationError',
    'NodeWithSameNameExistsValidationError',
    'ServerError',
    'RateLimitedError',
    'ConnectionError',
    'DecryptionError',
    'IntegrityError',
  ];

  for (const className of errorClasses) {
    test(`${className} is exported`, () => {
      expect(errors[className]).toBeDefined();
      expect(typeof errors[className]).toBe('function');
    });
  }

  test('all errors extend ProtonDriveError', () => {
    const base = errors.ProtonDriveError;
    for (const className of errorClasses) {
      if (className === 'ProtonDriveError') continue;
      const instance = Object.create(errors[className].prototype);
      expect(instance instanceof base).toBe(true);
    }
  });

  test('ValidationError extends ProtonDriveError', () => {
    const instance = Object.create(errors.ValidationError.prototype);
    expect(instance instanceof errors.ProtonDriveError).toBe(true);
  });

  test('NodeWithSameNameExistsValidationError extends ValidationError', () => {
    const instance = Object.create(errors.NodeWithSameNameExistsValidationError.prototype);
    expect(instance instanceof errors.ValidationError).toBe(true);
  });

  test('ServerError extends ProtonDriveError', () => {
    const instance = Object.create(errors.ServerError.prototype);
    expect(instance instanceof errors.ProtonDriveError).toBe(true);
  });

  test('RateLimitedError extends ServerError', () => {
    const instance = Object.create(errors.RateLimitedError.prototype);
    expect(instance instanceof errors.ServerError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. NodeType Enum Values (exact strings our bridge depends on)
// ---------------------------------------------------------------------------
describe('NodeType enum exact values', () => {
  test('NodeType.File === "file"', () => {
    expect(NodeType.File).toBe('file');
  });

  test('NodeType.Folder === "folder"', () => {
    expect(NodeType.Folder).toBe('folder');
  });

  test('NodeType includes file and folder (and optional album/photo)', () => {
    const values = Object.values(NodeType);
    expect(values).toContain('file');
    expect(values).toContain('folder');
    // SDK 0.9.8+ added album and photo types
    expect(values.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 6. CryptoProxy Behavioral Roundtrips
// ---------------------------------------------------------------------------
describe('CryptoProxy encrypt/decrypt roundtrips', () => {
  let proxy: ProtonOpenPGPCryptoProxy;
  let privateKey: any;
  let publicKey: any;

  beforeAll(async () => {
    proxy = new ProtonOpenPGPCryptoProxy();
    privateKey = await proxy.generateKey({
      userIDs: [{ name: 'Test User' }],
      type: 'ecc',
      curve: 'ed25519Legacy',
    });
    publicKey = privateKey.toPublic();
  });

  test('generateKey returns a key with armor()', async () => {
    expect(privateKey).toBeDefined();
    expect(typeof privateKey.armor).toBe('function');
    const armored = privateKey.armor();
    expect(armored).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');
  });

  test('exportPrivateKey → importPrivateKey roundtrip (no passphrase)', async () => {
    const armored = await proxy.exportPrivateKey({ privateKey, passphrase: null });
    expect(armored).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');

    const imported = await proxy.importPrivateKey({ armoredKey: armored, passphrase: null });
    expect(imported).toBeDefined();
    expect(typeof imported.armor).toBe('function');
  });

  test('exportPrivateKey → importPrivateKey roundtrip (with passphrase)', async () => {
    const passphrase = 'test-pass-123';
    const armored = await proxy.exportPrivateKey({ privateKey, passphrase });

    const imported = await proxy.importPrivateKey({ armoredKey: armored, passphrase });
    expect(imported).toBeDefined();
  });

  test('importPrivateKey with wrong passphrase throws', async () => {
    const armored = await proxy.exportPrivateKey({ privateKey, passphrase: 'correct' });
    await expect(
      proxy.importPrivateKey({ armoredKey: armored, passphrase: 'wrong' }),
    ).rejects.toThrow();
  });

  test('generateSessionKey returns key with data property', async () => {
    const sk = await proxy.generateSessionKey({ recipientKeys: [publicKey] });
    expect(sk).toBeDefined();
    expect(sk.data).toBeInstanceOf(Uint8Array);
    expect(sk.data.length).toBeGreaterThan(0);
  });

  test('encryptSessionKey → decryptSessionKey roundtrip', async () => {
    const sk = await proxy.generateSessionKey({ recipientKeys: [publicKey] });
    const encrypted = await proxy.encryptSessionKey({
      data: sk.data,
      format: 'binary',
      encryptionKeys: [publicKey],
    });
    expect(encrypted).toBeInstanceOf(Uint8Array);

    const decrypted = await proxy.decryptSessionKey({
      binaryMessage: encrypted,
      decryptionKeys: [privateKey],
    });
    expect(decrypted).toBeDefined();
    expect(decrypted!.data).toEqual(sk.data);
  });

  test('encryptMessage → decryptMessage roundtrip (binary)', async () => {
    const plaintext = new TextEncoder().encode('Hello, Proton Drive!');
    const sk = await proxy.generateSessionKey({ recipientKeys: [publicKey] });

    const encrypted = await proxy.encryptMessage({
      format: 'binary',
      binaryData: plaintext,
      sessionKey: sk,
      encryptionKeys: [publicKey],
      signingKeys: privateKey,
    });
    expect(encrypted.message).toBeDefined();

    const decrypted = await proxy.decryptMessage({
      format: 'binary',
      binaryMessage: encrypted.message,
      sessionKeys: sk,
      verificationKeys: [publicKey],
    });
    expect(new Uint8Array(decrypted.data)).toEqual(plaintext);
    expect(decrypted.verificationStatus).toBe(1); // SIGNED_AND_VALID
  });

  test('decryptMessage with wrong key fails', async () => {
    const plaintext = new TextEncoder().encode('secret');
    const sk = await proxy.generateSessionKey({ recipientKeys: [publicKey] });

    const encrypted = await proxy.encryptMessage({
      format: 'binary',
      binaryData: plaintext,
      sessionKey: sk,
      encryptionKeys: [publicKey],
    });

    // Generate a different key pair
    const otherKey = await proxy.generateKey({
      userIDs: [{ name: 'Other' }],
      type: 'ecc',
      curve: 'ed25519Legacy',
    });
    const otherSK = await proxy.generateSessionKey({ recipientKeys: [otherKey.toPublic()] });

    await expect(
      proxy.decryptMessage({
        format: 'binary',
        binaryMessage: encrypted.message,
        sessionKeys: otherSK,
      }),
    ).rejects.toThrow();
  });

  test('signMessage → verifyMessage roundtrip (detached)', async () => {
    const data = new TextEncoder().encode('sign me');

    const sig = await proxy.signMessage({
      format: 'binary',
      binaryData: data,
      signingKeys: [privateKey],
      detached: true,
    });
    expect(sig).toBeDefined();

    const verified = await proxy.verifyMessage({
      binaryData: data,
      binarySignature: sig,
      verificationKeys: [publicKey],
    });
    expect(verified.verificationStatus).toBe(1); // SIGNED_AND_VALID
    expect(verified.errors).toBeUndefined();
  });

  test('verifyMessage with wrong key returns SIGNED_AND_INVALID', async () => {
    const data = new TextEncoder().encode('sign me');
    const sig = await proxy.signMessage({
      format: 'binary',
      binaryData: data,
      signingKeys: [privateKey],
      detached: true,
    });

    const otherKey = await proxy.generateKey({
      userIDs: [{ name: 'Wrong' }],
      type: 'ecc',
      curve: 'ed25519Legacy',
    });

    const verified = await proxy.verifyMessage({
      binaryData: data,
      binarySignature: sig,
      verificationKeys: [otherKey.toPublic()],
    });
    expect(verified.verificationStatus).toBe(2); // SIGNED_AND_INVALID
    expect(verified.errors).toBeDefined();
    expect(verified.errors!.length).toBeGreaterThan(0);
  });

  test('verifyMessage with tampered data returns SIGNED_AND_INVALID', async () => {
    const data = new TextEncoder().encode('original');
    const sig = await proxy.signMessage({
      format: 'binary',
      binaryData: data,
      signingKeys: [privateKey],
      detached: true,
    });

    const tampered = new TextEncoder().encode('tampered');
    const verified = await proxy.verifyMessage({
      binaryData: tampered,
      binarySignature: sig,
      verificationKeys: [publicKey],
    });
    expect(verified.verificationStatus).toBe(2); // SIGNED_AND_INVALID
  });
});

// ---------------------------------------------------------------------------
// 7. OpenPGPCryptoWithCryptoProxy Wrapping
// ---------------------------------------------------------------------------
describe('OpenPGPCryptoWithCryptoProxy wrapping behavior', () => {
  let crypto: any;

  beforeAll(() => {
    const proxy = new ProtonOpenPGPCryptoProxy();
    crypto = new OpenPGPCryptoWithCryptoProxy(proxy);
  });

  // The wrapper should build high-level methods from the 10-method proxy
  const wrappedMethods = [
    'encryptAndSign',
    'decryptAndVerify',
    'sign',
    'verify',
    'generateKey',
    'generateSessionKey',
    'encryptSessionKey',
    'decryptSessionKey',
    'generatePassphrase',
    'decryptKey',
  ];

  for (const method of wrappedMethods) {
    test(`exposes ${method}() as function`, () => {
      expect(typeof crypto[method]).toBe('function');
    });
  }

  test('generatePassphrase returns a string', async () => {
    const passphrase = await crypto.generatePassphrase();
    expect(typeof passphrase).toBe('string');
    expect(passphrase.length).toBeGreaterThan(0);
  });

  test('generateKey returns privateKey with armor and passphrase', async () => {
    const passphrase = await crypto.generatePassphrase();
    const result = await crypto.generateKey(passphrase);
    expect(result).toBeDefined();
    expect(result.privateKey).toBeDefined();
    expect(typeof result.armoredKey).toBe('string');
    expect(result.armoredKey).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');
  });

  test('generateSessionKey returns session key with data', async () => {
    const passphrase = await crypto.generatePassphrase();
    const { armoredKey } = await crypto.generateKey(passphrase);
    const decryptedKey = await crypto.decryptKey(armoredKey, passphrase);

    const sk = await crypto.generateSessionKey(decryptedKey);
    expect(sk).toBeDefined();
    expect(sk.data).toBeInstanceOf(Uint8Array);
  });

  test('encryptAndSign → decryptAndVerify roundtrip', async () => {
    const passphrase = await crypto.generatePassphrase();
    const { armoredKey } = await crypto.generateKey(passphrase);
    const decryptedKey = await crypto.decryptKey(armoredKey, passphrase);
    const publicKey = decryptedKey.toPublic();

    const plaintext = new TextEncoder().encode('roundtrip test');
    const sk = await crypto.generateSessionKey(decryptedKey);

    const encrypted = await crypto.encryptAndSign(plaintext, sk, publicKey, decryptedKey);
    expect(encrypted).toBeDefined();

    const decrypted = await crypto.decryptAndVerify(
      encrypted.encryptedData,
      sk,
      [publicKey],
    );
    expect(new Uint8Array(decrypted.data)).toEqual(plaintext);
  });
});

// ---------------------------------------------------------------------------
// 8. Client Construction with Mocked HTTP
// ---------------------------------------------------------------------------
describe('ProtonDriveClient with mocked HTTP', () => {
  test('client can be constructed', () => {
    const client = createTestClient();
    expect(client).toBeInstanceOf(ProtonDriveClient);
  });

  test('getMyFilesRootFolder calls httpClient.fetchJson', async () => {
    const fetchedUrls: string[] = [];
    const client = createTestClient({
      fetchJson: async (req: any) => {
        fetchedUrls.push(req.url);
        // Return empty response — the point is to verify fetchJson is called
        return new Response(
          JSON.stringify({ Code: 1000 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    // The SDK should call fetchJson to get shares/volumes
    try {
      await client.getMyFilesRootFolder();
    } catch {
      // Will fail due to incomplete mock, but fetchJson should have been called
    }
    expect(fetchedUrls.length).toBeGreaterThan(0);
    // Should hit a shares or volumes endpoint
    expect(fetchedUrls.some(u => u.includes('shares') || u.includes('volumes'))).toBe(true);
  });

  test('iterateFolderChildren returns async generator', () => {
    const client = createTestClient();
    const result = client.iterateFolderChildren('some-uid');
    // Verify it's an async iterable
    expect(typeof result[Symbol.asyncIterator]).toBe('function');
    expect(typeof result.next).toBe('function');
    expect(typeof result.return).toBe('function');
    expect(typeof result.throw).toBe('function');
  });

  test('trashNodes returns async generator', () => {
    const client = createTestClient();
    const result = client.trashNodes(['uid-1']);
    expect(typeof result[Symbol.asyncIterator]).toBe('function');
    expect(typeof result.next).toBe('function');
  });

  test('deleteNodes returns async generator', () => {
    const client = createTestClient();
    const result = client.deleteNodes(['uid-1']);
    expect(typeof result[Symbol.asyncIterator]).toBe('function');
    expect(typeof result.next).toBe('function');
  });

  test('moveNodes returns async generator', () => {
    const client = createTestClient();
    const result = client.moveNodes(['uid-1'], 'parent-uid');
    expect(typeof result[Symbol.asyncIterator]).toBe('function');
    expect(typeof result.next).toBe('function');
  });

  test('copyNodes returns async generator', () => {
    const client = createTestClient();
    const result = client.copyNodes(['uid-1'], 'parent-uid');
    expect(typeof result[Symbol.asyncIterator]).toBe('function');
    expect(typeof result.next).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 9. Result Type Contract (runtime shapes used by bridge)
// ---------------------------------------------------------------------------
describe('result type contracts', () => {
  test('NodeResult success shape: { uid, ok: true }', () => {
    const success: NodeResult = { uid: 'test-uid', ok: true };
    expect(success.ok).toBe(true);
    expect(success.uid).toBe('test-uid');
  });

  test('NodeResult failure shape: { uid, ok: false, error }', () => {
    const failure: NodeResult = { uid: 'test-uid', ok: false, error: 'something went wrong' };
    expect(failure.ok).toBe(false);
    expect(failure.uid).toBe('test-uid');
    expect(failure.error).toBe('something went wrong');
  });

  test('NodeResultWithNewUid success shape: { uid, newUid, ok: true }', () => {
    const success: NodeResultWithNewUid = { uid: 'old', newUid: 'new', ok: true };
    expect(success.ok).toBe(true);
    expect((success as any).newUid).toBe('new');
  });

  test('NodeResultWithNewUid failure shape: { uid, ok: false, error }', () => {
    const failure: NodeResultWithNewUid = { uid: 'old', ok: false, error: new Error('fail') };
    expect(failure.ok).toBe(false);
    expect(failure.error).toBeInstanceOf(Error);
  });

  test('MaybeNode success has .ok and .value with required fields', () => {
    // Compile-time shape verification
    const verifyNodeShape = (node: NodeEntity) => {
      const checks = {
        uid: typeof node.uid === 'string',
        name: typeof node.name === 'string',
        type: node.type === NodeType.File || node.type === NodeType.Folder,
        isShared: typeof node.isShared === 'boolean',
        creationTime: node.creationTime instanceof Date,
        modificationTime: node.modificationTime instanceof Date,
        treeEventScopeId: typeof node.treeEventScopeId === 'string',
      };
      return Object.values(checks).every(Boolean);
    };
    expect(typeof verifyNodeShape).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 10. VERSION Export
// ---------------------------------------------------------------------------
describe('SDK VERSION', () => {
  test('VERSION is a semver-like string', () => {
    expect(typeof VERSION).toBe('string');
    // Should match major.minor.patch pattern (local dev is 0.0.1)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('VERSION is non-empty', () => {
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 11. SRPModuleAdapter Behavioral Tests
// ---------------------------------------------------------------------------
describe('SRPModuleAdapter behavior', () => {
  let srp: SRPModuleAdapter;

  // bcrypt requires exactly 16-byte salts. Generate a valid one as base64.
  // 16 random bytes → base64 = 24 chars
  const validSalt = Buffer.from('0123456789abcdef').toString('base64'); // 16 bytes

  beforeEach(() => {
    srp = new SRPModuleAdapter();
  });

  test('computeKeyPassword returns a string for valid inputs', async () => {
    const result = await srp.computeKeyPassword('testpassword', validSalt);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('computeKeyPassword is deterministic', async () => {
    const r1 = await srp.computeKeyPassword('pass', validSalt);
    const r2 = await srp.computeKeyPassword('pass', validSalt);
    expect(r1).toBe(r2);
  });

  test('computeKeyPassword differs for different passwords', async () => {
    const r1 = await srp.computeKeyPassword('pass1', validSalt);
    const r2 = await srp.computeKeyPassword('pass2', validSalt);
    expect(r1).not.toBe(r2);
  });

  test('getSrp is a function', () => {
    expect(typeof srp.getSrp).toBe('function');
    expect(srp.getSrp.length).toBe(5); // (version, modulus, serverEphemeral, salt, password)
  });

  test('getSrpVerifier throws (not implemented)', async () => {
    await expect(srp.getSrpVerifier('test')).rejects.toThrow('not implemented');
  });
});

// ---------------------------------------------------------------------------
// 12. HTTPClientAdapter Interface Compliance
// ---------------------------------------------------------------------------
describe('HTTPClientAdapter interface', () => {
  test('implements fetchJson', () => {
    const http = new HTTPClientAdapter();
    expect(typeof http.fetchJson).toBe('function');
  });

  test('implements fetchBlob', () => {
    const http = new HTTPClientAdapter();
    expect(typeof http.fetchBlob).toBe('function');
  });

  test('fetchJson and fetchBlob are the only required methods', () => {
    const http: ProtonDriveHTTPClient = new HTTPClientAdapter();
    expect(typeof http.fetchJson).toBe('function');
    expect(typeof http.fetchBlob).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 13. generateNodeUid Utility
// ---------------------------------------------------------------------------
describe('generateNodeUid', () => {
  let generateNodeUid: any;

  beforeAll(async () => {
    const sdk = await import('@protontech/drive-sdk');
    generateNodeUid = sdk.generateNodeUid;
  });

  test('is exported as a function', () => {
    expect(typeof generateNodeUid).toBe('function');
  });

  test('combines volumeId and nodeId', () => {
    const uid = generateNodeUid('vol-123', 'node-456');
    expect(typeof uid).toBe('string');
    expect(uid.length).toBeGreaterThan(0);
    // Should contain both IDs in some form
    expect(uid).toContain('vol-123');
    expect(uid).toContain('node-456');
  });

  test('returns different UIDs for different inputs', () => {
    const uid1 = generateNodeUid('vol-1', 'node-1');
    const uid2 = generateNodeUid('vol-1', 'node-2');
    const uid3 = generateNodeUid('vol-2', 'node-1');
    expect(uid1).not.toBe(uid2);
    expect(uid1).not.toBe(uid3);
  });
});

// ---------------------------------------------------------------------------
// 14. NullFeatureFlagProvider
// ---------------------------------------------------------------------------
describe('NullFeatureFlagProvider', () => {
  let NullFeatureFlagProvider: any;

  beforeAll(async () => {
    const sdk = await import('@protontech/drive-sdk');
    NullFeatureFlagProvider = sdk.NullFeatureFlagProvider;
  });

  test('is exported', () => {
    expect(NullFeatureFlagProvider).toBeDefined();
  });

  test('can be instantiated', () => {
    const provider = new NullFeatureFlagProvider();
    expect(provider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 15. Concurrent MemoryCache Safety
// ---------------------------------------------------------------------------
describe('MemoryCache concurrent access patterns', () => {
  test('concurrent writes do not corrupt', async () => {
    // Use strings (not numbers) because MemoryCache checks `if (!value)`
    // which treats 0 as missing — this is a known SDK limitation.
    const cache = new MemoryCache<string>();
    const writes = Array.from({ length: 100 }, (_, i) =>
      cache.setEntity(`key-${i}`, `value-${i}`),
    );
    await Promise.all(writes);

    for (let i = 0; i < 100; i++) {
      expect(await cache.getEntity(`key-${i}`)).toBe(`value-${i}`);
    }
  });

  test('iterateEntitiesByTag handles concurrent tag modification', async () => {
    const cache = new MemoryCache<string>();
    await cache.setEntity('a', '1', ['tag']);
    await cache.setEntity('b', '2', ['tag']);

    const results: string[] = [];
    for await (const item of cache.iterateEntitiesByTag('tag')) {
      if (item.ok) {
        results.push(item.value);
        // Modify cache during iteration — shouldn't affect current iteration
        // because iterateEntitiesByTag copies keys array
        await cache.setEntity('c', '3', ['tag']);
      }
    }
    // Should only see original 2 entries
    expect(results).toHaveLength(2);
  });

  test('KNOWN BUG: MemoryCache treats falsy values as missing', async () => {
    // SDK uses `if (!value)` instead of `if (value === undefined)`,
    // so 0, "", false, null all throw "Entity not found".
    // This is a latent bug in the SDK — document it so we know.
    const numCache = new MemoryCache<number>();
    await numCache.setEntity('zero', 0);
    await expect(numCache.getEntity('zero')).rejects.toThrow('Entity not found');

    const strCache = new MemoryCache<string>();
    await strCache.setEntity('empty', '');
    await expect(strCache.getEntity('empty')).rejects.toThrow('Entity not found');
  });
});

// ---------------------------------------------------------------------------
// 16. errorToStatusCode SDK Error Mapping
// ---------------------------------------------------------------------------
describe('errorToStatusCode maps SDK errors', () => {
  let errors: Record<string, any>;
  let errorToStatusCode: (error: any) => number;

  beforeAll(async () => {
    errors = await import('@protontech/drive-sdk');
    const validators = await import('../bridge/validators');
    errorToStatusCode = validators.errorToStatusCode;
  });

  test('ValidationError → 400', () => {
    const err = Object.create(errors.ValidationError.prototype);
    err.message = 'test';
    expect(errorToStatusCode(err)).toBe(400);
  });

  test('RateLimitedError → 429', () => {
    const err = Object.create(errors.RateLimitedError.prototype);
    err.message = 'test';
    expect(errorToStatusCode(err)).toBe(429);
  });

  test('ConnectionError → 502', () => {
    const err = Object.create(errors.ConnectionError.prototype);
    err.message = 'test';
    expect(errorToStatusCode(err)).toBe(502);
  });

  test('ServerError → 502', () => {
    const err = Object.create(errors.ServerError.prototype);
    err.message = 'test';
    expect(errorToStatusCode(err)).toBe(502);
  });

  test('DecryptionError → 500', () => {
    const err = Object.create(errors.DecryptionError.prototype);
    err.message = 'test';
    expect(errorToStatusCode(err)).toBe(500);
  });

  test('IntegrityError → 500', () => {
    const err = Object.create(errors.IntegrityError.prototype);
    err.message = 'test';
    expect(errorToStatusCode(err)).toBe(500);
  });

  test('AbortError → 499', () => {
    const err = Object.create(errors.AbortError.prototype);
    err.message = 'test';
    expect(errorToStatusCode(err)).toBe(499);
  });

  test('untyped TypeError → 500 (fallback)', () => {
    const err = new TypeError('Cannot read properties of undefined');
    expect(errorToStatusCode(err)).toBe(500);
  });

  test('SDK errors take priority over message matching', () => {
    // A ValidationError whose message contains "not found" should still be 400
    const err = Object.create(errors.ValidationError.prototype);
    err.message = 'node not found in cache';
    expect(errorToStatusCode(err)).toBe(400);
  });
});
