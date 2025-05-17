const { getDebugPort } = require('./config');
const { log, logError, logWarn } = require('./logger');

let cdpMessageId = 1; // Counter for CDP message IDs, moved here

/**
 * Fetches the WebSocket debugger URL for the main Cursor workbench.
 * Mimics the logic from the Python script.
 * @returns {Promise<Array<{url: string, title: string}>>} Array of objects with WebSocket debugger URL and title, or empty array if not found/error.
 */
async function getWebSocketDebuggerUrlJs() {
    if (typeof getDebugPort() === 'undefined') {
        logError('Pocket Agent: CURSOR_DEBUG_PORT is not initialized. Call activate first.');
        return [];
    }
    const currentDebugPort = getDebugPort(); // Capture once for consistent use in this function call
    const targetUrl = `http://localhost:${currentDebugPort}/json/list`;
    log(`Pocket Agent: Attempting to connect to Cursor debug targets at: ${targetUrl}`);

    try {
        const { default: fetch } = await import('node-fetch');
        const response = await fetch(targetUrl);
        if (!response.ok) {
            logError(`Pocket Agent: Cursor debug port (${currentDebugPort}) not accessible. Status: ${response.status} ${response.statusText}. Ensure Cursor is started with --remote-debugging-port=${currentDebugPort}.`);
            return [];
        }
        const targets = await response.json();
        if (!targets || targets.length === 0) {
            logError('Pocket Agent: No Cursor windows found on debug port.');
            return [];
        }

        const pageTargets = targets.filter(t => t.type === 'page');
        if (pageTargets.length === 0) {
            logError(`Pocket Agent: No 'page' type targets found on port ${currentDebugPort}. Available targets: ${JSON.stringify(targets)}`);
            return [];
        }

        const workbenchPages = pageTargets.filter(p => p.url?.includes('workbench.html'));
        let selectedTargetsInfo = []; // Will store { url, title }

        if (workbenchPages.length > 0) {
            selectedTargetsInfo = workbenchPages.map(p => ({ url: p.webSocketDebuggerUrl, title: p.title || p.url || 'Untitled Page' })).filter(t => t.url);
            log(`Pocket Agent: Found ${selectedTargetsInfo.length} workbench.html page(s) with debugger URLs.`);
            selectedTargetsInfo.forEach((p, index) => {
                log(`  Page ${index + 1}: Title='${p.title}', URL='${p.url}'`);
            });
        } else {
            log('Pocket Agent: No workbench.html page found. Looking for other suitable pages.');
            const preferredOthers = pageTargets.filter(p =>
                !['assistant-ui', 'extension-host', 'developer tools'].some(kw => (p.title || '').toLowerCase().includes(kw)) &&
                !(p.url || '').startsWith('devtools://')
            );

            if (preferredOthers.length > 0) {
                const firstPreferred = preferredOthers[0];
                if (firstPreferred.webSocketDebuggerUrl) {
                    selectedTargetsInfo = [{ url: firstPreferred.webSocketDebuggerUrl, title: firstPreferred.title || firstPreferred.url || 'Untitled Page' }];
                    log(`Pocket Agent: Using the first suitable other page as a fallback: Title='${selectedTargetsInfo[0].title}'`);
                } else {
                    logWarn('Pocket Agent: First preferred other page found, but it has no webSocketDebuggerUrl.', firstPreferred);
                }
            } else if (pageTargets.length > 0) {
                const firstAvailable = pageTargets[0];
                if (firstAvailable.webSocketDebuggerUrl) {
                    selectedTargetsInfo = [{ url: firstAvailable.webSocketDebuggerUrl, title: firstAvailable.title || firstAvailable.url || 'Untitled Page' }];
                    log(`Pocket Agent: No workbench.html page and no other preferred page types. Using the first available page as a fallback: Title='${selectedTargetsInfo[0].title}'.`);
                } else {
                     logWarn('Pocket Agent: First available page found, but it has no webSocketDebuggerUrl.', firstAvailable);
                }
            }
        }

        if (selectedTargetsInfo.length === 0) {
            logError(`Pocket Agent: Could not select any suitable 'page' target with a webSocketDebuggerUrl. Available pages: ${JSON.stringify(pageTargets)}`);
            return [];
        }

        // Filter again to ensure all items in selectedTargetsInfo have a URL (should be redundant if logic above is correct)
        const finalTargets = selectedTargetsInfo.filter(t => !!t.url);
        if (finalTargets.length !== selectedTargetsInfo.length) {
            logWarn('Pocket Agent: Some selected targets were missing debugger URLs after final filtering.');
        }

        if (finalTargets.length === 0) {
            logError('Pocket Agent: After all filtering, no targets with webSocketDebuggerUrl were found.');
            return [];
        }

        log(`Pocket Agent: Returning ${finalTargets.length} debugger targets with URLs and titles.`);
        return finalTargets;

    } catch (error) {
        logError('Pocket Agent: Error fetching Cursor debug targets:', error);
        if (error.message.includes('fetch is not defined') || error.message.includes('Failed to fetch')) {
            logError('Pocket Agent: getWebSocketDebuggerUrlJs - The "fetch" function is not available. Ensure you are in an environment that supports fetch (like Node.js 18+) or have a polyfill (like node-fetch) correctly imported and available.');
        }
        return [];
    }
}

module.exports = {
    getWebSocketDebuggerUrlJs,
    sendCdpCommandJs,
    evaluateJavascriptInPageJs,
};

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
