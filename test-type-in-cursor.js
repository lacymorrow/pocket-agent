const WebSocket = require('ws');

// --- Configuration ---
// Replace with the actual webSocketDebuggerUrl of the target Cursor window
// (e.g., from http://localhost:9223/json/list)
const TARGET_WINDOW_ID = 'ws://localhost:9223/devtools/page/FEA33A703DDEA80DAAD7282985C32604';
const MESSAGE_TO_SEND = 'Hello from test script!';
// ---------------------

let cdpMessageId = 1;

// Simplified logging functions for the test script
function log(message, ...optionalParams) {
    const fullMessage = optionalParams.length > 0 ? `${message} ${optionalParams.join(' ')}` : message;
    console.log(`[TestScript] ${fullMessage}`);
}

function logError(message, error) {
    console.error(`[TestScript] ERROR: ${message}`);
    if (error?.message) {
        console.error(`  Details: ${error.message}`);
    } else if (typeof error === 'string') {
        console.error(`  Details: ${error}`);
    } else if (error) {
        try {
            console.error(`  Details: ${JSON.stringify(error)}`);
        } catch (e) {
            console.error('  Details (unserializable error object):', error);
        }
    }
}

// Copied from src/cursor-plugin.js
function sendCdpCommandJs(ws, method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const id = cdpMessageId++;
        const payload = JSON.stringify({ id, method, params });
        const timeoutHandle = setTimeout(() => {
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            logError(`Timeout waiting for CDP response for method ${method} (ID: ${id})`);
            reject(new Error(`Timeout waiting for CDP response for ${method}`));
        }, timeoutMs);

        const messageListener = (message) => {
            try {
                const parsedMessage = JSON.parse(message.toString());
                if (parsedMessage.id === id) {
                    clearTimeout(timeoutHandle);
                    ws.removeListener('message', messageListener);
                    ws.removeListener('error', errorListener);
                    ws.removeListener('close', closeListener);
                    if (parsedMessage.error) {
                        logError(`CDP Error for method ${method} (ID: ${id}):`, parsedMessage.error);
                        reject(new Error(`CDP Error: ${parsedMessage.error.message} (Code: ${parsedMessage.error.code})`));
                    } else {
                        resolve(parsedMessage.result);
                    }
                }
            } catch (e) {
                logError('Error parsing CDP message:', e, message.toString());
            }
        };
        const errorListener = (error) => {
            clearTimeout(timeoutHandle);
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            logError('CDP WebSocket error:', error);
            reject(new Error(`CDP WebSocket error: ${error.message}`));
        };
        const closeListener = (code, reason) => {
            clearTimeout(timeoutHandle);
            ws.removeListener('message', messageListener);
            ws.removeListener('error', errorListener);
            ws.removeListener('close', closeListener);
            log('CDP WebSocket closed unexpectedly:', code, reason ? reason.toString() : 'No reason given');
            reject(new Error(`CDP WebSocket closed: ${code} ${reason ? reason.toString() : 'No reason given'}`));
        };
        ws.on('message', messageListener);
        ws.on('error', errorListener);
        ws.on('close', closeListener);
        log(`[CDP SEND ID ${id}] Method: ${method}, Params: ${JSON.stringify(params)}`);
        ws.send(payload);
    });
}

// Copied and adapted from src/cursor-plugin.js (latest version with click logic)
async function sendMessageToCursorWindow(windowId, messageText) {
    if (!windowId || typeof windowId !== 'string' || windowId === 'ws://localhost:9223/devtools/page/YOUR_TARGET_PAGE_ID_HERE') {
        logError('sendMessageToCursorWindow called with invalid or placeholder windowId.', windowId);
        console.error('Please update TARGET_WINDOW_ID in the script with a valid webSocketDebuggerUrl.');
        return;
    }
    if (typeof messageText !== 'string' || messageText.trim() === '') {
        logError('sendMessageToCursorWindow called with invalid or empty messageText.', messageText);
        return;
    }

    log(`Attempting to send message to window: ${windowId} | Message: "${messageText.substring(0,50)}..."`);
    let cdpWs;
    try {
        cdpWs = new WebSocket(windowId);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                logError(`CDP WebSocket connection timeout for ${windowId}`);
                reject(new Error(`CDP WebSocket connection timeout for ${windowId}`));
            }, 5000);
            cdpWs.on('open', () => {
                clearTimeout(timeout);
                log(`Connected to Cursor CDP WebSocket for ${windowId}`);
                resolve();
            });
            cdpWs.on('error', (err) => {
                clearTimeout(timeout);
                logError(`Error connecting to Cursor CDP WebSocket for ${windowId}:`, err);
                reject(err);
            });
            cdpWs.on('close', (code, reason) => {
                log(`CDP WebSocket closed for ${windowId}. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
            });
        });

        await sendCdpCommandJs(cdpWs, 'Page.enable');
        await sendCdpCommandJs(cdpWs, 'DOM.enable');
        await sendCdpCommandJs(cdpWs, 'Runtime.enable');

        const selectors = [
            '.aislash-editor-input',
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
                log(`Trying selector for chat input: "${selector}" in ${windowId}`);
                const queryResult = await sendCdpCommandJs(cdpWs, 'DOM.querySelector', {
                    nodeId: documentNode.nodeId,
                    selector: selector
                });
                if (queryResult?.nodeId !== 0) {
                    const boxModel = await sendCdpCommandJs(cdpWs, 'DOM.getBoxModel', { nodeId: queryResult.nodeId });
                    if (boxModel?.model?.width > 0 && boxModel?.model?.height > 0) {
                        inputNodeId = queryResult.nodeId;
                        foundSelector = selector;
                        log(`Found visible chat input with selector "${selector}", nodeId: ${inputNodeId} in ${windowId}`);
                        break;
                    }
                    log(`Found chat input with selector "${selector}" but it might not be visible (width/height 0). NodeId: ${queryResult.nodeId}`);
                }
            } catch (e) {
                log(`Selector "${selector}" failed or element not found for ${windowId}: ${e.message}`);
            }
        }

        if (!inputNodeId) {
            logError(`Could not find a visible chat input element in window ${windowId} using any of the selectors.`);
            throw new Error('Chat input element not found or not visible in target window.');
        }

        if (foundSelector === '.aislash-editor-input') {
            log(`Found selector is '${foundSelector}'. Attempting to click it first.`);
            const boxModelResult = await sendCdpCommandJs(cdpWs, 'DOM.getBoxModel', { nodeId: inputNodeId });
            if (boxModelResult?.model?.content?.length >= 6) {
                const contentQuad = boxModelResult.model.content;
                const centerX = Math.round((contentQuad[0] + contentQuad[2]) / 2);
                const centerY = Math.round((contentQuad[1] + contentQuad[5]) / 2); // Correct index for Y calculation in a quad
                log(`Calculated click coordinates for '.aislash-editor-input': x=${centerX}, y=${centerY}`);
                await sendCdpCommandJs(cdpWs, 'Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: centerX, y: centerY, button: 'left', clickCount: 1
                }, 2000);
                await sendCdpCommandJs(cdpWs, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: centerX, y: centerY, button: 'left', clickCount: 1
                }, 2000);
                log(`Click dispatched to '.aislash-editor-input'. Waiting for UI to update.`);
                await new Promise(resolve => setTimeout(resolve, 300)); // Slightly increased wait time
            } else {
                logError('Could not get box model or content quad for \'.aislash-editor-input\' to click.');
            }
        }

        log(`Focusing chat input with nodeId: ${inputNodeId} in ${windowId}`);
        await sendCdpCommandJs(cdpWs, 'DOM.focus', { nodeId: inputNodeId });
        log(`Focused chat input in ${windowId}.`);

        await sendCdpCommandJs(cdpWs, 'DOM.scrollIntoViewIfNeeded', { nodeId: inputNodeId });
        log(`Scrolled chat input into view if needed in ${windowId}.`);

        // For contenteditable, sometimes clearing existing content first is more reliable
        if (foundSelector === '.aislash-editor-input') {
            log('Clearing content of .aislash-editor-input before inserting new text.');
            // One way to clear a contenteditable div is to set its innerHTML to '' or a <p><br></p>
            // However, directly via CDP, sending Backspace until empty or using Input.insertText with an empty string after selecting all might be options.
            // For simplicity and given we've clicked and focused, Input.insertText should overwrite or append.
            // If issues persist, a more aggressive clear might be needed:
            // e.g., Runtime.evaluate with `document.querySelector(\'${foundSelector}\').innerHTML = \'\'`
        }

        log(`Inserting text into chat input in ${windowId}: "${messageText}"`);
        await sendCdpCommandJs(cdpWs, 'Input.insertText', { text: messageText });
        log(`Text insertion command sent for "${messageText}" in ${windowId}.`);

        log(`Simulating Enter key press in ${windowId}`);
        const enterKeyEvents = [
            { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
            { type: 'char', text: '\r' },
            { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        ];

        for (const event of enterKeyEvents) {
            await sendCdpCommandJs(cdpWs, 'Input.dispatchKeyEvent', event, 2000);
        }
        log(`Finished simulating Enter key press in ${windowId}`);

    } catch (error) {
        logError(`Error sending message to window ${windowId}:`, error);
    } finally {
        if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
            log(`Closing Cursor CDP WebSocket for ${windowId}.`);
            cdpWs.close();
        } else if (cdpWs) {
            log(`Cursor CDP WebSocket for ${windowId} was already closed or not opened.`);
        }
        log('Test script finished.');
    }
}

// --- Main execution ---
if (!TARGET_WINDOW_ID || TARGET_WINDOW_ID === 'ws://localhost:9223/devtools/page/YOUR_TARGET_PAGE_ID_HERE') {
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.error('!!! PLEASE SET THE TARGET_WINDOW_ID in test-type-in-cursor.js       !!!');
    console.error('!!! Find it by visiting http://localhost:9223/json/list in your browser !!!');
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
} else if (!MESSAGE_TO_SEND) {
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.error('!!! PLEASE SET THE MESSAGE_TO_SEND in test-type-in-cursor.js      !!!');
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
}else {
    sendMessageToCursorWindow(TARGET_WINDOW_ID, MESSAGE_TO_SEND);
}
