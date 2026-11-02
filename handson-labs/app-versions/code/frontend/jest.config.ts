import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^([.]{1,2}/.*)[.]js$': '$1',
    '^uuid$': '<rootDir>/tests/__mocks__/uuid.ts',
    '^ioredis$': '<rootDir>/tests/__mocks__/ioredis.ts',
  },
  transform: {
    '^.+[.]ts$': [
      'ts-jest',
      {
        useESM: true,
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coveragePathIgnorePatterns: ['/src/index.ts$', '/src/instrumentation.ts$'],
  injectGlobals: true,
};

export default config;
