export default {
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/submodules/'],
  // The vendored Proton SDK dist is ESM (swc output since the upstream Bun
  // migration in js/v0.19+), so it must be transpiled to CommonJS for Jest;
  // the same applies to the ESM-only packages p-retry and is-network-error.
  // tsconfig.jest.json enables allowJs for that; a single ts-jest transform
  // entry is required because ts-jest shares one config set per preset.
  transformIgnorePatterns: [
    'node_modules/(?!(chalk|#ansi-styles|ansi-styles|@protontech/crypto|@openpgp/web-stream-tools|@noble/hashes|p-retry|is-network-error)/)',
    '<rootDir>/submodules/(?!sdk/client/js/)',
  ],
  transform: {
    // @protontech/crypto ships TypeScript sources inside node_modules, which
    // TypeScript treats as an external library and never emits; swc transpiles
    // them and the ESM-only packages they import to CommonJS (tsc --noEmit
    // type-checks the TypeScript sources separately).
    '(/@protontech/crypto/src/|/@openpgp/web-stream-tools/|/@noble/hashes/).+\\.[tj]s$': ['@swc/jest', {
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
