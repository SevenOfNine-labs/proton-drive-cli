export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/submodules/'],
  transformIgnorePatterns: [
    '<rootDir>/submodules/sdk/client/js/dist/',
    'node_modules/(?!(chalk|#ansi-styles|ansi-styles|@protontech/crypto)/)',
    '<rootDir>/submodules/(?!sdk/client/js/)',
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': ['ts-jest', { useESM: false }],
  },
  moduleNameMapper: {
    '#ansi-styles': 'ansi-styles',
    '^@protontech/crypto$': '<rootDir>/src/test/shims/protontechCrypto.ts',
    '^@protontech/crypto/subtle/hmac\\.ts$': '<rootDir>/src/test/shims/protontechCryptoHmac.ts',
    '^@protontech/crypto/subtle/hash\\.ts$': '<rootDir>/src/test/shims/protontechCryptoHash.ts',
  },
};
