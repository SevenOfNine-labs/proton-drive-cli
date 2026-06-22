/**
 * SDK Contract Tests
 *
 * These tests verify that the @protontech/drive-sdk public API matches
 * the contracts our code depends on. After `git pull` on the SDK submodule,
 * these tests will FAIL if:
 *
 * 1. The SDK removes or renames a public export
 * 2. ProtonDriveClient constructor parameter shape changes
 * 3. ProtonDriveClient instance method signatures change
 * 4. Adapter interfaces (OpenPGPCryptoProxy, ProtonDriveHTTPClient, ProtonDriveAccount) change
 * 5. Enum values we depend on change (NodeType, etc.)
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
  ProtonDriveHTTPClient,
  ProtonDriveAccount,
  ProtonDriveAccountAddress,
  ProtonDriveClientContructorParameters,
  InvalidNameError,
  MaybeMissingNode,
  NodeEntity,
  NodeResult,
  NodeResultWithNewUid,
  FileDownloader,
  FileUploader,
  Result,
} from '@protontech/drive-sdk';

// Our adapter implementations
import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';
import { HTTPClientAdapter } from './httpClientAdapter';
import { AccountAdapter } from './accountAdapter';
import { SRPModuleAdapter } from './srpAdapter';

// ------------------------------------------------------------------
// 1. SDK Exports
// ------------------------------------------------------------------
describe('SDK exports', () => {
  test('ProtonDriveClient is a constructor', () => {
    expect(typeof ProtonDriveClient).toBe('function');
  });

  test('MemoryCache is a constructor', () => {
    expect(typeof MemoryCache).toBe('function');
    const cache = new MemoryCache();
    expect(cache).toBeDefined();
  });

  test('OpenPGPCryptoWithCryptoProxy is a constructor', () => {
    expect(typeof OpenPGPCryptoWithCryptoProxy).toBe('function');
  });

  test('NodeType enum has File and Folder', () => {
    expect(NodeType.File).toBe('file');
    expect(NodeType.Folder).toBe('folder');
  });

  test('VERSION is a string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------
// 2. ProtonDriveClient Constructor Parameters
// ------------------------------------------------------------------
describe('ProtonDriveClient constructor parameter shape', () => {
  test('ProtonDriveClientContructorParameters has all required keys', () => {
    // This test verifies at compile-time AND runtime that the shape matches
    const requiredKeys: (keyof ProtonDriveClientContructorParameters)[] = [
      'httpClient',
      'entitiesCache',
      'cryptoCache',
      'account',
      'openPGPCryptoModule',
      'srpModule',
    ];
    // If ProtonDriveClientContructorParameters changes, TypeScript will error here
    expect(requiredKeys).toHaveLength(6);
  });

  test('constructor accepts adapter-shaped objects', () => {
    // Verify that our concrete adapter classes are assignable to the expected interfaces.
    // If the SDK changes the interface shape, TypeScript compilation will fail.

    // CryptoProxy: our ProtonOpenPGPCryptoProxy is accepted by the SDK wrapper
    const proxy = new ProtonOpenPGPCryptoProxy();
    expect(proxy).toBeDefined();

    // HTTPClient: our HTTPClientAdapter implements ProtonDriveHTTPClient
    const http: ProtonDriveHTTPClient = new HTTPClientAdapter();
    expect(http).toBeDefined();

    // SRPModule: our SRPModuleAdapter (type-checked at compile time)
    const srp = new SRPModuleAdapter();
    expect(srp).toBeDefined();
  });
});

// ------------------------------------------------------------------
// 3. ProtonDriveClient Instance Method Signatures
// ------------------------------------------------------------------
describe('ProtonDriveClient instance methods', () => {
  // We create a real client with mock adapters to check method existence.
  // No API calls are made — we just verify the methods exist on the prototype.

  const methodNames = [
    // Core file operations (used by bridge)
    'getMyFilesRootFolder',
    'iterateFolderChildren',
    'getNode',
    'createFolder',
    'getFileDownloader',
    'getFileUploader',
    // Node management (used by rm, mv, bridge delete)
    'trashNodes',
    'deleteNodes',
    'moveNodes',
    'renameNode',
    // Additional (used by some CLI commands)
    'iterateTrashedNodes',
    'restoreNodes',
    'copyNodes',
    'emptyTrash',
    'getAvailableName',
    'getNodeUid',
    'iterateNodes',
  ] as const;

  for (const method of methodNames) {
    test(`has method: ${method}`, () => {
      expect(typeof ProtonDriveClient.prototype[method]).toBe('function');
    });
  }
});

// ------------------------------------------------------------------
// 4. Adapter Interface Compliance
// ------------------------------------------------------------------
describe('adapter interface compliance', () => {
  describe('ProtonOpenPGPCryptoProxy methods', () => {
    const proxy = new ProtonOpenPGPCryptoProxy();
    const expectedMethods = [
      'generateKey',
      'exportPrivateKey',
      'importPrivateKey',
      'generateSessionKey',
      'encryptSessionKey',
      'decryptSessionKey',
      'encryptMessage',
      'decryptMessage',
      'signMessage',
      'verifyMessage',
    ];

    for (const method of expectedMethods) {
      test(`has method: ${method}`, () => {
        expect(typeof (proxy as any)[method]).toBe('function');
      });
    }
  });

  describe('HTTPClientAdapter methods', () => {
    const http = new HTTPClientAdapter();
    const expectedMethods = ['fetchJson', 'fetchBlob'];

    for (const method of expectedMethods) {
      test(`has method: ${method}`, () => {
        expect(typeof (http as any)[method]).toBe('function');
      });
    }
  });

  describe('SRPModuleAdapter methods', () => {
    const srp = new SRPModuleAdapter();
    const expectedMethods = ['getSrp', 'getSrpVerifier', 'computeKeyPassword', 'generateKeySalt'];

    for (const method of expectedMethods) {
      test(`has method: ${method}`, () => {
        expect(typeof (srp as any)[method]).toBe('function');
      });
    }
  });
});

// ------------------------------------------------------------------
// 5. Type Shape Verification (runtime)
// ------------------------------------------------------------------
describe('SDK type shapes', () => {
  test('NodeResult union has ok/uid fields', () => {
    const success: NodeResult = { uid: 'test', ok: true };
    const failure: NodeResult = { uid: 'test', ok: false, error: new Error('fail') };
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
    expect(failure.error.message).toBe('fail');
  });

  test('NodeResultWithNewUid has newUid on success', () => {
    const success: NodeResultWithNewUid = { uid: 'old', newUid: 'new', ok: true };
    const failure: NodeResultWithNewUid = { uid: 'old', ok: false, error: new Error('fail') };
    expect(success.ok).toBe(true);
    expect((success as any).newUid).toBe('new');
    expect(failure.ok).toBe(false);
  });

  test('NodeEntity shape has required fields', () => {
    // Compile-time check: if NodeEntity shape changes, this will error
    const _verifyShape = (node: NodeEntity) => {
      const _uid: string = node.uid;
      const _name: Result<string, Error | InvalidNameError> = node.name;
      const _type: NodeType = node.type;
      const _isShared: boolean = node.isShared;
      const _creationTime: Date = node.creationTime;
      const _modificationTime: Date = node.modificationTime;
      const _treeEventScopeId: string = node.treeEventScopeId;
      // Optional fields
      const _parentUid: string | undefined = node.parentUid;
      const _totalStorageSize: number | undefined = node.totalStorageSize;
    };
    // Just verify the function compiles
    expect(typeof _verifyShape).toBe('function');
  });

  test('ProtonDriveAccountAddress shape', () => {
    const _verifyShape = (addr: ProtonDriveAccountAddress) => {
      const _email: string = addr.email;
      const _addressId: string = addr.addressId;
      const _primaryKeyIndex: number = addr.primaryKeyIndex;
      const _keys: Array<{ id: string; key: any }> = addr.keys;
    };
    expect(typeof _verifyShape).toBe('function');
  });
});

// ------------------------------------------------------------------
// 6. Client Assembly (without authentication)
// ------------------------------------------------------------------
describe('client assembly', () => {
  test('ProtonDriveClient can be constructed with our adapters', () => {
    const proxy = new ProtonOpenPGPCryptoProxy();
    const openPGPCrypto = new OpenPGPCryptoWithCryptoProxy(proxy);
    const http = new HTTPClientAdapter();
    const srp = new SRPModuleAdapter();

    // AccountAdapter requires a DriveCryptoService which needs auth,
    // but we can verify the constructor shape accepts all parameters
    // by using a minimal mock for the account adapter.
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

    const client = new ProtonDriveClient({
      httpClient: http,
      entitiesCache: new MemoryCache(),
      cryptoCache: new MemoryCache(),
      account: mockAccount,
      openPGPCryptoModule: openPGPCrypto,
      srpModule: srp,
    });

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(ProtonDriveClient);

    // Verify key methods exist on the instance (not just prototype)
    expect(typeof client.getMyFilesRootFolder).toBe('function');
    expect(typeof client.iterateFolderChildren).toBe('function');
    expect(typeof client.createFolder).toBe('function');
    expect(typeof client.trashNodes).toBe('function');
    expect(typeof client.deleteNodes).toBe('function');
    expect(typeof client.moveNodes).toBe('function');
    expect(typeof client.renameNode).toBe('function');
    expect(typeof client.getNode).toBe('function');
    expect(typeof client.getFileDownloader).toBe('function');
    expect(typeof client.getFileUploader).toBe('function');
  });
});

// ------------------------------------------------------------------
// 7. OpenPGPCryptoWithCryptoProxy wraps our proxy
// ------------------------------------------------------------------
describe('OpenPGPCryptoWithCryptoProxy', () => {
  test('wraps ProtonOpenPGPCryptoProxy without error', () => {
    const proxy = new ProtonOpenPGPCryptoProxy();
    const crypto = new OpenPGPCryptoWithCryptoProxy(proxy);
    expect(crypto).toBeDefined();
  });

  test('wrapped crypto has expected high-level methods', () => {
    const proxy = new ProtonOpenPGPCryptoProxy();
    const crypto: any = new OpenPGPCryptoWithCryptoProxy(proxy);

    // The wrapper builds high-level methods from the 10-method proxy.
    // These are the key methods the SDK uses internally.
    expect(typeof crypto.encryptAndSign).toBe('function');
    expect(typeof crypto.decryptAndVerify).toBe('function');
    expect(typeof crypto.sign).toBe('function');
    expect(typeof crypto.verify).toBe('function');
    expect(typeof crypto.generateKey).toBe('function');
    expect(typeof crypto.generateSessionKey).toBe('function');
    expect(typeof crypto.encryptSessionKey).toBe('function');
    expect(typeof crypto.decryptSessionKey).toBe('function');
    expect(typeof crypto.generatePassphrase).toBe('function');
    expect(typeof crypto.decryptKey).toBe('function');
  });
});
