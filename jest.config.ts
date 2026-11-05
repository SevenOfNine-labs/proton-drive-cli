export default {
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/submodules/'],
  // The vendored Proton SDK dist is ESM (swc output since the upstream Bun
  // migration in js/v0.19+), so it must be transpiled to CommonJS for Jest.
  // tsconfig.jest.json enables allowJs for that; a single ts-jest transform
  // entry is required because ts-jest shares one config set per preset.
  transformIgnorePatterns: [
    'node_modules/(?!(chalk|#ansi-styles|ansi-styles|@protontech/crypto)/)',
    '<rootDir>/submodules/(?!sdk/client/js/)',
  ],
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { useESM: false, tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleNameMapper: {
    '#ansi-styles': 'ansi-styles',
    '^@protontech/crypto$': '<rootDir>/src/test/shims/protontechCrypto.ts',
    '^@protontech/crypto/subtle/hmac\\.ts$': '<rootDir>/src/test/shims/protontechCryptoHmac.ts',
    '^@protontech/crypto/subtle/hash\\.ts$': '<rootDir>/src/test/shims/protontechCryptoHash.ts',
  },
};
