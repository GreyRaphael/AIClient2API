export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|mjs|ts|mts)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    // open 与 WebUI 运行时依赖（preact/htm/signals）以 ESM 发布，需要经 babel 转换
    '/node_modules/(?!(open|preact|@preact|htm)/)',
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
    '/tests/e2e/'
  ],
  testMatch: [
    '**/tests/**/*.test.{js,ts}'
  ],
  testTimeout: 30000 // Add a global test timeout
};
