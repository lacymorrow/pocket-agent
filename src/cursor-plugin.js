const vscode = require('vscode');
const { interceptToolCall } = require('./cursor-integration');
const { initSocket } = require('./client/desktop');

function activate(context) {
    console.log('[Event Monitor] Extension activation starting...');

    // Initialize socket connection
    initSocket();

    // Create output channel for event logging
    const outputChannel = vscode.window.createOutputChannel('Cursor Event Monitor');
    outputChannel.show();

    // Log all available commands to help with discovery
    vscode.commands.getCommands(true).then(commands => {
        const cursorCommands = commands.filter(cmd =>
            cmd.toLowerCase().includes('cursor') ||
            cmd.toLowerCase().includes('composer') ||
            cmd.toLowerCase().includes('extension')
        );
        outputChannel.appendLine('Available Cursor Commands:');
        cursorCommands.forEach(cmd => outputChannel.appendLine(`- ${cmd}`));
        outputChannel.appendLine('-------------------');
    });

    function logEvent(source, event) {
        // Filter out noise but keep important cursor and anysphere events
        const filterPatterns = [
            'extension-output-cursor-event-monitor',
            'extension-output-cursor-tools.cursor-pocket-agent'
        ];

        const keepPatterns = [
            'anysphere',
            'cursor.composer',
            'cursor.ai',
            'cursorai'
        ];

        const shouldFilter = (str) => {
            if (!str) return false;
            // Keep if it matches any of our keep patterns
            if (keepPatterns.some(pattern => str.toLowerCase().includes(pattern))) {
                return false;
            }
            // Filter if it matches any of our filter patterns
            return filterPatterns.some(pattern => str.includes(pattern));
        };

        // Special handling for anysphere and cursor events
        const isImportantEvent = (event) => {
            if (!event) return false;

            // Check file paths
            if (event.file && keepPatterns.some(pattern => event.file.toLowerCase().includes(pattern))) {
                return true;
            }

            // Check arrays of files
            if (event.files && event.files.some(f => keepPatterns.some(pattern => f.toLowerCase().includes(pattern)))) {
                return true;
            }

            // Check for tool calls
            if (event.toolCallXml && typeof event.toolCallXml === 'string' &&
                keepPatterns.some(pattern => event.toolCallXml.toLowerCase().includes(pattern))) {
                return true;
            }

            // Check for command names
            if (source.toLowerCase().includes('cursor') || source.toLowerCase().includes('anysphere')) {
                return true;
            }

            return false;
        };

        if (!isImportantEvent(event) && shouldFilter(event?.file)) {
            return;
        }

        const timestamp = new Date().toISOString();
        const eventStr = JSON.stringify(event, null, 2);
        // Truncate the event string if it's too long
        const truncatedEvent = eventStr.length > 200 ?
            eventStr.substring(0, 197) + '...' :
            eventStr;

        outputChannel.appendLine(`[${timestamp}] ${source}: ${truncatedEvent}`);
    }

    // Register event listeners
    const subscriptions = [
        // Window state monitoring
        vscode.window.onDidChangeWindowState(e => {
            logEvent('WindowStateChanged', {
                focused: e.focused
            });
        }),

        // View container monitoring
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            logEvent('VisibleEditorsChanged', {
                editors: editors.map(editor => ({
                    fileName: editor.document.fileName,
                    viewColumn: editor.viewColumn
                }))
            });
        }),

        // Custom view monitoring
        vscode.window.registerTreeDataProvider('cursor-composer', {
            getChildren: () => [],
            getTreeItem: () => null
        }),

        // Cursor-specific events
        vscode.commands.registerCommand('_extensionClient.toolCall', async (toolCallXml) => {
            logEvent('CursorToolCall', { toolCallXml });
            try {
                await interceptToolCall(toolCallXml);
                return await vscode.commands.executeCommand('_extensionClient._toolCall', toolCallXml);
            } catch (error) {
                console.error('[Event Monitor] Error handling tool call:', error);
                throw error;
            }
        }),

        // Listen for the internal tool call as well
        vscode.commands.registerCommand('_extensionClient._toolCall', (toolCallXml) => {
            logEvent('CursorInternalToolCall', { toolCallXml });
            return null; // Don't interfere with the actual execution
        }),

        // Monitor composer-related commands
        vscode.commands.registerCommand('cursor.composer.start', (...args) => {
            logEvent('ComposerStart', { args });
            return vscode.commands.executeCommand('cursor.composer._start', ...args);
        }),

        vscode.commands.registerCommand('cursor.composer.stop', (...args) => {
            logEvent('ComposerStop', { args });
            return vscode.commands.executeCommand('cursor.composer._stop', ...args);
        }),

        // Monitor workspace state changes
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('cursor') ||
                event.affectsConfiguration('composer')) {
                logEvent('CursorConfigChanged', {
                    affected: event.affectsConfiguration('cursor') ? 'cursor' : 'composer'
                });
            }
        }),

        // Editor events
        vscode.window.onDidChangeActiveTextEditor(editor => {
            logEvent('ActiveEditorChanged', {
                file: editor?.document.uri.toString(),
                languageId: editor?.document.languageId
            });
        }),

        // Monitor text document changes with special handling for anysphere
        vscode.workspace.onDidChangeTextDocument(event => {
            const uri = event.document.uri.toString();
            if (uri.includes('anysphere') || uri.includes('cursor')) {
                logEvent('TextChanged', {
                    file: uri,
                    changes: event.contentChanges.map(change => ({
                        range: {
                            start: change.range.start,
                            end: change.range.end
                        },
                        text: change.text
                    }))
                });
            }
        }),

        // File system events
        vscode.workspace.onDidCreateFiles(event => {
            logEvent('FilesCreated', {
                files: event.files.map(uri => uri.toString())
            });
        }),

        vscode.workspace.onDidDeleteFiles(event => {
            logEvent('FilesDeleted', {
                files: event.files.map(uri => uri.toString())
            });
        }),

        vscode.workspace.onDidSaveTextDocument(document => {
            logEvent('DocumentSaved', {
                file: document.uri.toString()
            });
        }),

        // Terminal events
        vscode.window.onDidOpenTerminal(terminal => {
            logEvent('TerminalOpened', {
                name: terminal.name
            });
        }),

        vscode.window.onDidCloseTerminal(terminal => {
            logEvent('TerminalClosed', {
                name: terminal.name
            });
        }),

        // Monitor webview panel creation (might catch composer UI)
        vscode.window.onDidCreateWebviewPanel(panel => {
            logEvent('WebviewCreated', {
                viewType: panel.viewType,
                title: panel.title,
                active: panel.active,
                visible: panel.visible,
                options: panel.options
            });

            // Monitor webview messages
            panel.webview.onDidReceiveMessage(message => {
                logEvent('WebviewMessage', {
                    viewType: panel.viewType,
                    message
                });
            });

            // Monitor visibility changes
            panel.onDidChangeViewState(e => {
                logEvent('WebviewStateChanged', {
                    viewType: panel.viewType,
                    title: panel.title,
                    active: e.webviewPanel.active,
                    visible: e.webviewPanel.visible
                });
            });
        })
    ];

    // Monitor global state changes
    const globalState = context.globalState;
    const originalUpdate = globalState.update;
    globalState.update = function(key, value) {
        if (key.startsWith('cursor.') || key.startsWith('composer.')) {
            logEvent('GlobalStateChanged', { key, value });
        }
        return originalUpdate.call(this, key, value);
    };

    context.subscriptions.push(...subscriptions);
    console.log('[Event Monitor] Extension activation complete - Event monitoring enabled');
}

function deactivate() {
    console.log('[Event Monitor] Extension deactivated');
}

module.exports = {
    activate,
    deactivate
};
