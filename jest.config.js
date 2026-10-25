export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|mjs|ts|mts)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid|open)/)', // uuid and open are ESM modules that need to be transformed
  ],
  globals: {
    'jest': {
      useESM: true
    }
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    'api-integration\\.test\\.js',
    '/tests/e2e/'
  ],
  testMatch: [
    '**/tests/**/*.test.{js,ts}'
  ],
  collectCoverageFrom: [
    'src/**/*.{js,ts}',
    '!src/**/*.test.{js,ts}',
    // 用户插件目录是 gitignored 的本地数据，不参与仓库覆盖率基线
    '!src/plugins-user/**',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000 // Add a global test timeout
};