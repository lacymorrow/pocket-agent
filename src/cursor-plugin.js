const vscode = require('vscode');
const { interceptToolCall } = require('./cursor-integration');
const { initSocket } = require('./client/desktop');

function activate(context) {
    console.log('[Pocket Agent] Plugin activation starting...');

    // Initialize socket connection
    initSocket();

    // Hook into Cursor's tool call system
    const disposable = vscode.commands.registerCommand('_extensionClient.toolCall', async (toolCallXml) => {
        console.log('[Pocket Agent] Intercepted tool call:', toolCallXml);
        console.log('[Pocket Agent] Tool call XML:', toolCallXml);

        try {
            // Intercept and broadcast the tool call
            await interceptToolCall(toolCallXml);

            // Let the original tool call proceed
            return await vscode.commands.executeCommand('_extensionClient._toolCall', toolCallXml);
        } catch (error) {
            console.error('[Pocket Agent] Error handling tool call:', error);
            throw error;
        }
    });

    context.subscriptions.push(disposable);
    console.log('[Pocket Agent] Plugin activation complete - Tool call interception enabled');
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
