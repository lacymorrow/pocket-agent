const vscode = require('vscode');
const io = require('socket.io-client');
const WebSocket = require('ws'); // Added for WebSocket communication

// This should ideally come from a configuration or environment variable
// Ensure this URL matches where your src/server/index.js is running
const SERVER_URL = process.env.POCKET_AGENT_SERVER_URL || 'https://pocket-agent.vercel.app/';
const CURSOR_DEBUG_PORT = process.env.CURSOR_DEBUG_PORT || 9223; // Make debug port configurable
// const POCKET_AGENT_USER_ID = process.env.POCKET_AGENT_USER_ID || null; // User ID for authentication (old way)

let pocketAgentUserId; // Will be populated from settings or env var

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
    log(`Pocket Agent: Attempting to connect to Cursor debug targets at: ${targetUrl}`);

    try {
        const { default: fetch } = await import('node-fetch');
        const response = await fetch(targetUrl);
        if (!response.ok) {
            logError(`Pocket Agent: Cursor debug port (${CURSOR_DEBUG_PORT}) not accessible. Status: ${response.status} ${response.statusText}. Ensure Cursor is started with --remote-debugging-port=${CURSOR_DEBUG_PORT}.`);
            return []; // Return empty array on failure
        }
        const targets = await response.json();
        if (!targets || targets.length === 0) {
            logError('Pocket Agent: No Cursor windows found on debug port.');
            return []; // Return empty array
        }

        const pageTargets = targets.filter(t => t.type === 'page');
        if (pageTargets.length === 0) {
            logError(`Pocket Agent: No 'page' type targets found on port ${CURSOR_DEBUG_PORT}. Available targets: ${JSON.stringify(targets)}`);
            return []; // Return empty array
        }

        const workbenchPages = pageTargets.filter(p => p.url && p.url.includes('workbench.html'));
        let selectedTargets = [];

        if (workbenchPages.length > 0) {
            selectedTargets = workbenchPages;
            log(`Pocket Agent: Found ${workbenchPages.length} workbench.html page(s).`);
            workbenchPages.forEach((p, index) => {
                log(`  Page ${index + 1}: Title='${p.title || p.url}', URL='${p.webSocketDebuggerUrl}'`);
            });
        } else {
            log(`Pocket Agent: No workbench.html page found. Looking for other suitable pages.`);
            const preferredOthers = pageTargets.filter(p =>
                !['assistant-ui', 'extension-host', 'developer tools'].some(kw => (p.title || '').toLowerCase().includes(kw)) &&
                !(p.url || '').startsWith('devtools://')
            );
            if (preferredOthers.length > 0) {
                selectedTargets = [preferredOthers[0]]; // Take the first suitable one as a fallback array
                log(`Pocket Agent: No workbench.html page found. Using the first suitable other page as a fallback: Title='${selectedTargets[0].title || selectedTargets[0].url}'`);
            } else if (pageTargets.length > 0) {
                selectedTargets = [pageTargets[0]]; // Fallback to the very first page target if no other criteria met
                log(`Pocket Agent: No workbench.html page and no other preferred page types. Using the first available page as a fallback: Title='${selectedTargets[0].title || selectedTargets[0].url}'. This may not be the main editor window.`);
            }
        }

        if (selectedTargets.length === 0) {
            logError(`Pocket Agent: Could not select any suitable 'page' target with a webSocketDebuggerUrl. Available pages: ${JSON.stringify(pageTargets)}`);
            return [];
        }

        const debuggerUrls = selectedTargets.map(t => t.webSocketDebuggerUrl).filter(url => !!url);
        if (debuggerUrls.length === 0) {
            logError(`Pocket Agent: Selected targets have no webSocketDebuggerUrl. Targets: ${JSON.stringify(selectedTargets)}`);
            return [];
        }

        const result = selectedTargets.map(t => ({
            url: t.webSocketDebuggerUrl,
            title: t.title || t.url || 'Untitled Page' // Capture title
        })).filter(t => !!t.url);

        log(`Pocket Agent: Returning ${result.length} debugger targets with URLs and titles.`);
        result.forEach(r => log(`  - URL: ${r.url}, Title: ${r.title}`));
        return result;

    } catch (error) {
        logError('Pocket Agent: Error fetching Cursor debug targets:', error);
        return []; // Return empty array on error
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
                        logError(`Pocket Agent: CDP Error for method ${method} (ID: ${id}):`, parsedMessage.error);
                        reject(new Error(`CDP Error: ${parsedMessage.error.message} (Code: ${parsedMessage.error.code})`));
                    } else {
                        resolve(parsedMessage.result);
                    }
                }
                // Ignore other messages (events or responses to other commands)
            } catch (e) {
                logError('Pocket Agent: Error parsing CDP message:', e, message.toString());
                // Don't reject here, might be an unrelated malformed message
            }
        };

        const errorListener = (error) => {
            clearTimeout(timeoutHandle);
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            logError('Pocket Agent: CDP WebSocket error:', error);
            reject(new Error(`CDP WebSocket error: ${error.message}`));
        };

        const closeListener = (code, reason) => {
            clearTimeout(timeoutHandle);
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            log('Pocket Agent: CDP WebSocket closed unexpectedly:', code, reason.toString());
            reject(new Error(`CDP WebSocket closed: ${code} ${reason.toString()}`));
        };

        ws.on('message', messageListener);
        ws.on('error', errorListener); // Catch connection errors
        ws.on('close', closeListener); // Catch unexpected closures

        log(`Pocket Agent: [CDP SEND ID ${id}] Method: ${method}, Params: ${JSON.stringify(params)}`);
        ws.send(payload);

        timeoutHandle = setTimeout(() => {
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            logError(`Pocket Agent: Timeout waiting for CDP response for method ${method} (ID: ${id})`);
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
            logError('Pocket Agent: JavaScript execution error in CDP:', errorMessage, errorDetails);
            throw new Error(`JavaScript execution error: ${errorMessage}`);
        }
        return result && result.result ? result.result.value : undefined;
    } catch (error) {
        logError('Pocket Agent: Error during evaluateJavascriptInPageJs:', error);
        throw error; // Re-throw to be caught by the caller
    }
}

/**
 * Helper function to fetch chat HTML from a single debugger URL.
 * @param {string} debuggerUrl The WebSocket debugger URL for a specific page.
 * @returns {Promise<string|null>} The chat HTML or null on failure.
 */
async function fetchChatHtmlFromDebuggerUrl(debuggerUrl) {
    if (!debuggerUrl) {
        logError('Pocket Agent: fetchChatHtmlFromDebuggerUrl called with no debuggerUrl.');
        return null;
    }
    log(`Pocket Agent: Attempting to fetch chat from: ${debuggerUrl}`);
    let cdpWs;
    try {
        cdpWs = new WebSocket(debuggerUrl);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                logError(`Pocket Agent: CDP WebSocket connection timeout for ${debuggerUrl}`);
                reject(new Error(`Pocket Agent: CDP WebSocket connection timeout for ${debuggerUrl}`));
            }, 5000);
            cdpWs.on('open', () => {
                clearTimeout(timeout);
                log(`Pocket Agent: Connected to Cursor CDP WebSocket for ${debuggerUrl}`);
                resolve();
            });
            cdpWs.on('error', (err) => {
                clearTimeout(timeout);
                logError(`Pocket Agent: Error connecting to Cursor CDP WebSocket for ${debuggerUrl}:`, err);
                reject(err);
            });
            cdpWs.on('close', (code, reason) => {
                log(`Pocket Agent: CDP WebSocket closed for ${debuggerUrl}. Code: ${code}, Reason: ${reason.toString()}`);
            });
        });

        const chatContainerSelector = "document.querySelector('div.pane-body div.conversations')";
        const expression = `(() => { const el = ${chatContainerSelector}; return el ? el.outerHTML : null; })()`;
        log(`Pocket Agent: Evaluating JS in target page (${debuggerUrl}): ${expression}`);
        const chatHtmlContent = await evaluateJavascriptInPageJs(cdpWs, expression);

        if (chatHtmlContent === null) {
            log(`Pocket Agent: Chat conversations container not found in page ${debuggerUrl}. Selector: ${chatContainerSelector}`);
        } else if (typeof chatHtmlContent === 'string') {
            log(`Pocket Agent: Successfully retrieved chat HTML from page ${debuggerUrl}. Length: ${chatHtmlContent.length}`);
        } else {
            log(`Pocket Agent: Retrieved non-string or unexpected data for chat HTML from ${debuggerUrl}:`, chatHtmlContent);
        }
        return chatHtmlContent;
    } catch (error) {
        logError(`Pocket Agent: Error in fetchChatHtmlFromDebuggerUrl for ${debuggerUrl}:`, error.message);
        return null;
    } finally {
        if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
            log(`Pocket Agent: Closing Cursor CDP WebSocket for ${debuggerUrl}.`);
            cdpWs.close();
        } else if (cdpWs) {
            log(`Pocket Agent: Cursor CDP WebSocket for ${debuggerUrl} already closed or was not opened.`);
        }
    }
}

/**
 * Main logic to read chat text from all relevant Cursor windows using CDP.
 * @returns {Promise<Array<string|null>>} An array of chat HTML strings or nulls.
 */
async function readChatTextLogicJs() {
    log('Pocket Agent: Executing readChatTextLogicJs to fetch chat content from all relevant Cursor windows.');
    const debuggerTargets = await getWebSocketDebuggerUrlJs(); // Now returns [{ url, title }]

    if (!debuggerTargets || debuggerTargets.length === 0) {
        log('Pocket Agent: No debugger targets found to fetch chat content from.');
        return []; // Return an empty array if no targets
    }

    log(`Pocket Agent: Found ${debuggerTargets.length} debugger targets to process.`);
    const allConversationsData = [];

    for (const target of debuggerTargets) {
        try {
            const chatHtml = await fetchChatHtmlFromDebuggerUrl(target.url);
            // Only add if HTML is successfully fetched
            if (chatHtml !== null && typeof chatHtml === 'string') {
                let conversationName = target.title || 'Untitled Chat';
                if (target.title && target.title.includes(' — ')) {
                    conversationName = target.title.split(' — ').pop().trim();
                }
                // If after splitting, the name is empty or just whitespace, fallback
                if (!conversationName || conversationName.trim() === '') {
                    conversationName = target.title || 'Untitled Chat'; // Fallback to full title if split fails
                }

                allConversationsData.push({
                    html: chatHtml,
                    name: conversationName,
                    id: target.url
                });
            } else {
                 // Optionally log if a specific target yielded no HTML but was processed
                log(`Pocket Agent: No chat HTML retrieved or invalid format from target: ${target.title} (${target.url})`);
            }
        } catch (error) {
            logError(`Pocket Agent: Error processing debugger target ${target.url} (Title: ${target.title}) in readChatTextLogicJs:`, error);
            // Do not push nulls here; instead, we filter for valid objects later or handle missing HTML upfront.
        }
    }

    log(`Pocket Agent: Finished processing all debugger targets. Returning ${allConversationsData.length} valid conversation data entries.`);
    return allConversationsData; // Returns array of { html, name, id }
}

/**
 * Sends a message to a specific Cursor window using CDP.
 * @param {string} windowId The WebSocket debugger URL of the target window.
 * @param {string} messageText The text to send.
 */
async function sendMessageToCursorWindow(windowId, messageText) {
    if (!windowId || typeof windowId !== 'string') {
        logError('Pocket Agent: sendMessageToCursorWindow called with invalid windowId.', windowId);
        return;
    }
    if (typeof messageText !== 'string') {
        logError('Pocket Agent: sendMessageToCursorWindow called with invalid messageText.', messageText);
        return;
    }

    log(`Pocket Agent: Attempting to send message to window: ${windowId}`);
    let cdpWs;
    try {
        cdpWs = new WebSocket(windowId);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                logError(`Pocket Agent: CDP WebSocket connection timeout for ${windowId} (sendMessageToCursorWindow)`);
                reject(new Error(`CDP WebSocket connection timeout for ${windowId}`));
            }, 5000); // 5s timeout for connection
            cdpWs.on('open', () => {
                clearTimeout(timeout);
                log(`Pocket Agent: Connected to Cursor CDP WebSocket for ${windowId} (sendMessageToCursorWindow)`);
                resolve();
            });
            cdpWs.on('error', (err) => {
                clearTimeout(timeout);
                logError(`Pocket Agent: Error connecting to Cursor CDP WebSocket for ${windowId} (sendMessageToCursorWindow):`, err);
                reject(err);
            });
            cdpWs.on('close', (code, reason) => {
                log(`Pocket Agent: CDP WebSocket closed for ${windowId} (sendMessageToCursorWindow). Code: ${code}, Reason: ${reason.toString()}`);
                // Potentially reject if closed before operations complete, but usually handled by command timeouts
            });
        });

        // Expression to find a suitable chat input textarea
        const getChatInputObjectIdExpression = `
            (() => {
                const selectors = [
                    'div.chat-input-widget textarea', // Common chat input
                    '.aiprompt-editor textarea', // Cursor's main AI prompt input
                    'div.pane-body.composite.panel div.chat-input-part textarea', // Chat input in a panel view
                    'textarea[placeholder*="Send a message"]', // Generic fallback
                    'textarea[aria-label*="Chat message input"]', // Accessibility
                    'textarea[data-testid*="chat-input"]' // Test ID common in some frameworks
                ];
                for (const selector of selectors) {
                    const el = document.querySelector(selector);
                    // Check if element exists and is visible (offsetParent is not null)
                    if (el && el.offsetParent !== null) {
                        return el; // CDP will convert this to a RemoteObject
                    }
                }
                return null; // No suitable input found
            })()
        `;

        const evalResult = await sendCdpCommandJs(cdpWs, 'Runtime.evaluate', {
            expression: getChatInputObjectIdExpression,
            returnByValue: false, // We need the objectId
            awaitPromise: true,
            objectGroup: 'chatInputGroup' // For releasing later
        });

        if (!evalResult || !evalResult.result || evalResult.result.type === 'undefined' || !evalResult.result.objectId) {
            logError(`Pocket Agent: Could not find chat input in window ${windowId}. Result:`, evalResult.result);
            throw new Error('Chat input element not found in target window.');
        }
        const inputObjectId = evalResult.result.objectId;
        log(`Pocket Agent: Found chat input ObjectId: ${inputObjectId} in ${windowId}`);

        // Focus the input field
        try {
            await sendCdpCommandJs(cdpWs, 'Runtime.callFunctionOn', {
                functionDeclaration: 'function() { this.focus(); }',
                objectId: inputObjectId
            }, 2000); // Shorter timeout for focus
            log(`Pocket Agent: Focused chat input in ${windowId}`);
        } catch (focusError) {
             // DOM.focus needs a nodeId or backendNodeId, which is harder to get reliably from Runtime.evaluate
            // Runtime.callFunctionOn with this.focus() is more direct with an objectId
            logError(`Pocket Agent: Could not focus chat input using Runtime.callFunctionOn in ${windowId}:`, focusError);
            // As a fallback, attempt to enable DOM and use DOM.focus if Runtime.callFunctionOn fails.
            // This is more complex as it requires resolving objectId to nodeId.
            // For now, we'll rely on Runtime.callFunctionOn.
            throw new Error('Failed to focus chat input.');
        }


        // Insert the text
        // Input.insertText is simpler and often works without explicit focus if the context is right,
        // but focusing first is more robust.
        await sendCdpCommandJs(cdpWs, 'Input.insertText', { text: messageText }, 5000);
        log(`Pocket Agent: Inserted text into chat input in ${windowId}: "${messageText}"`);

        // Simulate "Enter" key press to send the message
        // For "Enter", we usually need keyDown, char, and keyUp
        await sendCdpCommandJs(cdpWs, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            text: '\r' // Some systems might need text for keyDown Enter
        }, 1000);
        // Some applications might react to 'char' or just keyDown/keyUp.
        // Sending 'char' is often important for text processing.
        await sendCdpCommandJs(cdpWs, 'Input.dispatchKeyEvent', {
            type: 'char',
            text: '\r' // Or '\n', depending on the application
        }, 1000);
        await sendCdpCommandJs(cdpWs, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
        }, 1000);
        log(`Pocket Agent: Simulated Enter key press in ${windowId}`);

        // Release the object group
        await sendCdpCommandJs(cdpWs, 'Runtime.releaseObjectGroup', { objectGroup: 'chatInputGroup' }, 1000);

    } catch (error) {
        logError(`Pocket Agent: Error sending message to window ${windowId}:`, error);
        // Optionally, notify the user via vscode.window.showErrorMessage
        // vscode.window.showErrorMessage(`Pocket Agent: Failed to send message to Cursor window: ${error.message}`);
    } finally {
        if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
            log(`Pocket Agent: Closing Cursor CDP WebSocket for ${windowId} (sendMessageToCursorWindow).`);
            cdpWs.close();
        } else if (cdpWs) {
            log(`Pocket Agent: Cursor CDP WebSocket for ${windowId} was already closed or not opened (sendMessageToCursorWindow).`);
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

    const lines = chatText.split('\n').filter(line => line.trim() !== '');
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
                messages[messages.length - 1].content += '\n' + line.trim();
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
    try {
        // First, check if logging is even possible here.
        if (typeof log !== 'function') {
            console.error('Pocket Agent Critical: log function is not available in fetchAndSendChatUpdate!');
            return; // Cannot proceed if logging isn't working
        }
        if (!pocketAgentOutputChannel) {
            console.error('Pocket Agent Critical: pocketAgentOutputChannel is not available in fetchAndSendChatUpdate!');
            // We might still be able to console.log, but output channel logging will fail.
        }
        log('Pocket Agent: Entered fetchAndSendChatUpdate.');
    } catch (e) {
        console.error('Pocket Agent: Error during initial log in fetchAndSendChatUpdate:', e);
        return;
    }

    try {
        log('Fetching chat content from all relevant windows...');
        const allConversationsData = await readChatTextLogicJs(); // Returns an array of {html, name} or empty

        // Filter out any entries where html might be null or not a string, though readChatTextLogicJs tries to prevent this.
        const validConversationsData = allConversationsData.filter(
            conv => conv && typeof conv.html === 'string' && typeof conv.name === 'string'
        );

        if (validConversationsData.length > 0) {
            log(`Found ${validConversationsData.length} valid conversation(s) to send to server...`);

            const payload = {
                conversations: validConversationsData, // Array of {html, name} objects
                source: 'vscode-extension',
                timestamp: new Date().toISOString(),
                userId: pocketAgentUserId // Include the User ID in the payload
            };

            if (!pocketAgentUserId) {
                logError('Pocket Agent: User ID is not configured. Cannot send user-specific chat update. Please set it in VS Code settings (pocketAgent.userId) or via POCKET_AGENT_USER_ID environment variable.');
                // vscode.window.showWarningMessage('Pocket Agent: User ID is not configured. Please set POCKET_AGENT_USER_ID.');
                log('Pocket Agent: Warning message shown - User ID is not configured. Please set it in settings or env var.');
                return; // Stop if no User ID is set, as the server would likely reject or misattribute it
            }

            log(`Pocket Agent: Sending payload to /chat-update. ${validConversationsData.length} conversation(s). User ID: ${pocketAgentUserId}. First conversation name: ${validConversationsData[0].name}`);

            const response = await fetch(`${SERVER_URL}/chat-update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                log(`Successfully sent ${validConversationsData.length} conversation(s) to server.`);
            } else {
                const errorBody = await response.text();
                logError('Failed to send chat update. Status:', errorBody);
                // vscode.window.showWarningMessage(`Pocket Agent: Failed to send chat update to server. Status: ${response.status}`);
            }
        } else {
            log('No valid chat content found across all windows to send.');
        }
    } catch (error) {
        logError('Error fetching or sending chat update:', error);
        // vscode.window.showErrorMessage(`Pocket Agent: Error during chat update: ${error.message}`);
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
    // Ensure this definition is available to other functions if they are not closures within activate.
    // Making log and logError global to the module for simplicity, or pass them around.
    // For now, since fetchAndSendChatUpdate is at the same module level, this should be fine
    // as long as activate() runs first and defines pocketAgentOutputChannel.

    global.log = (message, ...optionalParams) => {
        const fullMessage = optionalParams.length > 0 ? message + ' ' + optionalParams.join(' ') : message;
        console.log(fullMessage);
        if (pocketAgentOutputChannel) {
            pocketAgentOutputChannel.appendLine(fullMessage);
        } else {
            // Fallback if channel not ready, though it should be.
            console.warn('Pocket Agent: pocketAgentOutputChannel not ready for log:', fullMessage);
        }
    };

    global.logError = (message, error) => {
        let fullMessage = `ERROR: ${message}`;
        if (error && error.message) {
            fullMessage += ` Details: ${error.message}`;
        } else if (typeof error === 'string') {
            fullMessage += ` Details: ${error}`;
        } else if (error) {
            try {
                fullMessage += ` Details: ${JSON.stringify(error)}`;
            } catch (e) {
                fullMessage += ` Details: (Unserializable error object)`;
            }
        }
        console.error(message, error); // Log original error object to console for better inspection
        if (pocketAgentOutputChannel) {
            pocketAgentOutputChannel.appendLine(fullMessage);
        } else {
            console.warn('Pocket Agent: pocketAgentOutputChannel not ready for logError:', fullMessage);
        }
    };

    log("Pocket Agent: Entering activate function..."); // Now uses global log
    log('Pocket Agent: Activating extension...');

    // Get User ID from settings, then environment variable as fallback
    const config = vscode.workspace.getConfiguration('pocketAgent');
    pocketAgentUserId = config.get('userId');

    if (!pocketAgentUserId) {
        pocketAgentUserId = process.env.POCKET_AGENT_USER_ID || null;
        if (pocketAgentUserId) {
            log('Pocket Agent: User ID loaded from POCKET_AGENT_USER_ID environment variable.');
        } else {
            log('Pocket Agent: User ID not found in VS Code settings or environment variable. Please configure pocketAgent.userId.');
        }
    } else {
        log('Pocket Agent: User ID loaded from VS Code settings (pocketAgent.userId).');
    }

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

    // Command to set User ID
    let setUserIdDisposable = vscode.commands.registerCommand('pocketAgent.setUserId', async () => {
        const newUserId = await vscode.window.showInputBox({
            prompt: "Enter your Pocket Agent User ID",
            placeHolder: "Your User ID (e.g., from the Pocket Agent web portal)",
            value: pocketAgentUserId || '' // Show current ID if available
        });

        if (newUserId === undefined) {
            log('Pocket Agent: Set User ID command cancelled by user.');
            return; // User cancelled the input box
        }

        if (typeof newUserId === 'string' && newUserId.trim() !== '') {
            try {
                await vscode.workspace.getConfiguration('pocketAgent').update('userId', newUserId.trim(), vscode.ConfigurationTarget.Global);
                pocketAgentUserId = newUserId.trim(); // Update the in-memory variable
                log(`Pocket Agent: User ID updated to: ${pocketAgentUserId}`);
                // vscode.window.showInformationMessage(`Pocket Agent User ID updated successfully to: ${pocketAgentUserId}`);
                log('Pocket Agent: Information message shown - User ID updated successfully.');
            } catch (error) {
                logError('Pocket Agent: Failed to save User ID to settings:', error);
                // vscode.window.showErrorMessage('Pocket Agent: Failed to save User ID. Check logs.');
                log('Pocket Agent: Error message shown - Failed to save User ID. Check logs.');
            }
        } else if (newUserId.trim() === '') {
            // User entered an empty string, potentially to clear it
             try {
                await vscode.workspace.getConfiguration('pocketAgent').update('userId', null, vscode.ConfigurationTarget.Global);
                pocketAgentUserId = null; // Update the in-memory variable
                log('Pocket Agent: User ID cleared from settings.');
                // vscode.window.showInformationMessage('Pocket Agent User ID cleared.');
                log('Pocket Agent: Information message shown - User ID cleared.');
            } catch (error) {
                logError('Pocket Agent: Failed to clear User ID from settings:', error);
                // vscode.window.showErrorMessage('Pocket Agent: Failed to clear User ID. Check logs.');
                log('Pocket Agent: Error message shown - Failed to clear User ID. Check logs.');
            }
        } else {
            log('Pocket Agent: Invalid User ID entered.');
            // vscode.window.showWarningMessage('Pocket Agent: Invalid User ID entered. It was not saved.');
            log('Pocket Agent: Warning message shown - Invalid User ID entered. It was not saved.');
        }
    });
    context.subscriptions.push(setUserIdDisposable);

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
        try {
            // vscode.window.showInformationMessage('Pocket Agent connected to its backend server. Polling for chat updates.');
            log('Pocket Agent: Information message shown.');

            if (chatPollInterval) {
                log('Pocket Agent: Clearing existing chatPollInterval.');
                clearInterval(chatPollInterval);
            }

            const pollIntervalEnv = process.env.POCKET_AGENT_POLL_INTERVAL;
            const pollIntervalMs = parseInt(pollIntervalEnv) || 5000;
            log(`Pocket Agent: Poll interval ENV is "${pollIntervalEnv}". Parsed interval: ${pollIntervalMs}ms.`);

            if (isNaN(pollIntervalMs) || pollIntervalMs <= 0) {
                logError(`Pocket Agent: Invalid poll interval ${pollIntervalMs}ms. Defaulting to 5000ms.`, null);
                // pollIntervalMs = 5000; // Already handled by || 5000 but good to be explicit if logic changes
            }

            log('Pocket Agent: Setting up setInterval for fetchAndSendChatUpdate.');
            chatPollInterval = setInterval(fetchAndSendChatUpdate, pollIntervalMs);
            log('Pocket Agent: setInterval for fetchAndSendChatUpdate has been set.');

            log('Pocket Agent: Attempting initial direct call to fetchAndSendChatUpdate...');
            fetchAndSendChatUpdate();
            log('Pocket Agent: Initial direct call to fetchAndSendChatUpdate has completed or is in progress (async).');

        } catch (e) {
            logError('Pocket Agent: Error within socket.on("connect") handler:', e);
            // vscode.window.showErrorMessage('Pocket Agent: Critical error during connection setup. Chat polling may not start.');
        }
    });

    socket.on('sendMessageToWindow', async (data) => {
        if (data && data.windowId && data.messageText) {
            log(`Pocket Agent: Received 'sendMessageToWindow' event. Window ID: ${data.windowId}, Message: "${data.messageText}"`);
            try {
                await sendMessageToCursorWindow(data.windowId, data.messageText);
                log(`Pocket Agent: Successfully processed 'sendMessageToWindow' for Window ID: ${data.windowId}`);
            } catch (error) {
                logError(`Pocket Agent: Error executing sendMessageToCursorWindow from socket event for Window ID: ${data.windowId}:`, error);
                // vscode.window.showErrorMessage(`Pocket Agent: Failed to send message to Cursor window via socket event: ${error.message}`);
            }
        } else {
            logError('Pocket Agent: Received invalid data for sendMessageToWindow event:', data);
        }
    });

    socket.on('disconnect', (reason) => {
        log('Pocket Agent: Disconnected from WebSocket backend server. Reason:', reason);
        if (reason === 'io server disconnect') {
             // The server initiated the disconnect
            socket.connect(); // Attempt to reconnect manually if appropriate
        }
        log('Pocket Agent: Warning message shown - lost connection to backend server.');
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
    // vscode.window.showInformationMessage('Pocket Agent Activated. Ensure Cursor is running with --remote-debugging-port=9223.');
    log('Pocket Agent: Information message shown - Pocket Agent Activated. Ensure Cursor is running with --remote-debugging-port=9223 and User ID is configured.');
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

