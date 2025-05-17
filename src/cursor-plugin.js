const vscode = require('vscode');
// const io = require('socket.io-client'); // Removed: Socket.IO client
const WebSocket = require('ws'); // Added for WebSocket communication
const { initializeLogger, log, logError, logWarn } = require('./logger'); // Added
const {
    LEADER_ID_KEY,
    LEADER_TIMESTAMP_KEY,
    MAX_LEADER_AGE_MS,
    LEADER_HEARTBEAT_INTERVAL_MS,
    GITHUB_AUTH_PROVIDER_ID,
    SCOPES,
    // DEFAULT_SERVER_URL, // No longer needed here, config.js handles defaults
    // DEFAULT_CURSOR_DEBUG_PORT // No longer needed here
} = require('./constants');
const { initializeConfig, getServerUrl, getDebugPort, disposeConfigListener } = require('./config'); // Added config import
const { getWebSocketDebuggerUrlJs, sendCdpCommandJs, evaluateJavascriptInPageJs } = require('./cdpHelper'); // Import from cdpHelper

// This should ideally come from a configuration or environment variable
// Ensure this URL matches where your src/server/index.js is running
// const SERVER_URL = process.env.POCKET_AGENT_SERVER_URL || 'http://localhost:3000'; // Updated: Prioritize localhost:3000 if no env var
// const CURSOR_DEBUG_PORT = process.env.CURSOR_DEBUG_PORT || 9223; // Make debug port configurable
// let SERVER_URL; // Removed, use getServeUrl() from config.js
// let CURSOR_DEBUG_PORT; // Removed, use getDebugPort() from config.js

// const POCKET_AGENT_USER_ID = process.env.POCKET_AGENT_USER_ID || null; // User ID for authentication (old way)

let pocketAgentUserId; // Will be populated from settings or env var
let serviceApiToken;
let serviceUserId;
let extensionContext; // <<<< To store the extension context
let pocketAgentStatusBarItem; // Added for auth status
let isLeaderInstance = false; // Added for leader election
let currentInstanceId = Date.now().toString() + Math.random().toString(); // Unique ID for this instance
let leaderHeartbeatInterval = null; // Interval for leader to update its timestamp

// let socket; // Removed: For connection to backend server
let chatPollInterval;
// let cdpMessageId = 1; // Counter for CDP message IDs -- REMOVED, MOVED TO cdpHelper.js
let pocketAgentOutputChannel; // Declare output channel variable

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
                    const response = await fetch(`${getServerUrl()}/api/chat/update`, { // Use getter
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

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    console.log('Pocket Agent: Activating extension...');
    extensionContext = context; // Store context
    currentInstanceId = Date.now().toString() + Math.random().toString(); // Regenerate in case of re-activation

    // Initialize Output Channel first
    if (!pocketAgentOutputChannel) {
        pocketAgentOutputChannel = vscode.window.createOutputChannel("Pocket Agent");
        log('Pocket Agent: Output channel created and logger initialized.'); // <<<< Example of using the new logger
    }
    initializeLogger(pocketAgentOutputChannel); // <<<< Initialize the new logger
    initializeConfig(); // Initialize configuration module
    pocketAgentOutputChannel.show(true); // Show the output channel on activation for visibility

    log(`Pocket Agent: Instance ${currentInstanceId} activating.`);
    vscode.window.setStatusBarMessage('Pocket Agent: Initializing...', 2000);

    // Create Status Bar Item
    pocketAgentStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(pocketAgentStatusBarItem);

    // --- Leader Election Logic ---
    const globalState = context.globalState;
    const leaderId = globalState.get(LEADER_ID_KEY);
    const leaderTimestamp = globalState.get(LEADER_TIMESTAMP_KEY);
    let becomeLeader = false;

    if (!leaderId || !leaderTimestamp) {
        log('Pocket Agent: No current leader found, attempting to become leader.');
        becomeLeader = true;
    } else {
        const leaderAge = Date.now() - leaderTimestamp;
        if (leaderAge > MAX_LEADER_AGE_MS) {
            log(`Pocket Agent: Current leader (${leaderId}) is stale (age: ${leaderAge}ms). Attempting to take over.`);
            becomeLeader = true;
        } else {
            log(`Pocket Agent: Active leader (${leaderId}) found. This instance (${currentInstanceId}) will be secondary. Leader age: ${leaderAge}ms`);
            isLeaderInstance = false;
        }
    }

    if (becomeLeader) {
        log(`Pocket Agent: Instance ${currentInstanceId} attempting to acquire leader lock.`);
        await globalState.update(LEADER_ID_KEY, currentInstanceId);
        await globalState.update(LEADER_TIMESTAMP_KEY, Date.now());
        // Verify we actually became the leader (simple race condition check)
        const newLeaderId = globalState.get(LEADER_ID_KEY);
        if (newLeaderId === currentInstanceId) {
            log(`Pocket Agent: Instance ${currentInstanceId} successfully became the leader.`);
            isLeaderInstance = true;
        } else {
            log(`Pocket Agent: Instance ${currentInstanceId} lost leader race to ${newLeaderId}. Remaining secondary.`);
            isLeaderInstance = false;
        }
    }

    if (isLeaderInstance) {
        log(`Pocket Agent: Instance ${currentInstanceId} is the leader. Starting leader heartbeat.`);
        // Clear any existing heartbeat interval before starting a new one
        if (leaderHeartbeatInterval) clearInterval(leaderHeartbeatInterval);
        leaderHeartbeatInterval = setInterval(async () => {
            if (isLeaderInstance && extensionContext) { // Double check it's still supposed to be leader
                 // log('Pocket Agent: Leader heartbeat - updating timestamp.');
                await extensionContext.globalState.update(LEADER_TIMESTAMP_KEY, Date.now());
            } else {
                // No longer leader, or context lost, clear interval
                if(leaderHeartbeatInterval) clearInterval(leaderHeartbeatInterval);
                leaderHeartbeatInterval = null;
            }
        }, LEADER_HEARTBEAT_INTERVAL_MS);
        context.subscriptions.push(new vscode.Disposable(() => {
            if (leaderHeartbeatInterval) clearInterval(leaderHeartbeatInterval);
        }));
    } else {
        log(`Pocket Agent: Instance ${currentInstanceId} is a secondary instance. Polling will not start.`);
    }
    // --- End Leader Election Logic ---

    // Config is now loaded by initializeConfig(), access via getters
    log(`Pocket Agent: Using Server URL: ${getServerUrl()}`);
    log(`Pocket Agent: Using Cursor Debug Port: ${getDebugPort()}`);

    // Test CDP connection
    vscode.window.setStatusBarMessage('Pocket Agent: Checking Cursor connection...', 3000);
    try {
        const debuggerUrls = await getWebSocketDebuggerUrlJs();
        if (debuggerUrls && debuggerUrls.length > 0) {
            log(`Pocket Agent: Successfully fetched ${debuggerUrls.length} Cursor debugger URL(s).`);
            // Display the first one found, or the one with "workbench"
            const workbenchTarget = debuggerUrls.find(t => t.title?.includes('workbench.html')) || debuggerUrls[0];
            if (workbenchTarget) {
                 log(`Pocket Agent: Primary target: ${workbenchTarget.title} (${workbenchTarget.url})`);
                 vscode.window.setStatusBarMessage(`Pocket Agent: Connected to Cursor (${workbenchTarget.title})`, 5000);
            } else {
                 vscode.window.setStatusBarMessage('Pocket Agent: Connected to Cursor.', 5000);
            }
        } else {
            logError('Pocket Agent: Could not connect to Cursor debugger. Ensure Cursor is running with remote debugging enabled.');
            vscode.window.showErrorMessage('Pocket Agent: Could not connect to Cursor. Ensure it is running with remote debugging enabled on the configured port.');
            vscode.window.setStatusBarMessage('Pocket Agent: Cursor connection failed.', 5000);
        }
    } catch (error) {
        logError('Pocket Agent: Error during initial Cursor connection test:', error);
        vscode.window.showErrorMessage(`Pocket Agent: Error connecting to Cursor: ${error.message}`);
        vscode.window.setStatusBarMessage('Pocket Agent: Cursor connection error.', 5000);
    }

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

    // At the end of activate, after settings are loaded and before commands are registered (or after):
    await attemptToLoadStoredAuth();
    await updateAuthStatusUI();

    // Register Commands (ensure this is present)
    context.subscriptions.push(vscode.commands.registerCommand('pocketAgent.signIn', () => signIn(context)));
    context.subscriptions.push(vscode.commands.registerCommand('pocketAgent.signOut', () => signOut(context)));
    // ... other command registrations ...
    context.subscriptions.push(vscode.commands.registerCommand('pocketAgent.readChatText', async () => {
        if (!serviceApiToken || !serviceUserId) {
            const action = await vscode.window.showWarningMessage(
                'Pocket Agent requires sign-in to read chat text.',
                { modal: false },
                'Sign In'
            );
            if (action === 'Sign In') {
                vscode.commands.executeCommand('pocketAgent.signIn');
            }
            return;
        }
        readChatTextLogicJs(); // Assuming this function exists
    }));

    // Ensure polling starts if needed, and other initializations
    if (isLeaderInstance) {
        log("Pocket Agent: Leader instance proceeding to start polling.");
        startPolling(); // This function should only be called if leader
    } else {
        log("Pocket Agent: Secondary instance. Polling disabled.");
    }
    log("Pocket Agent: Activation complete.");
}

function deactivate() {
    if (chatPollInterval) clearInterval(chatPollInterval);
    if (outgoingMessagesPollInterval) clearInterval(outgoingMessagesPollInterval); // Clear on deactivate
    if (leaderHeartbeatInterval) clearInterval(leaderHeartbeatInterval); // Clear leader heartbeat
    disposeConfigListener(); // Dispose the config listener

    if (isLeaderInstance && extensionContext) {
        // If this instance was the leader, try to clear the leader state
        // so another instance can take over more quickly.
        // Check if we are STILL the leader before clearing, to avoid clearing another instance's lock.
        const currentLeaderId = extensionContext.globalState.get(LEADER_ID_KEY);
        if (currentLeaderId === currentInstanceId) {
            log('Pocket Agent: Leader instance deactivating. Clearing leader information from globalState.');
            extensionContext.globalState.update(LEADER_ID_KEY, undefined);
            extensionContext.globalState.update(LEADER_TIMESTAMP_KEY, undefined);
        } else {
            log('Pocket Agent: Instance was marked as leader, but globalState shows a different leader. Not clearing global leader info.');
        }
    }
    isLeaderInstance = false; // Reset for safety if reactivated

    // if (socket) socket.disconnect(); // Removed socket related cleanup
    log('Pocket Agent: Extension deactivated.');
}

async function updateAuthStatusUI() {
    if (!pocketAgentStatusBarItem) return; // Should be created in activate

    if (serviceApiToken && serviceUserId) {
        // Potentially fetch user info here to display name if available from GitHub session or serviceUserId
        // For now, just a generic signed-in message.
        // We need to ensure `vscode.authentication.getSession` is accessible to get account label
        // or store it during signIn.
        // Let's try to retrieve it if a session exists.
        let accountLabel = 'User';
        try {
            const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, SCOPES, { createIfNone: false });
            if (session) {
                accountLabel = session.account.label;
            }
        } catch (err) {
            // Could be no session, or error. Keep default.
            log('Pocket Agent: Could not get session for status bar update, using default label.');
        }

        pocketAgentStatusBarItem.text = `$(key) Pocket Agent: Signed In (${accountLabel})`;
        pocketAgentStatusBarItem.tooltip = 'Pocket Agent: Click to Sign Out';
        pocketAgentStatusBarItem.command = 'pocketAgent.signOut';
        pocketAgentStatusBarItem.show();
    } else {
        pocketAgentStatusBarItem.text = '$(plug) Pocket Agent: Signed Out';
        pocketAgentStatusBarItem.tooltip = 'Pocket Agent: Click to Sign In';
        pocketAgentStatusBarItem.command = 'pocketAgent.signIn';
        pocketAgentStatusBarItem.show();
    }
}

async function attemptToLoadStoredAuth() {
    if (!extensionContext) {
        logError('Pocket Agent: Cannot load stored auth, extensionContext is not available.');
        return;
    }
    try {
        const token = await extensionContext.secrets.get('pocketAgentServiceApiToken');
        const userId = await extensionContext.secrets.get('pocketAgentServiceUserId');
        if (token && userId) {
            serviceApiToken = token;
            serviceUserId = userId;
            log('Pocket Agent: Loaded stored API token and User ID.');
        } else {
            log('Pocket Agent: No stored API token or User ID found.');
        }
    } catch (error) {
        logError('Pocket Agent: Error loading stored authentication details:', error);
    }
}

async function signIn(contextFromCommand) {
    if (!extensionContext) {
        logError('Pocket Agent: Extension context not available in signIn. Activate might not have completed.');
        vscode.window.showErrorMessage('Pocket Agent: Sign-in failed. Extension not fully activated.');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Pocket Agent: Signing In",
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ message: "Authenticating with GitHub..." });
            log('Pocket Agent: Initiating GitHub sign-in process...');

            const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, SCOPES, { createIfNone: true });

            if (session) {
                log(`Pocket Agent: Successfully obtained GitHub session. Account: ${session.account.label}`);
                progress.report({ message: "Verifying with Pocket Agent server..." });

                log('Pocket Agent: Exchanging GitHub token for service API token...');
                const { default: fetch } = await import('node-fetch');
                const response = await fetch(`${getServerUrl()}/api/auth/vscode/github-exchange`, { // Use getter
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
                        await updateAuthStatusUI();
                        fetchAndSendChatUpdate();
                    } else {
                        logError('Pocket Agent: Service token exchange response missing apiToken or userId.', serviceAuthData);
                        vscode.window.showErrorMessage('Pocket Agent: Sign-in failed. Invalid response from server.');
                    }
                } else {
                    const errorText = await response.text();
                    logError(`Pocket Agent: Failed to exchange GitHub token with backend. Status: ${response.status}`, errorText);
                    vscode.window.showErrorMessage(`Pocket Agent: Sign-in failed. Server verification error (Status: ${response.status}).`);
                }
            } else {
                log('Pocket Agent: GitHub authentication session not obtained.');
                vscode.window.showWarningMessage('Pocket Agent: GitHub sign-in was cancelled or failed.');
            }
        } catch (error) {
            logError('Pocket Agent: Error during sign-in process:', error);
            vscode.window.showErrorMessage(`Pocket Agent: Sign-in error: ${error.message}`);
        }
    });
    await updateAuthStatusUI();
}

async function signOut(contextFromCommand) {
    if (!extensionContext) {
        logError('Pocket Agent: Extension context not available in signOut.');
        vscode.window.showErrorMessage('Pocket Agent: Sign-out failed. Extension not fully activated.');
        return;
    }
    try {
        log('Pocket Agent: Signing out...');
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
    await updateAuthStatusUI();
}

async function checkForOutgoingMessages() {
    if (!serviceApiToken || !serviceUserId) {
        return;
    }

    log('Pocket Agent: Checking for outgoing messages from web UI...');
    const debuggerTargets = await getWebSocketDebuggerUrlJs();

    if (!debuggerTargets || debuggerTargets.length === 0) {
        return;
    }

    const { default: fetch } = await import('node-fetch');

    for (const target of debuggerTargets) {
        if (!target.url) continue;

        const encodedWindowId = encodeURIComponent(target.url);
        const apiUrl = `${getServerUrl()}/api/commands/poll-outgoing/${encodedWindowId}`; // Use getter

        try {
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${serviceApiToken}`,
                },
            });

            if (response.status === 204) {
                continue;
            }

            if (response.ok) {
                const command = await response.json();
                if (command?.text) {
                    log(`Pocket Agent: Received outgoing message for "${target.title || target.url}": "${command.text.substring(0, 50)}..."`);
                    await sendMessageToCursorWindow(target.url, command.text);
                } else if (command) {
                    logWarn(`Pocket Agent: Received command for ${target.title || target.url}, but format is unexpected (missing text field):`, command);
                }
            } else {
                const errorBody = await response.text();
                logError(
                    `Pocket Agent: Error polling outgoing messages for "${target.title || target.url}". Status: ${response.status}`,
                    errorBody
                );
                if (response.status === 401 || response.status === 403) {
                    logError('Pocket Agent: Authentication error during outgoing message poll. Disabling polling for this session.');
                    if (outgoingMessagesPollInterval) clearInterval(outgoingMessagesPollInterval);
                    outgoingMessagesPollInterval = null;
                    vscode.window.showErrorMessage('Pocket Agent: Authentication failed while checking for messages. Please sign in again.');
                    return;
                }
            }
        } catch (error) {
            logError(`Pocket Agent: Network or other error polling outgoing messages for "${target.title || target.url}":`, error);
        }
    }
}

let outgoingMessagesPollInterval;

module.exports = {
    activate,
    deactivate
};

