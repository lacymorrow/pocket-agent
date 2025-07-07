const vscode = require('vscode');
const { DEFAULT_SERVER_URL, DEFAULT_CURSOR_DEBUG_PORT } = require('./constants');
const { log, logError, logWarn } = require('./logger'); // Assuming logger is already initialized by plugin activation

let config = null;
let configDisposable = null;

function initializeConfig(context) {
    if (!context) return;

    const configuration = vscode.workspace.getConfiguration('pocketAgent');
    config = {
        serverUrl: configuration.get('serverUrl') || process.env.POCKET_AGENT_SERVER_URL || 'http://localhost:3000', // Updated to point to frontend
        debugPort: configuration.get('debugPort') || process.env.CURSOR_DEBUG_PORT || 9223
    };

    configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pocketAgent')) {
            const newConfiguration = vscode.workspace.getConfiguration('pocketAgent');
            config.serverUrl = newConfiguration.get('serverUrl') || process.env.POCKET_AGENT_SERVER_URL || 'http://localhost:3000'; // Updated to point to frontend
            config.debugPort = newConfiguration.get('debugPort') || process.env.CURSOR_DEBUG_PORT || 9223;
            log(`Pocket Agent: Configuration updated. Server URL: ${config.serverUrl}, Debug Port: ${config.debugPort}`);
        }
    });

    log(`Pocket Agent: Configuration initialized. Server URL: ${config.serverUrl}, Debug Port: ${config.debugPort}`);
}

function getConfig() {
    return { ...config }; // Return a copy to prevent direct modification
}

function getServerUrl() {
    return config.serverUrl;
}

function getDebugPort() {
    return config.debugPort;
}

function disposeConfigListener() {
    if (configDisposable) {
        configDisposable.dispose();
        configDisposable = null;
    }
}

module.exports = {
    initializeConfig,
    getConfig,
    getServerUrl,
    getDebugPort,
    disposeConfigListener,
};
