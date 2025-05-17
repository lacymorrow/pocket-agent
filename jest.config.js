module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/?(*.)+(spec|test).+(ts|tsx|js)',
  ],
  // transform: {
  //   '^.+\\.(ts|tsx)$': 'ts-jest', // If you decide to use TypeScript later
  // },
  moduleNameMapper: {
    // Handle module aliases (if you have them in tsconfig.json)
    '^vscode$': '<rootDir>/__mocks__/vscode.js' // Ensure this is correctly pointing
  },
  // setupFilesAfterEnv: ['./jest.setup.js'], // Optional: for setup tasks before each test file; ensure this file exists if uncommented
  // Automatically clear mock calls and instances before every test
  clearMocks: true,

  // Collect coverage information
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageProvider: 'v8', // or 'babel'
  coverageReporters: ['text', 'lcov'],

  // A list of paths to modules that run some code to configure or set up the testing framework before each test
  // setupFilesAfterEnv: ['<rootDir>/jest.setup.js'], // Example setup file

};
