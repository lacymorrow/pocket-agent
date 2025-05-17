const vscode = require('vscode');
const { initializeLogger, log, logError, logWarn, getLogger } = require('../logger');

describe('Logger', () => {
  let originalConsoleLog;
  let originalConsoleError;
  let originalConsoleWarn;
  let mockOutputChannel; // This will be the one created by the mock vscode.window.createOutputChannel

  beforeAll(() => {
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
  });

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
    // Spy on console methods for each test to ensure clean assertions
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();

    // Get the globally mocked output channel that vscode.window.createOutputChannel returns
    // Our mock vscode.js ensures createOutputChannel returns a consistent mock
    mockOutputChannel = vscode.window.createOutputChannel('Pocket Agent');
    // Initialize logger for most tests; specific tests can re-initialize if needed
    initializeLogger(mockOutputChannel);
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  describe('initializeLogger and getLogger', () => {
    it('should store the provided output channel, and getLogger should retrieve it', () => {
      // The initializeLogger in beforeEach already used the mockOutputChannel
      // So, vscode.window.createOutputChannel was called with 'Pocket Agent'
      expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Pocket Agent');

      const logger = getLogger();
      expect(logger).toBeDefined();
      // It should be the same instance that our mocked vscode.window.createOutputChannel provided
      expect(logger).toBe(mockOutputChannel);
    });

    it('should allow re-initializing with a different channel', () => {
      const newMockChannel = { appendLine: jest.fn(), name: 'NewChannel' };
      initializeLogger(newMockChannel);
      const logger = getLogger();
      expect(logger).toBe(newMockChannel);
    });

    it('should set logger to null if null is passed', () => {
      initializeLogger(null);
      const logger = getLogger();
      expect(logger).toBeNull();
    });
  });

  describe('log', () => {
    it('should append a simple message to the output channel and console.log', () => {
      log('Test message');
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('Test message');
      expect(console.log).toHaveBeenCalledWith('Test message');
    });

    it('should append a message with optional params to the output channel and console.log', () => {
      log('Test message', 'param1', 123);
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('Test message param1 123');
      expect(console.log).toHaveBeenCalledWith('Test message param1 123');
    });

    it('should fallback to console.warn if output channel is not ready (null)', () => {
      initializeLogger(null); // Simulate channel not being ready
      log('Another test');
      expect(console.warn).toHaveBeenCalledWith('Pocket Agent: pocketAgentOutputChannel not (yet) ready for log:', 'Another test');
      // console.log would still have been called by the logger
      expect(console.log).toHaveBeenCalledWith('Another test');
    });
  });

  describe('logError', () => {
    it('should append an error message to the output channel and console.error', () => {
      logError('Error occurred');
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('ERROR: Error occurred');
      expect(console.error).toHaveBeenCalledWith('ERROR: Error occurred', undefined);
    });

    it('should append an error message with an Error object', () => {
      const error = new Error('Something went wrong');
      logError('Critical failure', error);
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('ERROR: Critical failure Details: Something went wrong');
      expect(console.error).toHaveBeenCalledWith('Critical failure', error);
    });

    it('should append an error message with a string detail', () => {
      logError('Failed task', 'network issue');
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('ERROR: Failed task Details: network issue');
      expect(console.error).toHaveBeenCalledWith('Failed task', 'network issue');
    });

    it('should handle unserializable error object gracefully for output channel message', () => {
      const unserializableError = { toJSON: () => { throw new Error('Cannot serialize'); } };
      logError('Unserializable', unserializableError);
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('ERROR: Unserializable Details: (Unserializable error object)');
      expect(console.error).toHaveBeenCalledWith('Unserializable', unserializableError);
    });

    it('should fallback to console.warn if output channel is not ready (null)', () => {
      initializeLogger(null);
      logError('Error without channel');
      expect(console.warn).toHaveBeenCalledWith('Pocket Agent: pocketAgentOutputChannel not (yet) ready for logError:', 'ERROR: Error without channel');
      // console.error would still be called
      expect(console.error).toHaveBeenCalledWith('ERROR: Error without channel', undefined);
    });
  });

  describe('logWarn', () => {
    it('should append a warning message to the output channel and console.warn', () => {
      logWarn('Warning message');
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('WARN: Warning message');
      expect(console.warn).toHaveBeenCalledWith('WARN: Warning message');
    });

    it('should append a warning message with optional params', () => {
      logWarn('Careful', 'step 1', 'step 2');
      expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('WARN: Careful step 1 step 2');
      expect(console.warn).toHaveBeenCalledWith('WARN: Careful step 1 step 2');
    });

    it('should use console.warn for primary and fallback if channel not ready (null)', () => {
      initializeLogger(null);
      logWarn('Warn without channel');
      // Primary console.warn from logWarn itself
      expect(console.warn).toHaveBeenCalledWith('WARN: Warn without channel');
      // Fallback console.warn due to null channel
      expect(console.warn).toHaveBeenCalledWith('Pocket Agent: pocketAgentOutputChannel not (yet) ready for logWarn:', 'WARN: Warn without channel');
      expect(console.warn).toHaveBeenCalledTimes(2);
    });
  });
});
