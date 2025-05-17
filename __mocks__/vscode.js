const mockOutputChannel = {
  appendLine: jest.fn(),
  show: jest.fn(),
  clear: jest.fn(),
  dispose: jest.fn(),
  hide: jest.fn(),
  name: 'mockOutputChannelName'
};

const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: '',
  show: jest.fn(),
  hide: jest.fn(),
  dispose: jest.fn(),
  alignment: 1, // StatusBarAlignment.Left
  priority: undefined,
  color: undefined,
  backgroundColor: undefined,
  accessibilityInformation: undefined
};

const mockSecretStorage = {
  get: jest.fn(),
  store: jest.fn(),
  delete: jest.fn(),
  onDidChange: jest.fn(() => ({ dispose: jest.fn() }))
};

const mockGlobalState = {
  get: jest.fn(),
  update: jest.fn(),
  setKeysForSync: jest.fn()
};

const mockExtensionContext = {
  extensionPath: '/mock/extension/path',
  storagePath: '/mock/storage/path',
  globalStoragePath: '/mock/global/storage/path',
  logPath: '/mock/log/path',
  secrets: mockSecretStorage,
  globalState: mockGlobalState,
  subscriptions: [],
  workspaceState: {
    get: jest.fn(),
    update: jest.fn()
  },
  extensionMode: 2, // ExtensionMode.Development
  asAbsolutePath: jest.fn(relativePath => `/mock/extension/path/${relativePath}`),
  storageUri: { fsPath: '/mock/storageUri' },
  globalStorageUri: { fsPath: '/mock/globalStorageUri' },
  logUri: { fsPath: '/mock/logUri' },
  extensionUri: { fsPath: '/mock/extensionUri' },
  environmentVariableCollection: {
    persistent: true,
    replace: jest.fn(),
    append: jest.fn(),
    prepend: jest.fn(),
    get: jest.fn(),
    forEach: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
  },
  extension: {
    id: 'mock.extension',
    extensionPath: '/mock/extension/path',
    isActive: true,
    packageJSON: { name: 'mock-extension', version: '0.0.1' },
    extensionKind: 1, // ExtensionKind.UI
    exports: {},
    activate: jest.fn().mockResolvedValue({}),
  }
};

const vscode = {
  window: {
    createOutputChannel: jest.fn(() => mockOutputChannel),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    createStatusBarItem: jest.fn(() => mockStatusBarItem),
    setStatusBarMessage: jest.fn(() => ({ dispose: jest.fn() })),
    withProgress: jest.fn((options, task) => task({ report: jest.fn() }, { isCancellationRequested: false, onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() })) })),
    // Add other window methods as needed
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn(),
      has: jest.fn(),
      inspect: jest.fn(),
      update: jest.fn()
    })),
    onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
    // Add other workspace methods as needed
  },
  commands: {
    executeCommand: jest.fn(),
    registerCommand: jest.fn(() => ({ dispose: jest.fn() }))
  },
  authentication: {
    getSession: jest.fn(),
    onDidChangeSessions: jest.fn(() => ({ dispose: jest.fn() }))
  },
  Uri: {
    file: jest.fn(path => ({ fsPath: path, scheme: 'file', toString: () => `file://${path}` })),
    parse: jest.fn(uriString => ({ fsPath: uriString.replace('file://', ''), scheme: 'file', toString: () => uriString })),
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ProgressLocation: {
    Notification: 15
  },
  ExtensionContext: mockExtensionContext, // Exporting for type consistency if used directly
  // Add other top-level vscode APIs as needed
  version: '1.80.0' // Mock version
};

module.exports = vscode;
