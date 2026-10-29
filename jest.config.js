export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|mjs|ts|mts)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    // uuid/open 以及 WebUI 运行时依赖（preact/htm/signals）以 ESM 发布，需要经 babel 转换
    '/node_modules/(?!(uuid|open|preact|@preact|htm)/)',
  ],
  globals: {
    'jest': {
      useESM: true
    }
  },
  moduleNameMapper: {
    '^@ui/(.*)$': '<rootDir>/static/ui/$1',
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
