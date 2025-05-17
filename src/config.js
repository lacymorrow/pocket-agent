const vscode = require('vscode');
const { DEFAULT_SERVER_URL, DEFAULT_CURSOR_DEBUG_PORT } = require('./constants');
const { log, logError, logWarn } = require('./logger'); // Assuming logger is already initialized by plugin activation

let currentConfig = {
    serverUrl: DEFAULT_SERVER_URL,
    debugPort: DEFAULT_CURSOR_DEBUG_PORT,
};

let configListenerDisposable = null;

function loadConfiguration() {
    const configuration = vscode.workspace.getConfiguration('pocketAgent');
    const serverUrl = configuration.get('serverUrl', DEFAULT_SERVER_URL);
    const debugPort = configuration.get('debugPort', DEFAULT_CURSOR_DEBUG_PORT);

    currentConfig = {
        serverUrl: serverUrl || DEFAULT_SERVER_URL, // Ensure fallback if empty string or null is somehow returned
        debugPort: (typeof debugPort === 'number' && !Number.isNaN(debugPort)) ? debugPort : DEFAULT_CURSOR_DEBUG_PORT,
    };

    // Initial log of loaded config - can be removed if too verbose or handled by caller
    // log(`Config loaded: Server URL = ${currentConfig.serverUrl}, Debug Port = ${currentConfig.debugPort}`);
}

function initializeConfig() {
    loadConfiguration(); // Load initial config

    // Dispose any existing listener before creating a new one
    disposeConfigListener();

    configListenerDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('pocketAgent')) {
            log('Pocket Agent: Configuration section "pocketAgent" changed. Reloading settings...');
            loadConfiguration();
            log(`Pocket Agent: New Server URL: ${currentConfig.serverUrl}`);
            log(`Pocket Agent: New Cursor Debug Port: ${currentConfig.debugPort}`);
        }
    });
}

function getConfig() {
    return { ...currentConfig }; // Return a copy to prevent direct modification
}

function getServerUrl() {
    return currentConfig.serverUrl;
}

function getDebugPort() {
    return currentConfig.debugPort;
}

function disposeConfigListener() {
    if (configListenerDisposable) {
        configListenerDisposable.dispose();
        configListenerDisposable = null;
    }
}

module.exports = {
    initializeConfig,
    getConfig,
    getServerUrl,
    getDebugPort,
    disposeConfigListener,
};
