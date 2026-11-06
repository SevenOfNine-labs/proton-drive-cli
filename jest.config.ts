export default {
  testEnvironment: 'node',
  // OpenPGP key generation in crypto and conformance tests takes seconds on
  // shared CI runners.
  testTimeout: 60_000,
  testMatch: ['**/src/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/submodules/'],
  // ESM sources Jest must transpile to CommonJS (Jest docs, "ECMAScript
  // Modules"): the vendored SDK dist and the ESM-only p-retry, is-network-error
  // and ky; tsconfig.jest.json enables allowJs for them.
  transformIgnorePatterns: [
    'node_modules/(?!(chalk|#ansi-styles|ansi-styles|@protontech/crypto|@openpgp/web-stream-tools|@noble/hashes|p-retry|is-network-error|ky)/)',
    '<rootDir>/submodules/(?!sdk/client/js/|sdk/incubating/account/js/src/)',
  ],
  transform: {
    // TypeScript outside rootDir src (@protontech/crypto, Proton's account
    // module) is never emitted by tsc; swc transpiles it and the ESM-only
    // packages it imports to CommonJS.
    '(/@protontech/crypto/src/|/@openpgp/web-stream-tools/|/@noble/hashes/|/submodules/sdk/incubating/account/js/src/).+\\.[tj]s$': ['@swc/jest', {
      module: { type: 'commonjs' },
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
    }],
    '^.+\\.[tj]sx?$': ['ts-jest', { useESM: false, tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleNameMapper: {
    '#ansi-styles': 'ansi-styles',
    // @protontech/crypto imports openpgp/lightweight (browser-only "exports" entry); alias to the full package
    '^openpgp/lightweight$': 'openpgp',
    // "exports" of @openpgp/web-stream-tools has only an "import" entry
    '^@openpgp/web-stream-tools$': '<rootDir>/node_modules/@openpgp/web-stream-tools/lib/index.js',
    '^@protontech/crypto/subtle/hmac\\.ts$': '<rootDir>/src/test/shims/protontechCryptoHmac.ts',
    '^@protontech/crypto/subtle/hash\\.ts$': '<rootDir>/src/test/shims/protontechCryptoHash.ts',
  },
};
