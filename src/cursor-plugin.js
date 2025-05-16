const vscode = require('vscode');
// const io = require('socket.io-client'); // Removed: Socket.IO client
const WebSocket = require('ws'); // Added for WebSocket communication

// This should ideally come from a configuration or environment variable
// Ensure this URL matches where your src/server/index.js is running
const SERVER_URL = process.env.POCKET_AGENT_SERVER_URL || 'http://localhost:3000'; // Updated: Prioritize localhost:3000 if no env var
const CURSOR_DEBUG_PORT = process.env.CURSOR_DEBUG_PORT || 9223; // Make debug port configurable
// const POCKET_AGENT_USER_ID = process.env.POCKET_AGENT_USER_ID || null; // User ID for authentication (old way)

let pocketAgentUserId; // Will be populated from settings or env var
let serviceApiToken; // To store the API token from your backend
let serviceUserId; // To store the User ID from your backend
let extensionContext; // <<<< To store the extension context

// let socket; // Removed: For connection to backend server
let chatPollInterval;
let cdpMessageId = 1; // Counter for CDP message IDs
let pocketAgentOutputChannel; // Declare output channel variable

// Define loggers at module scope
const log = (message, ...optionalParams) => {
    const fullMessage = optionalParams.length > 0 ? `${message} ${optionalParams.join(' ')}` : message;
    console.log(fullMessage);
    if (pocketAgentOutputChannel) {
        pocketAgentOutputChannel.appendLine(fullMessage);
    } else {
        // Fallback if channel not ready, or queue messages
        console.warn('Pocket Agent: pocketAgentOutputChannel not (yet) ready for log:', fullMessage);
    }
};

const logError = (message, error) => {
    let fullMessage = `ERROR: ${message}`;
    if (error?.message) {
        fullMessage += ` Details: ${error.message}`;
    } else if (typeof error === 'string') {
        fullMessage += ` Details: ${error}`;
    } else if (error) {
        try {
            fullMessage += ` Details: ${JSON.stringify(error)}`;
        } catch (e) {
            fullMessage += ' Details: (Unserializable error object)';
        }
    }
    console.error(message, error);
    if (pocketAgentOutputChannel) {
        pocketAgentOutputChannel.appendLine(fullMessage);
    } else {
        console.warn('Pocket Agent: pocketAgentOutputChannel not (yet) ready for logError:', fullMessage);
    }
};

const logWarn = (message, ...optionalParams) => {
    const fullMessage = `WARN: ${optionalParams.length > 0 ? `${message} ${optionalParams.join(' ')}` : message}`;
    console.warn(fullMessage);
    if (pocketAgentOutputChannel) {
        pocketAgentOutputChannel.appendLine(fullMessage);
    } else {
        console.warn('Pocket Agent: pocketAgentOutputChannel not (yet) ready for logWarn:', fullMessage);
    }
};

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

        const workbenchPages = pageTargets.filter(p => p.url?.includes('workbench.html'));
        let selectedTargets = [];

        if (workbenchPages.length > 0) {
            selectedTargets = workbenchPages;
            log(`Pocket Agent: Found ${workbenchPages.length} workbench.html page(s).`);
            workbenchPages.forEach((p, index) => {
                log(`  Page ${index + 1}: Title='${p.title || p.url}', URL='${p.webSocketDebuggerUrl}'`);
            });
        } else {
            log('Pocket Agent: No workbench.html page found. Looking for other suitable pages.');
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
        for (const r of result) {
            log(`  - URL: ${r.url}, Title: ${r.title}`);
        }
        return result;

    } catch (error) {
        logError('Pocket Agent: Error fetching Cursor debug targets:', error);
        // Ensure that `fetch` is available in this context if you're not using a polyfill or modern Node.js
        if (error.message.includes('fetch is not defined') || error.message.includes('Failed to fetch')) {
            logError('Pocket Agent: fetchAndSendChatUpdate - The "fetch" function is not available. Ensure you are in an environment that supports fetch (like Node.js 18+) or have a polyfill (like node-fetch) correctly imported and available.');
        }
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

        let timeoutHandle = null;

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

        if (result?.exceptionDetails) {
            const errorDetails = result.exceptionDetails;
            const errorMessage = errorDetails.exception?.description || errorDetails.text || 'Unknown JavaScript execution error';
            logError('Pocket Agent: JavaScript execution error in CDP:', errorMessage, errorDetails);
            throw new Error(`JavaScript execution error: ${errorMessage}`);
        }
        return result?.result?.value;
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
                if (target.title?.includes(' — ')) {
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
    log(`Pocket Agent: Attempting to send message to window: ${windowId} | Message: "${messageText.substring(0,50)}..."`);
    let cdpWs = null;

    try {
        cdpWs = new WebSocket(windowId); // windowId is the webSocketDebuggerUrl

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                logError(`Pocket Agent: CDP WebSocket connection timeout for ${windowId}`);
                reject(new Error(`CDP WebSocket connection timeout for ${windowId}`));
            }, 5000); // 5 second timeout for connection

            cdpWs.on('open', () => {
                clearTimeout(timeout);
                log(`Pocket Agent: Connected to Cursor CDP WebSocket for ${windowId} (sendMessageToCursorWindow)`);
                resolve();
            });
            cdpWs.on('error', (error) => {
                clearTimeout(timeout);
                logError(`Pocket Agent: Error connecting to Cursor CDP WebSocket for ${windowId} (sendMessageToCursorWindow):`, error);
                reject(error);
            });
            cdpWs.on('close', (code, reason) => {
                clearTimeout(timeout); // Ensure timeout is cleared on close too
                // This might be logged if connection fails or closes prematurely
                log(`Pocket Agent: CDP WebSocket closed for ${windowId} (sendMessageToCursorWindow). Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
                // Don't automatically reject on close if open was successful, as close is normal post-operation
            });
        });

        // Enable necessary CDP domains
        await sendCdpCommandJs(cdpWs, 'Page.enable');
        await sendCdpCommandJs(cdpWs, 'DOM.enable');
        await sendCdpCommandJs(cdpWs, 'Runtime.enable');

        const selectors = [
            '.aislash-editor-input', // From test script, likely the most reliable
            '.aiprompt-editor textarea',
            'div.chat-input-widget textarea',
            'div.pane-body.composite.panel div.chat-input-part textarea',
            'textarea[placeholder*="Send a message"]',
            'textarea[aria-label*="Chat message input"]',
            'textarea[data-testid*="chat-input"]'
        ];

        let inputNodeId = null;
        let foundSelector = null;
        const { root: documentNode } = await sendCdpCommandJs(cdpWs, 'DOM.getDocument', { depth: -1 });

        if (!documentNode?.nodeId) {
            throw new Error('Could not get document node from target page.');
        }

        for (const selector of selectors) {
            try {
                log(`Pocket Agent: Trying selector for chat input: "${selector}" in ${windowId}`);
                const queryResult = await sendCdpCommandJs(cdpWs, 'DOM.querySelector', {
                    nodeId: documentNode.nodeId,
                    selector: selector
                });

                if (queryResult?.nodeId !== 0) { // nodeId 0 means not found
                    // Check for visibility using getBoxModel
                    const boxModel = await sendCdpCommandJs(cdpWs, 'DOM.getBoxModel', { nodeId: queryResult.nodeId });
                    if (boxModel?.model?.width > 0 && boxModel?.model?.height > 0) {
                        inputNodeId = queryResult.nodeId;
                        foundSelector = selector;
                        log(`Pocket Agent: Found visible chat input with selector "${selector}", nodeId: ${inputNodeId} in ${windowId}`);
                        break; // Found a visible input
                    }
                    log(`Pocket Agent: Found chat input with selector "${selector}" but it might not be visible (width/height 0). NodeId: ${queryResult.nodeId}`);
                }
            } catch (e) {
                // Log and continue if a selector fails or element not found
                logWarn(`Pocket Agent: Selector "${selector}" failed or element not found for ${windowId}: ${e.message}`);
            }
        }

        if (!inputNodeId) {
            logError(`Pocket Agent: Could not find a visible chat input element in window ${windowId} using any of the selectors.`);
            throw new Error('Chat input element not found or not visible in target window.');
        }

        // Special handling for '.aislash-editor-input' (click if found)
        if (foundSelector === '.aislash-editor-input') {
            log(`Pocket Agent: Found selector is '${foundSelector}'. Attempting to click it first.`);
            try {
                const boxModelResult = await sendCdpCommandJs(cdpWs, 'DOM.getBoxModel', { nodeId: inputNodeId });
                if (boxModelResult?.model?.content?.length >= 6) { // Check if content quad is valid
                    const contentQuad = boxModelResult.model.content;
                    // Calculate center of the element for clicking
                    const centerX = Math.round((contentQuad[0] + contentQuad[2]) / 2);
                    const centerY = Math.round((contentQuad[1] + contentQuad[5]) / 2); // Correct Y for quad

                    log(`Pocket Agent: Calculated click coordinates for '${foundSelector}': x=${centerX}, y=${centerY}`);

                    await sendCdpCommandJs(cdpWs, 'Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: centerX, y: centerY, button: 'left', clickCount: 1
                    }, 2000); // Timeout for the command
                    await sendCdpCommandJs(cdpWs, 'Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x: centerX, y: centerY, button: 'left', clickCount: 1
                    }, 2000);

                    log(`Pocket Agent: Click dispatched to '${foundSelector}'. Waiting for UI to update.`);
                    await new Promise(resolve => setTimeout(resolve, 300)); // Wait for UI to potentially react
                } else {
                    logWarn(`Pocket Agent: Could not get a valid box model or content quad for '${foundSelector}' to click. Proceeding without click.`);
                }
            } catch (clickError) {
                logError(`Pocket Agent: Error during click attempt on '${foundSelector}':`, clickError);
                // Continue an_attempt to focus and type even if click fails
            }
        }

        log(`Pocket Agent: Focusing chat input with nodeId: ${inputNodeId} in ${windowId}`);
        await sendCdpCommandJs(cdpWs, 'DOM.focus', { nodeId: inputNodeId });
        log(`Pocket Agent: Focused chat input in ${windowId}.`);

        await sendCdpCommandJs(cdpWs, 'DOM.scrollIntoViewIfNeeded', { nodeId: inputNodeId });
        log(`Pocket Agent: Scrolled chat input into view if needed in ${windowId}.`);

        log(`Pocket Agent: Inserting text into chat input in ${windowId}: "${messageText.substring(0, 50)}..."`);
        await sendCdpCommandJs(cdpWs, 'Input.insertText', { text: messageText });
        log(`Pocket Agent: Text insertion command sent for "${messageText.substring(0, 50)}..." in ${windowId}.`);

        log(`Pocket Agent: Simulating Enter key press in ${windowId}`);
        // Using a sequence of events for Enter key, similar to test script for robustness
        const enterKeyEvents = [
            { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
            { type: 'char', text: '\r' }, // Important for some inputs
            { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        ];

        for (const event of enterKeyEvents) {
            await sendCdpCommandJs(cdpWs, 'Input.dispatchKeyEvent', event, 2000); // Timeout for each key event
        }
        log(`Pocket Agent: Finished simulating Enter key press in ${windowId}`);

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
                messages[messages.length - 1].content += `\n${line.trim()}`;
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
            // This might be too early in activation for the channel to be ready,
            // so console.error is a fallback.
            console.error('Pocket Agent Critical: pocketAgentOutputChannel is not available in fetchAndSendChatUpdate!');
        }
        log('Pocket Agent: Entered fetchAndSendChatUpdate.');
    } catch (e) {
        console.error('Pocket Agent: Error during initial log in fetchAndSendChatUpdate:', e);
        return;
    }

    try {
        log('Fetching chat content from all relevant windows...');
        const allConversationsData = await readChatTextLogicJs(); // Returns an array of {html, name, id} or empty

        const validConversationsData = allConversationsData.filter(
            conv => conv && typeof conv.html === 'string' && typeof conv.name === 'string' && typeof conv.id === 'string'
        );

        if (validConversationsData.length > 0) {
            log(`Found ${validConversationsData.length} valid conversation(s) to process...`);

            if (!extensionContext) {
                logError('Pocket Agent: Extension context not available in fetchAndSendChatUpdate. This should not happen.');
                vscode.window.showErrorMessage('Pocket Agent: Critical error - extension context not found. Please restart VS Code.');
                return;
            }

            const currentServiceApiToken = await extensionContext.secrets.get('pocketAgentServiceApiToken');
            const currentServiceUserId = await extensionContext.secrets.get('pocketAgentServiceUserId');

            if (!currentServiceApiToken || !currentServiceUserId) {
                logError('Pocket Agent: API token or User ID is not available. User needs to sign in.');
                const selection = await vscode.window.showInformationMessage(
                    'Pocket Agent requires you to sign in to send chat data.',
                    'Sign In'
                );
                if (selection === 'Sign In') {
                    vscode.commands.executeCommand('pocketAgent.signIn');
                }
                return;
            }

            const { default: fetch } = await import('node-fetch');

            for (const conversation of validConversationsData) {
                const payload = {
                    chatHTML: conversation.html,
                    chatName: conversation.name,
                    windowId: conversation.id, // Assuming 'id' from readChatTextLogicJs is the windowId
                    // userId: currentServiceUserId, // Server endpoint doesn't expect userId in body currently
                    // source: 'vscode-extension', // Server endpoint doesn't expect source
                    // timestamp: new Date().toISOString() // Server endpoint doesn't expect timestamp
                };

                log(`Pocket Agent: Sending update for conversation. Name: ${conversation.name}, WindowID: ${conversation.id}`);

                try {
                    const response = await fetch(`${SERVER_URL}/api/chat/update`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${currentServiceApiToken}`
                        },
                        body: JSON.stringify(payload)
                    });

                    if (response.ok) {
                        log(`Successfully sent update for conversation: ${conversation.name} (WindowID: ${conversation.id})`);
                    } else {
                        const errorBody = await response.text();
                        logError(`Failed to send chat update for conversation: ${conversation.name} (WindowID: ${conversation.id}). Status: ${response.status}`, errorBody);
                        if (response.status === 401 || response.status === 403) {
                            logError('Pocket Agent: Authentication error for a chat update. Token might be invalid or expired. Prompting to sign in again.');
                            // vscode.window.showErrorMessage('Pocket Agent: Authentication failed. Please sign in again.');
                            // Consider if one failed auth should trigger global sign-out/sign-in or just log for that attempt.
                            // For now, just log and continue with other conversations if any.
                            // await vscode.commands.executeCommand('pocketAgent.signOut');
                            // await vscode.commands.executeCommand('pocketAgent.signIn');
                            // Break or return here if one auth failure should stop all updates
                        } else {
                            // vscode.window.showWarningMessage(`Pocket Agent: Failed to send update for ${conversation.name}. Status: ${response.status}`);
                        }
                    }
                } catch (fetchError) {
                    logError(`Pocket Agent: Network error during fetch for conversation: ${conversation.name} (WindowID: ${conversation.id})`, fetchError);
                    if (fetchError.message.includes('fetch is not defined') || fetchError.message.includes('Failed to fetch')) {
                         logError('Pocket Agent: fetchAndSendChatUpdate - The "fetch" function is not available during individual conversation update. Make sure node-fetch is correctly imported.');
                        // vscode.window.showErrorMessage('Pocket Agent: Network error. Could not connect to the server for a chat update.');
                    } else {
                        // vscode.window.showErrorMessage(`Pocket Agent: Error during update for ${conversation.name}: ${fetchError.message}`);
                    }
                    // Decide if one network error should stop further attempts.
                    // For now, it will continue to the next conversation.
                }
            } // End of for loop

        } else {
            log('No valid chat content found across all windows to send.');
        }
    } catch (error) {
        logError('Error fetching or sending chat update (outer try-catch):', error);
        // Handle general errors not caught by the inner try-catch for fetch, like issues with readChatTextLogicJs itself.
        if (error.message.includes('fetch is not defined') || error.message.includes('Failed to fetch')) {
             logError('Pocket Agent: fetchAndSendChatUpdate - The "fetch" function is not available (outer scope). Make sure node-fetch is correctly imported if not using Node 18+.');
            // vscode.window.showErrorMessage('Pocket Agent: Network error. Could not connect to the server. Please check your internet connection and ensure the server is running.');
        } else {
            // vscode.window.showErrorMessage(`Pocket Agent: Error during chat update process: ${error.message}`);
        }
    }
}

const GITHUB_AUTH_PROVIDER_ID = 'github';
const SCOPES = ['read:user']; // Basic scope to read user profile

/**
 * Initiates the GitHub authentication flow.
 * @param {vscode.ExtensionContext} context
 */
async function signIn(context) {
    try {
        log('Pocket Agent: Initiating GitHub sign-in process...');
        if (!extensionContext) {
            logError('Pocket Agent: Extension context not available in signIn. This should not happen if activate was called.');
            // Attempt to use the passed context as a fallback, though ideally extensionContext should be set.
            if (!context) {
                vscode.window.showErrorMessage('Pocket Agent: Critical error - extension context not found for sign-in. Please restart VS Code.');
                return;
            }
            logWarn('Pocket Agent: Using passed context in signIn as extensionContext was not yet set globally.');
            // Assign it here if it wasn't set, though it's a bit late.
            // This primarily protects if signIn is somehow called before activate fully sets extensionContext.
            // extensionContext = context;
            // Better to rely on activate setting it. If called directly, ensure context is the global one.
        }

        const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, SCOPES, { createIfNone: true });

        if (session) {
            log(`Pocket Agent: Successfully obtained GitHub session. Access Token: ${session.accessToken.substring(0, 10)}... Account: ${session.account.label}`);

            log('Pocket Agent: Exchanging GitHub token for service API token...');
            const { default: fetch } = await import('node-fetch');
            const response = await fetch(`${SERVER_URL}/api/auth/vscode/github-exchange`, { // Ensure /api path is here
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.accessToken}`
                },
            });

            if (response.ok) {
                const serviceAuthData = await response.json();
                if (serviceAuthData.apiToken && serviceAuthData.userId) {
                    await extensionContext.secrets.store('pocketAgentServiceApiToken', serviceAuthData.apiToken);
                    await extensionContext.secrets.store('pocketAgentServiceUserId', serviceAuthData.userId);
                    serviceApiToken = serviceAuthData.apiToken;
                    serviceUserId = serviceAuthData.userId;

                    log('Pocket Agent: Successfully exchanged token and stored service API token and User ID.');
                    vscode.window.showInformationMessage(`Pocket Agent: Successfully signed in as ${session.account.label}.`);
                    fetchAndSendChatUpdate();
                } else {
                    logError('Pocket Agent: Service token exchange response missing apiToken or userId.', serviceAuthData);
                    vscode.window.showErrorMessage('Pocket Agent: Sign-in failed. Invalid response from server after token exchange.');
                }
            } else {
                const errorText = await response.text();
                logError(`Pocket Agent: Failed to exchange GitHub token with backend. Status: ${response.status}`, errorText);
                vscode.window.showErrorMessage(`Pocket Agent: Sign-in failed. Could not verify with Pocket Agent server. Status: ${response.status}`);
            }
        } else {
            log('Pocket Agent: GitHub authentication session not obtained.');
            vscode.window.showWarningMessage('Pocket Agent: GitHub sign-in was cancelled or failed.');
        }
    } catch (error) {
        logError('Pocket Agent: Error during sign-in process:', error);
        vscode.window.showErrorMessage(`Pocket Agent: Sign-in error: ${error.message}`);
    }
}

/**
 * Signs the user out by clearing stored tokens.
 * @param {vscode.ExtensionContext} context
 */
async function signOut(context) {
    try {
        log('Pocket Agent: Signing out...');
        if (!extensionContext) {
            logError('Pocket Agent: Extension context not available in signOut. This should not happen if activate was called.');
            if (!context) {
                 vscode.window.showErrorMessage('Pocket Agent: Critical error - extension context not found for sign-out. Please restart VS Code.');
                return;
            }
            logWarn('Pocket Agent: Using passed context in signOut as extensionContext was not yet set globally.');
            // Assign it here if it wasn't set.
            // extensionContext = context;
        }
        await extensionContext.secrets.delete('pocketAgentServiceApiToken');
        await extensionContext.secrets.delete('pocketAgentServiceUserId');
        serviceApiToken = null;
        serviceUserId = null;
        log('Pocket Agent: Cleared service API token and User ID.');
        vscode.window.showInformationMessage('Pocket Agent: Successfully signed out.');
    } catch (error) {
        logError('Pocket Agent: Error during sign out:', error);
        vscode.window.showErrorMessage('Pocket Agent: Error during sign out. Please check logs.');
    }
}

/**
 * Fetches commands from the backend that were sent from the web UI and processes them.
 * Specifically looks for 'sendMessageToCursor' commands.
 */
async function checkForOutgoingMessages() {
    if (!serviceApiToken || !serviceUserId) {
        // log('Pocket Agent: checkForOutgoingMessages - Not signed in, skipping outgoing message check.');
        // No need to log every poll interval if not signed in.
        return;
    }

    log('Pocket Agent: Checking for outgoing messages from web UI...');
    const debuggerTargets = await getWebSocketDebuggerUrlJs(); // Returns [{ url, title }]

    if (!debuggerTargets || debuggerTargets.length === 0) {
        // log('Pocket Agent: No active debugger targets to check messages for.');
        return;
    }

    const { default: fetch } = await import('node-fetch');

    for (const target of debuggerTargets) {
        if (!target.url) continue; // Should not happen if getWebSocketDebuggerUrlJs filters correctly

        const encodedWindowId = encodeURIComponent(target.url);
        const apiUrl = `${SERVER_URL}/api/commands/poll-outgoing/${encodedWindowId}`;

        try {
            // log(`Pocket Agent: Polling for window ${target.url.substring(0,20)}... at ${apiUrl}`);
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${serviceApiToken}`,
                    // No 'Content-Type' needed for GET typically, unless server requires it for some reason
                },
            });

            if (response.status === 204) {
                // No command pending for this window, which is normal
                // log(`Pocket Agent: No outgoing command for ${target.title || target.url.substring(0,20)}...`);
                continue;
            }

            if (response.ok) {
                const command = await response.json();
                if (command?.text) { // Changed to optional chain: command && command.text
                    log(`Pocket Agent: Received outgoing message for "${target.title || target.url}": "${command.text.substring(0, 50)}..."`);
                    await sendMessageToCursorWindow(target.url, command.text);
                } else if (command) { // If command exists but command.text doesn't
                    logWarn(`Pocket Agent: Received command for ${target.title || target.url}, but format is unexpected (missing text field):`, command);
                }
                // If response.ok but no command or unexpected format, it's already logged or we continue.
            } else {
                const errorBody = await response.text();
                logError(
                    `Pocket Agent: Error polling outgoing messages for "${target.title || target.url}". Status: ${response.status}`,
                    errorBody
                );
                // Handle auth errors specifically if needed, e.g., stop polling, prompt re-login
                if (response.status === 401 || response.status === 403) {
                    logError('Pocket Agent: Authentication error during outgoing message poll. Disabling polling for this session.');
                    // Consider stopping this specific polling interval or clearing auth tokens
                    // For now, it will just keep failing on auth for subsequent polls until fixed.
                    // This part might need more robust handling based on UX requirements.
                    if (outgoingMessagesPollInterval) clearInterval(outgoingMessagesPollInterval); // Stop this polling
                    outgoingMessagesPollInterval = null;
                    vscode.window.showErrorMessage('Pocket Agent: Authentication failed while checking for messages. Please sign in again.');
                    // Potentially trigger sign out / sign in flow here
                    return; // Stop further processing in this run
                }
            }
        } catch (error) {
            logError(`Pocket Agent: Network or other error polling outgoing messages for "${target.title || target.url}":`, error);
            // If fetch itself fails (network issue)
        }
    }
}

let outgoingMessagesPollInterval; // Declare variable for the new interval

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    extensionContext = context; // <<<< Assign context here

    // Create the output channel
    pocketAgentOutputChannel = vscode.window.createOutputChannel("Pocket Agent");
    context.subscriptions.push(pocketAgentOutputChannel);

    // Loggers are now defined at module scope and will use pocketAgentOutputChannel once it's set.
    // global.log and global.logError definitions are removed.

    log("Pocket Agent: Entering activate function...");
    log('Pocket Agent: Activating extension...');

    // Get User ID from settings, then environment variable as fallback (original logic commented out)
    // const config = vscode.workspace.getConfiguration('pocketAgent');
    // pocketAgentUserId = config.get('userId');
    // ... (rest of old UserID loading logic)

    if (!extensionContext) {
        logError("Pocket Agent: CRITICAL - extensionContext was not set during activation!");
    }

    const startPolling = () => {
        if (serviceApiToken && serviceUserId) { // Check if we are "signed in"
            log('Pocket Agent: Authenticated, starting chat polling & outgoing message checks.');
            if (chatPollInterval) {
                log('Pocket Agent: Clearing existing chatPollInterval before starting a new one.');
                clearInterval(chatPollInterval);
            }

            const pollIntervalEnv = process.env.POCKET_AGENT_POLL_INTERVAL;
            let pollIntervalMs = Number.parseInt(pollIntervalEnv);
            if (Number.isNaN(pollIntervalMs) || pollIntervalMs <= 0) {
                logWarn(`Pocket Agent: Invalid or no POCKET_AGENT_POLL_INTERVAL ("${pollIntervalEnv}"). Defaulting to 5000ms.`);
                pollIntervalMs = 5000;
            } else {
                log(`Pocket Agent: Using poll interval from POCKET_AGENT_POLL_INTERVAL: ${pollIntervalMs}ms.`);
            }

            log(`Pocket Agent: Setting up setInterval for fetchAndSendChatUpdate with ${pollIntervalMs}ms.`);
            chatPollInterval = setInterval(fetchAndSendChatUpdate, pollIntervalMs);
            log('Pocket Agent: setInterval for fetchAndSendChatUpdate has been set.');

            log('Pocket Agent: Attempting initial direct call to fetchAndSendChatUpdate...');
            fetchAndSendChatUpdate(); // Initial fetch
            log('Pocket Agent: Initial direct call to fetchAndSendChatUpdate has completed or is in progress (async).');

            // Start polling for outgoing messages from web UI
            if (outgoingMessagesPollInterval) {
                log('Pocket Agent: Clearing existing outgoingMessagesPollInterval.');
                clearInterval(outgoingMessagesPollInterval);
            }
            // Use a separate poll interval for this, or same as chatPollIntervalMs?
            // For now, using the same, but can be configured separately.
            const outgoingPollIntervalMs = pollIntervalMs; // or process.env.POCKET_AGENT_OUTGOING_POLL_INTERVAL etc.
            log(`Pocket Agent: Setting up setInterval for checkForOutgoingMessages with ${outgoingPollIntervalMs}ms.`);
            outgoingMessagesPollInterval = setInterval(checkForOutgoingMessages, outgoingPollIntervalMs);
            log('Pocket Agent: setInterval for checkForOutgoingMessages has been set.');
            checkForOutgoingMessages(); // Initial check

        } else {
            log('Pocket Agent: Not authenticated. Polling will not start until sign-in. Please use the "Pocket Agent: Sign In" command.');
        }
    };

    // Attempt to load stored API token and User ID on activation
    Promise.all([
        extensionContext.secrets.get('pocketAgentServiceApiToken'),
        extensionContext.secrets.get('pocketAgentServiceUserId')
    ]).then(([token, userId]) => {
            if (token) {
                serviceApiToken = token;
                log('Pocket Agent: Service API token loaded from secure storage.');
            } else {
                log('Pocket Agent: No service API token found in secure storage. User needs to sign in.');
            }
            if (userId) {
                serviceUserId = userId;
                log('Pocket Agent: Service User ID loaded from secure storage.');
            } else {
                log('Pocket Agent: No service User ID found in secure storage.');
            }
        startPolling(); // Attempt to start polling after loading secrets
    }).catch(error => {
        logError('Pocket Agent: Error loading secrets on activation:', error);
        startPolling(); // Still attempt to start polling, it will handle lack of auth
        });


    // Register the command to read chat text using CDP
    const readChatDisposable = vscode.commands.registerCommand('pocketAgent.readChatText', async () => {
        try {
            return await readChatTextLogicJs();
        } catch (e) {
            console.error("Pocket Agent: Unhandled error in 'pocketAgent.readChatText' command execution:", e);
            // vscode.window.showErrorMessage(`Pocket Agent: Failed to execute readChatText command: ${e.message}`);
            return null; // Ensure it returns something even on unhandled error
        }
    });
    context.subscriptions.push(readChatDisposable);

    // Register Sign In and Sign Out commands
    const signInDisposable = vscode.commands.registerCommand('pocketAgent.signIn', async () => {
        await signIn(extensionContext); // Pass the stored context
        startPolling(); // Attempt to start polling after sign-in attempt
    });
    context.subscriptions.push(signInDisposable);

    const signOutDisposable = vscode.commands.registerCommand('pocketAgent.signOut', async () => {
        await signOut(extensionContext); // Pass the stored context
        if (chatPollInterval) {
            log('Pocket Agent: Clearing chatPollInterval due to sign out.');
            clearInterval(chatPollInterval);
            chatPollInterval = null;
        }
        if (outgoingMessagesPollInterval) { // Also clear the new interval
            log('Pocket Agent: Clearing outgoingMessagesPollInterval due to sign out.');
            clearInterval(outgoingMessagesPollInterval);
            outgoingMessagesPollInterval = null;
        }
        // Optionally, inform the user that polling has stopped.
    });
    context.subscriptions.push(signOutDisposable);

    // Connect to the backend server - REMOVED
    // log("Pocket Agent: Attempting to connect to backend server...");
    // socket = io(SERVER_URL, { ... }); // REMOVED
    // log("Pocket Agent: Backend socket object created, attaching listeners..."); // REMOVED

    // socket.on('connect', () => { ... }); // REMOVED ENTIRE BLOCK

    // socket.on('sendMessageToWindow', async (data) => { ... }); // REMOVED - This functionality needs a new trigger if kept

    // socket.on('disconnect', (reason) => { ... }); // REMOVED

    // socket.on('connect_error', (error) => { ... }); // REMOVED

    // Original command for Cursor's internal use (if any)
    const toolCallDisposable = vscode.commands.registerCommand('_extensionClient.toolCall', (...args) => {
        log('Pocket Agent: _extensionClient.toolCall invoked with args:', args);
        // vscode.window.showInformationMessage('Pocket Agent: _extensionClient.toolCall executed.');
        return "Tool call received by Pocket Agent (placeholder).";
    });
    context.subscriptions.push(toolCallDisposable);

    // Command to manually trigger chat fetch (for debugging)
    const manualFetchDisposable = vscode.commands.registerCommand('pocketAgent.manualChatFetch', fetchAndSendChatUpdate);
    context.subscriptions.push(manualFetchDisposable);

    log("Pocket Agent: Before pushing main disposable...");

    // Ensure resources are cleaned up when the extension is deactivated
    context.subscriptions.push(new vscode.Disposable(() => {
        if (chatPollInterval) {
            clearInterval(chatPollInterval);
        }
        if (outgoingMessagesPollInterval) { // Ensure this is cleared on deactivate
            clearInterval(outgoingMessagesPollInterval);
        }
        // if (socket) { // Removed socket related cleanup
        //     socket.disconnect();
        // }
        // The output channel is automatically disposed because it was added to context.subscriptions
        log('Pocket Agent: Disposed resources.');
    }));

    log("Pocket Agent: After pushing main disposable, before final logs.");

    log('Pocket Agent: Extension activation complete.');
    // vscode.window.showInformationMessage('Pocket Agent Activated. Ensure Cursor is running with --remote-debugging-port=9223.');
    log('Pocket Agent: Information message shown - Pocket Agent Activated. Ensure Cursor is running with --remote-debugging-port=9223. Sign in if prompted.');
}

function deactivate() {
    if (chatPollInterval) clearInterval(chatPollInterval);
    if (outgoingMessagesPollInterval) clearInterval(outgoingMessagesPollInterval); // Clear on deactivate
    // if (socket) socket.disconnect(); // Removed socket related cleanup
    log('Pocket Agent: Extension deactivated.');
}

module.exports = {
    activate,
    deactivate
};

