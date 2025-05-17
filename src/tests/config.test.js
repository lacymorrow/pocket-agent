const vscode = require('vscode');
const { initializeConfig, getConfig, getServerUrl, getDebugPort, disposeConfigListener } = require('../config');
const { DEFAULT_SERVER_URL, DEFAULT_CURSOR_DEBUG_PORT } = require('../constants');

describe('Config Module', () => {
  let mockGetConfiguration;
  let mockWorkspace;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock vscode.workspace.getConfiguration
    mockGetConfiguration = jest.fn();
    vscode.workspace.getConfiguration = jest.fn(() => ({
      get: mockGetConfiguration,
      // Add other methods like 'has', 'inspect', 'update' if your config module uses them
    }));

    // Mock onDidChangeConfiguration
    // Store the listener to simulate a change event
    let configChangeListener;
    vscode.workspace.onDidChangeConfiguration = jest.fn(listener => {
      configChangeListener = listener;
      return { dispose: jest.fn() }; // Return a disposable
    });

    // Helper to simulate a configuration change
    mockWorkspace = {
      triggerConfigChange: (e) => {
        if (configChangeListener) {
          configChangeListener(e);
        }
      }
    };
  });

  afterEach(() => {
    disposeConfigListener(); // Ensure listener is disposed if active
  });

  it('should initialize with default values if no settings are present', () => {
    mockGetConfiguration.mockImplementation((key) => {
      if (key === 'serverUrl') return undefined;
      if (key === 'debugPort') return undefined;
      return undefined;
    });

    initializeConfig();
    const config = getConfig();

    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('pocketAgent');
    expect(config.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(config.debugPort).toBe(DEFAULT_CURSOR_DEBUG_PORT);
    expect(getServerUrl()).toBe(DEFAULT_SERVER_URL);
    expect(getDebugPort()).toBe(DEFAULT_CURSOR_DEBUG_PORT);
  });

  it('should load values from VS Code settings if present', () => {
    const customServerUrl = 'http://custom.server:1234';
    const customDebugPort = 9999;
    mockGetConfiguration.mockImplementation((key) => {
      if (key === 'serverUrl') return customServerUrl;
      if (key === 'debugPort') return customDebugPort;
      return undefined;
    });

    initializeConfig();
    const config = getConfig();

    expect(config.serverUrl).toBe(customServerUrl);
    expect(config.debugPort).toBe(customDebugPort);
    expect(getServerUrl()).toBe(customServerUrl);
    expect(getDebugPort()).toBe(customDebugPort);
  });

  it('should update configuration when VS Code settings change', () => {
    // Initial load
    mockGetConfiguration.mockReturnValueOnce(DEFAULT_SERVER_URL) // for serverUrl
                        .mockReturnValueOnce(DEFAULT_CURSOR_DEBUG_PORT); // for debugPort
    initializeConfig();

    expect(getServerUrl()).toBe(DEFAULT_SERVER_URL);
    expect(getDebugPort()).toBe(DEFAULT_CURSOR_DEBUG_PORT);

    // Simulate a change
    const newServerUrl = 'http://new.server:5678';
    const newDebugPort = 1111;

    // Setup getConfiguration to return new values for the *next* call
    // This simulates vscode.workspace.getConfiguration being called again after a change
    vscode.workspace.getConfiguration.mockImplementation(() => ({
        get: jest.fn(key => {
            if (key === 'serverUrl') return newServerUrl;
            if (key === 'debugPort') return newDebugPort;
            return undefined;
        })
    }));

    // Trigger the change event, ensuring it affects 'pocketAgent'
    mockWorkspace.triggerConfigChange({ affectsConfiguration: (section) => section === 'pocketAgent' });

    expect(getServerUrl()).toBe(newServerUrl);
    expect(getDebugPort()).toBe(newDebugPort);
    const updatedConfig = getConfig();
    expect(updatedConfig.serverUrl).toBe(newServerUrl);
    expect(updatedConfig.debugPort).toBe(newDebugPort);
  });

  it('should not update if the change does not affect pocketAgent configuration', () => {
    mockGetConfiguration.mockReturnValueOnce(DEFAULT_SERVER_URL)
                        .mockReturnValueOnce(DEFAULT_CURSOR_DEBUG_PORT);
    initializeConfig();

    expect(getServerUrl()).toBe(DEFAULT_SERVER_URL);

    // Simulate a change that does not affect pocketAgent
    vscode.workspace.getConfiguration.mockImplementation(() => ({
        get: jest.fn(key => {
            if (key === 'serverUrl') return 'http://other.change'; // Should not be picked up
            return undefined;
        })
    }));
    mockWorkspace.triggerConfigChange({ affectsConfiguration: (section) => section === 'anotherExtension' });

    expect(getServerUrl()).toBe(DEFAULT_SERVER_URL); // Should remain unchanged
  });

   it('disposeConfigListener should dispose the listener if it exists', () => {
    const mockDisposable = { dispose: jest.fn() };
    vscode.workspace.onDidChangeConfiguration = jest.fn(() => mockDisposable);

    initializeConfig(); // This will set up the listener
    expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled();

    disposeConfigListener();
    expect(mockDisposable.dispose).toHaveBeenCalled();
  });

  it('disposeConfigListener should not throw if listener does not exist', () => {
    // Ensure listener is not set up or already disposed
    vscode.workspace.onDidChangeConfiguration = jest.fn(() => ({ dispose: jest.fn() }));
    initializeConfig();
    disposeConfigListener(); // First dispose

    expect(() => disposeConfigListener()).not.toThrow(); // Second dispose should not throw
  });

});
