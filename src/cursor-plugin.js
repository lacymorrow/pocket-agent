const vscode = require('vscode');
const io = require('socket.io-client');
const WebSocket = require('ws'); // Added for WebSocket communication

// This should ideally come from a configuration or environment variable
// Ensure this URL matches where your src/server/index.js is running
const SERVER_URL = process.env.POCKET_AGENT_SERVER_URL || 'http://localhost:3300';
const CURSOR_DEBUG_PORT = process.env.CURSOR_DEBUG_PORT || 9223; // Make debug port configurable

let socket; // For connection to backend server
let chatPollInterval;
let cdpMessageId = 1; // Counter for CDP message IDs
let pocketAgentOutputChannel; // Declare output channel variable

/**
 * Fetches the WebSocket debugger URL for the main Cursor workbench.
 * Mimics the logic from the Python script.
 * @returns {Promise<string|null>} WebSocket debugger URL or null if not found/error.
 */
async function getWebSocketDebuggerUrlJs() {
    const targetUrl = `http://localhost:${CURSOR_DEBUG_PORT}/json/list`;
    console.log(`Pocket Agent: Attempting to connect to Cursor debug targets at: ${targetUrl}`);

    try {
        const { default: fetch } = await import('node-fetch'); // DYNAMIC IMPORT ADDED HERE
        const response = await fetch(targetUrl);
        if (!response.ok) {
            console.error(`Pocket Agent: Cursor debug port (${CURSOR_DEBUG_PORT}) not accessible. Status: ${response.status} ${response.statusText}. Ensure Cursor is started with --remote-debugging-port=${CURSOR_DEBUG_PORT}.`);
            vscode.window.showErrorMessage(`Pocket Agent: Cursor debug port (${CURSOR_DEBUG_PORT}) not accessible. Check console.`);
            return null;
        }
        const targets = await response.json();
        if (!targets || targets.length === 0) {
            console.error('Pocket Agent: No Cursor windows found on debug port.');
            vscode.window.showErrorMessage('Pocket Agent: No Cursor windows found on debug port.');
            return null;
        }

        const pageTargets = targets.filter(t => t.type === 'page');
        if (pageTargets.length === 0) {
            console.error(`Pocket Agent: No 'page' type targets found on port ${CURSOR_DEBUG_PORT}. Available targets: ${JSON.stringify(targets)}`);
            vscode.window.showErrorMessage('Pocket Agent: No suitable Cursor debug targets found.');
            return null;
        }

        const workbenchPages = pageTargets.filter(p => p.url && p.url.includes('workbench.html'));
        let selectedTarget = null;

        if (workbenchPages.length > 0) {
            selectedTarget = workbenchPages[0]; // Prefer the first workbench page
            if (workbenchPages.length > 1) {
                console.warn(`Pocket Agent: Multiple workbench.html pages found. Using the first one: Title='${selectedTarget.title || selectedTarget.url}'. Please close other Cursor editor windows if this is not the desired one.`);
            } else {
                console.log(`Pocket Agent: Using primary workbench page: Title='${selectedTarget.title || selectedTarget.url}'`);
            }
        } else {
            // Fallback logic if no workbench.html is found (similar to Python script)
            const preferredOthers = pageTargets.filter(p =>
                !['assistant-ui', 'extension-host', 'developer tools'].some(kw => (p.title || '').toLowerCase().includes(kw)) &&
                !(p.url || '').startsWith('devtools://')
            );
            if (preferredOthers.length > 0) {
                selectedTarget = preferredOthers[0];
                console.warn(`Pocket Agent: No workbench.html page found. Using the first suitable other page: Title='${selectedTarget.title || selectedTarget.url}'`);
            } else if (pageTargets.length > 0) {
                selectedTarget = pageTargets[0];
                console.warn(`Pocket Agent: No workbench.html page found and no other preferred page types. Using the first available page: Title='${selectedTarget.title || selectedTarget.url}'. This may not be the main editor window.`);
            }
        }

        if (!selectedTarget || !selectedTarget.webSocketDebuggerUrl) {
            console.error(`Pocket Agent: Could not select a suitable 'page' target with a webSocketDebuggerUrl. Available pages: ${JSON.stringify(pageTargets)}`);
            vscode.window.showErrorMessage('Pocket Agent: Could not determine Cursor debug WebSocket URL.');
            return null;
        }

        console.log(`Pocket Agent: Selected Cursor debug target: ${selectedTarget.title}, URL: ${selectedTarget.webSocketDebuggerUrl}`);
        return selectedTarget.webSocketDebuggerUrl;

    } catch (error) {
        console.error('Pocket Agent: Error fetching Cursor debug targets:', error);
        vscode.window.showErrorMessage(`Pocket Agent: Error connecting to Cursor debug port: ${error.message}`);
        return null;
    }
}

/**
 * Sends a command over CDP and waits for its specific response.
 * @param {WebSocket} ws The WebSocket connection.
 * @param {string} method The CDP method to call.
 * @param {object} params Parameters for the CDP method.
 * @param {number} timeoutMs Timeout for waiting for the response.
 * @returns {Promise<object>} The result part of the CDP response.
 * @throws {Error} If there's a CDP error or timeout.
 */
function sendCdpCommandJs(ws, method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const id = cdpMessageId++;
        const payload = JSON.stringify({ id, method, params });

        let timeoutHandle;

        const messageListener = (message) => {
            try {
                const parsedMessage = JSON.parse(message.toString());
                if (parsedMessage.id === id) {
                    clearTimeout(timeoutHandle);
                    ws.removeListener('message', messageListener);
                    ws.removeListener('error', errorListener); // Clean up error listener too
                    ws.removeListener('close', closeListener); // Clean up close listener

                    if (parsedMessage.error) {
                        console.error(`Pocket Agent: CDP Error for method ${method} (ID: ${id}):`, parsedMessage.error);
                        reject(new Error(`CDP Error: ${parsedMessage.error.message} (Code: ${parsedMessage.error.code})`));
                    } else {
                        resolve(parsedMessage.result);
                    }
                }
                // Ignore other messages (events or responses to other commands)
            } catch (e) {
                console.error('Pocket Agent: Error parsing CDP message:', e, message.toString());
                // Don't reject here, might be an unrelated malformed message
            }
        };

        const errorListener = (error) => {
            clearTimeout(timeoutHandle);
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            console.error('Pocket Agent: CDP WebSocket error:', error);
            reject(new Error(`CDP WebSocket error: ${error.message}`));
        };

        const closeListener = (code, reason) => {
            clearTimeout(timeoutHandle);
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            console.warn('Pocket Agent: CDP WebSocket closed unexpectedly:', code, reason.toString());
            reject(new Error(`CDP WebSocket closed: ${code} ${reason.toString()}`));
        };

        ws.on('message', messageListener);
        ws.on('error', errorListener); // Catch connection errors
        ws.on('close', closeListener); // Catch unexpected closures

        console.log(`Pocket Agent: [CDP SEND ID ${id}] Method: ${method}, Params: ${JSON.stringify(params)}`);
        ws.send(payload);

        timeoutHandle = setTimeout(() => {
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            console.error(`Pocket Agent: Timeout waiting for CDP response for method ${method} (ID: ${id})`);
            reject(new Error(`Timeout waiting for CDP response for ${method}`));
        }, timeoutMs);
    });
}

/**
 * Evaluates JavaScript in the target page using CDP.
 * @param {WebSocket} ws The WebSocket connection.
 * @param {string} expression The JavaScript expression to evaluate.
 * @returns {Promise<any>} The result of the JavaScript evaluation.
 */
async function evaluateJavascriptInPageJs(ws, expression) {
    try {
        // Runtime.enable is often implicitly handled or not strictly needed for evaluate
        // but can be sent if issues arise.
        // await sendCdpCommandJs(ws, 'Runtime.enable');

        const result = await sendCdpCommandJs(ws, 'Runtime.evaluate', {
            expression: expression,
            returnByValue: true,
            awaitPromise: true, // Important if the expression returns a promise
        });

        if (result && result.exceptionDetails) {
            const errorDetails = result.exceptionDetails;
            const errorMessage = errorDetails.exception?.description || errorDetails.text || 'Unknown JavaScript execution error';
            console.error('Pocket Agent: JavaScript execution error in CDP:', errorMessage, errorDetails);
            throw new Error(`JavaScript execution error: ${errorMessage}`);
        }
        return result && result.result ? result.result.value : undefined;
    } catch (error) {
        console.error('Pocket Agent: Error during evaluateJavascriptInPageJs:', error);
        throw error; // Re-throw to be caught by the caller
    }
}

/**
 * Main logic to read chat text from Cursor using CDP.
 * This function will be registered as the 'pocketAgent.readChatText' command handler.
 * @returns {Promise<string|null>} The chat text or null on failure.
 */
async function readChatTextLogicJs() {
    console.log('Pocket Agent: Executing readChatTextLogicJs to fetch chat content from Cursor.');
    const debuggerUrl = await getWebSocketDebuggerUrlJs();
    if (!debuggerUrl) {
        console.error('Pocket Agent: Failed to get WebSocket debugger URL. Cannot read chat text.');
        return null;
    }

    let cdpWs;
    try {
        cdpWs = new WebSocket(debuggerUrl);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Pocket Agent: CDP WebSocket connection timeout")), 5000);
            cdpWs.on('open', () => {
                clearTimeout(timeout);
                console.log('Pocket Agent: Connected to Cursor CDP WebSocket.');
                resolve();
            });
            cdpWs.on('error', (err) => {
                clearTimeout(timeout);
                console.error('Pocket Agent: Error connecting to Cursor CDP WebSocket:', err);
                reject(err);
            });
             cdpWs.on('close', (code, reason) => {
                console.warn('Pocket Agent: CDP WebSocket closed during connection attempt or early phase.', code, reason.toString());
                // This might be redundant if 'error' also fires, but good for clarity
                // reject(new Error(`CDP WebSocket closed: ${code} ${reason.toString()}`));
            });
        });

        const chatSelector = "document.querySelector('div.pane-body div.conversations')";
        const expression = `(() => { const el = ${chatSelector}; return el ? el.innerText : null; })()`;

        console.log(`Pocket Agent: Evaluating JS in Cursor: ${expression}`);
        const chatText = await evaluateJavascriptInPageJs(cdpWs, expression);

        if (chatText === null) {
            console.warn(`Pocket Agent: Chat conversations container (${chatSelector}) not found or has no text.`);
        } else if (typeof chatText === 'string') {
            console.log('Pocket Agent: Successfully retrieved chat text from Cursor.');
            // console.log('--- Cursor Chat Text ---'); // Optional: Log full text
            // console.log(chatText);
            // console.log('--- End Cursor Chat Text ---');
        } else {
             console.warn('Pocket Agent: Retrieved non-string or unexpected data for chat text:', chatText);
        }

        return chatText;

    } catch (error) {
        console.error('Pocket Agent: Error in readChatTextLogicJs:', error.message);
        // Optionally show a VS Code error message to the user for critical failures
        // vscode.window.showErrorMessage(`Pocket Agent: Failed to read chat: ${error.message}`);
        return null; // Return null to indicate failure
    } finally {
        if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
            console.log('Pocket Agent: Closing Cursor CDP WebSocket.');
            cdpWs.close();
        } else if (cdpWs) {
            console.log('Pocket Agent: Cursor CDP WebSocket already closed or was not opened.');
        }
    }
}


// Existing function to parse chat (can be improved)
function parseChatTextToStructuredData(chatText) {
    const messages = [];
    if (!chatText || typeof chatText !== 'string') {
        // console.warn('Pocket Agent: parseChatTextToStructuredData received invalid input:', chatText); // Already logged if null comes from readChatTextLogicJs
        return messages;
    }

    const lines = chatText.split('\\n').filter(line => line.trim() !== '');
    const lineRegex = /^(?:\[[^\]]+\]\s*)?([^:]+?)(?:\s*\[[^\]]+\])?:\s*(.*)$/;

    for (const line of lines) {
        const match = line.match(lineRegex);
        if (match) {
            const sender = match[1].trim();
            const content = match[2].trim();
            messages.push({
                sender: sender,
                content: content,
                timestamp: Date.now()
            });
        } else {
            if (messages.length > 0) {
                messages[messages.length - 1].content += '\\n' + line.trim();
            } else {
                messages.push({
                    sender: "System", // Or "Unknown"
                    content: line.trim(),
                    timestamp: Date.now()
                });
            }
        }
    }
    return messages;
}

async function fetchAndSendChatUpdate() {
    if (socket && socket.connected) {
        try {
            // Now calls our JS CDP implementation via the command
            const chatText = await vscode.commands.executeCommand('pocketAgent.readChatText');

            if (chatText && typeof chatText === 'string') {
                const messages = parseChatTextToStructuredData(chatText);
                if (messages.length > 0) {
                    socket.emit('chatUpdate', messages);
                    console.log('Pocket Agent: Sent chat update to backend with', messages.length, 'messages.');
                } else {
                     console.log('Pocket Agent: Parsed chat text from Cursor resulted in no messages to send.');
                }
            } else if (chatText === null) {
                 console.log('Pocket Agent: No chat text retrieved from Cursor (likely chat pane not found or empty).');
            } else if (chatText !== undefined) { // check chatText is not undefined from an early exit
                console.warn('Pocket Agent: pocketAgent.readChatText returned non-string or unexpected data:', chatText);
            }
            // If chatText is undefined (e.g. command failed internally without throwing but returned nothing), it's handled by the catch or implies an issue in readChatTextLogicJs
        } catch (error) {
            console.error('Pocket Agent: Error in fetchAndSendChatUpdate (calling pocketAgent.readChatText or parsing):', error);
            if (error.message && error.message.includes("command 'pocketAgent.readChatText' not found")) {
                // This specific error should ideally not happen now as we are defining it
                vscode.window.showErrorMessage("Pocket Agent: Critical - 'pocketAgent.readChatText' command registration failed. Chat sync disabled.");
                if (chatPollInterval) clearInterval(chatPollInterval);
            } else {
                // vscode.window.showErrorMessage(`Pocket Agent: Error processing chat: ${error.message}`);
        }
        }
    } else {
        console.log('Pocket Agent: Backend socket not connected, skipping chat update.');
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    // Create the output channel
    pocketAgentOutputChannel = vscode.window.createOutputChannel("Pocket Agent");
    context.subscriptions.push(pocketAgentOutputChannel);

    // Function to log to both console and output channel
    const log = (message) => {
        console.log(message);
        if (pocketAgentOutputChannel) {
            pocketAgentOutputChannel.appendLine(message);
        }
    };

    const logError = (message, error) => {
        console.error(message, error);
        if (pocketAgentOutputChannel) {
            pocketAgentOutputChannel.appendLine(`ERROR: ${message}`);
            if (error && error.message) {
                pocketAgentOutputChannel.appendLine(`  Details: ${error.message}`);
            } else if (typeof error === 'string') {
                 pocketAgentOutputChannel.appendLine(`  Details: ${error}`);
            }
        }
    };

    // Replace console.log/error with custom log functions in activate
    log("Pocket Agent: Entering activate function...");
    log('Pocket Agent: Activating extension...');

    // Register the command to read chat text using CDP
    let readChatDisposable = vscode.commands.registerCommand('pocketAgent.readChatText', async () => {
        try {
            return await readChatTextLogicJs();
        } catch (e) {
            console.error("Pocket Agent: Unhandled error in 'pocketAgent.readChatText' command execution:", e);
            // vscode.window.showErrorMessage(`Pocket Agent: Failed to execute readChatText command: ${e.message}`);
            return null; // Ensure it returns something even on unhandled error
        }
    });
    context.subscriptions.push(readChatDisposable);


    // Connect to the backend server
    log("Pocket Agent: Attempting to connect to backend server...");
    socket = io(SERVER_URL, {
        reconnectionAttempts: 5,
        reconnectionDelay: 3000,
        transports: ['websocket'] // Explicitly use WebSocket
    });

    log("Pocket Agent: Backend socket object created, attaching listeners...");

    socket.on('connect', () => {
        log('Pocket Agent: Connected to WebSocket backend server at', SERVER_URL);
        vscode.window.showInformationMessage('Pocket Agent connected to its backend server.');
        if (chatPollInterval) clearInterval(chatPollInterval);
        // Poll more frequently for testing, adjust as needed for production
        chatPollInterval = setInterval(fetchAndSendChatUpdate, process.env.POCKET_AGENT_POLL_INTERVAL || 5000);
        fetchAndSendChatUpdate(); // Initial fetch
    });

    socket.on('disconnect', (reason) => {
        log('Pocket Agent: Disconnected from WebSocket backend server. Reason:', reason);
        if (reason === 'io server disconnect') {
             // The server initiated the disconnect
            socket.connect(); // Attempt to reconnect manually if appropriate
        }
        vscode.window.showWarningMessage('Pocket Agent lost connection to its backend server.');
        if (chatPollInterval) clearInterval(chatPollInterval);
    });

    socket.on('connect_error', (error) => {
        logError('Pocket Agent: Connection to WebSocket backend server failed:', error);
        // vscode.window.showErrorMessage(`Pocket Agent failed to connect to backend: ${error.message}`);
    });

    // Original command for Cursor's internal use (if any)
    let toolCallDisposable = vscode.commands.registerCommand('_extensionClient.toolCall', function (...args) {
        log('Pocket Agent: _extensionClient.toolCall invoked with args:', args);
        // vscode.window.showInformationMessage('Pocket Agent: _extensionClient.toolCall executed.');
        return "Tool call received by Pocket Agent (placeholder).";
    });
    context.subscriptions.push(toolCallDisposable);

    // Command to manually trigger chat fetch (for debugging)
    let manualFetchDisposable = vscode.commands.registerCommand('pocketAgent.manualChatFetch', fetchAndSendChatUpdate);
    context.subscriptions.push(manualFetchDisposable);

    log("Pocket Agent: Before pushing main disposable...");

    // Ensure resources are cleaned up when the extension is deactivated
    context.subscriptions.push(new vscode.Disposable(() => {
        if (chatPollInterval) {
            clearInterval(chatPollInterval);
        }
        if (socket) {
            socket.disconnect();
        }
        // The output channel is automatically disposed because it was added to context.subscriptions
        log('Pocket Agent: Disposed resources.');
    }));

    log("Pocket Agent: After pushing main disposable, before final logs.");

    log('Pocket Agent: Extension activation complete.');
    vscode.window.showInformationMessage('Pocket Agent Activated. Ensure Cursor is running with --remote-debugging-port=9223.');
}

function deactivate() {
    if (chatPollInterval) clearInterval(chatPollInterval);
    if (socket) socket.disconnect();
    log('Pocket Agent: Extension deactivated.');
}

module.exports = {
    activate,
    deactivate
};
