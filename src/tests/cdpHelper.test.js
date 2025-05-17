const vscode = require('vscode'); // Mocked
// const { getWebSocketDebuggerUrlJs } = require('../cdpHelper'); // Will be dynamically imported
const { getDebugPort } = require('../config'); // Keep this as require if config.js is CJS
const { log, logError, logWarn } = require('../logger'); // Keep this as require if logger.js is CJS

// Mock logger
jest.mock('../logger', () => ({
    initializeLogger: jest.fn(),
    log: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
}));

// Mock config module
jest.mock('../config', () => ({
    initializeConfig: jest.fn(),
    getDebugPort: jest.fn(),
    getServerUrl: jest.fn(),
}));

// Mock node-fetch for dynamic import
const mockFetch = jest.fn();

// Use jest.unstable_mockModule for ESM-style dynamic imports
// This tells Jest what 'node-fetch' should resolve to when dynamically imported
jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch,
  __esModule: true, // Important for ESM compatibility
}));

// Dynamically import the module under test AFTER mocks are set up
let getWebSocketDebuggerUrlJs;
let sendCdpCommandJs;
let evaluateJavascriptInPageJs;

beforeAll(async () => {
  const cdpModule = await import('../cdpHelper');
  getWebSocketDebuggerUrlJs = cdpModule.getWebSocketDebuggerUrlJs;
  sendCdpCommandJs = cdpModule.sendCdpCommandJs;
  evaluateJavascriptInPageJs = cdpModule.evaluateJavascriptInPageJs;
});

describe('CDP Helper - getWebSocketDebuggerUrlJs', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getDebugPort.mockReturnValue(9223);
        mockFetch.mockReset(); // Reset fetch mock before each test
    });

    it('should return an empty array if CURSOR_DEBUG_PORT is undefined', async () => {
        getDebugPort.mockReturnValue(undefined);
        const urls = await getWebSocketDebuggerUrlJs();
        expect(urls).toEqual([]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('CURSOR_DEBUG_PORT is not initialized'));
    });

    it('should log an error and return empty array if fetch fails', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        const urls = await getWebSocketDebuggerUrlJs();
        expect(urls).toEqual([]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('Error fetching Cursor debug targets'), expect.any(Error));
    });

    it('should log an error and return empty array if response is not ok', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found'
        });
        const urls = await getWebSocketDebuggerUrlJs();
        expect(urls).toEqual([]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('not accessible. Status: 404 Not Found'));
    });

    it('should log an error and return empty array if no targets are returned', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
        const urls = await getWebSocketDebuggerUrlJs();
        expect(urls).toEqual([]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('No Cursor windows found'));
    });

    it('should log an error and return empty array if no page type targets are found', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{ type: 'other' }] });
        const urls = await getWebSocketDebuggerUrlJs();
        expect(urls).toEqual([]);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('No \'page\' type targets found'));
    });

    it('should select workbench.html pages first', async () => {
        const mockTargets = [
            { type: 'page', url: 'some-other-page', webSocketDebuggerUrl: 'ws://other', title: 'Other Page' },
            { type: 'page', url: 'includes-workbench.html', webSocketDebuggerUrl: 'ws://workbench1', title: 'Workbench 1' },
            { type: 'page', url: 'another-workbench.html', webSocketDebuggerUrl: 'ws://workbench2', title: 'Workbench 2 Title' },
        ];
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockTargets });
        const result = await getWebSocketDebuggerUrlJs();
        expect(result).toEqual([
            { url: 'ws://workbench1', title: 'Workbench 1' },
            { url: 'ws://workbench2', title: 'Workbench 2 Title' },
        ]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Found 2 workbench.html page(s) with debugger URLs'));
    });

    it('should select preferred other pages if no workbench.html is found', async () => {
        const mockTargets = [
            { type: 'page', url: 'devtools://foo', webSocketDebuggerUrl: 'ws://devtools', title: 'DevTools Internal' },
            { type: 'page', url: 'http://some.app/page1', webSocketDebuggerUrl: 'ws://page1', title: 'My App Page 1' },
            { type: 'page', title: 'assistant-ui-some-id', webSocketDebuggerUrl: 'ws://assistant'},
        ];
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockTargets });
        const result = await getWebSocketDebuggerUrlJs();
        expect(result).toEqual([{ url: 'ws://page1', title: 'My App Page 1' }]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Using the first suitable other page as a fallback'));
    });

    it('should fallback to the first page target if no workbench or preferred other pages', async () => {
        const mockTargets = [
            { type: 'page', url: 'devtools://foo', webSocketDebuggerUrl: 'ws://devtools1', title: 'DevTools Main' },
            { type: 'page', url: 'url-with-no-title', webSocketDebuggerUrl: 'ws://no-title-ws-url' },
        ];
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockTargets });
        const result = await getWebSocketDebuggerUrlJs();
        expect(result).toEqual([{ url: 'ws://no-title-ws-url', title: 'url-with-no-title' }]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Using the first suitable other page as a fallback'));
    });

    it('should use the very first page target if workbench and preferredOthers are empty', async () => {
        const mockTargets = [
            { type: 'page', url: 'devtools://excluded', webSocketDebuggerUrl: 'ws://devtools-real', title: 'DevTools Excluded Title' },
        ];
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockTargets });
        const result = await getWebSocketDebuggerUrlJs();
        expect(result).toEqual([{ url: 'ws://devtools-real', title: 'DevTools Excluded Title' }]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Using the first available page as a fallback'));
    });

    it('should return empty array if selected targets have no webSocketDebuggerUrl (single workbench page case)', async () => {
        const mockTargets = [
            { type: 'page', url: 'includes-workbench.html', title: 'Workbench No URL' }, // Missing webSocketDebuggerUrl
        ];
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockTargets });
        const result = await getWebSocketDebuggerUrlJs();
        expect(result).toEqual([]);
        // This specific log might change based on internal logic of getWebSocketDebuggerUrlJs,
        // but it should log some error about not finding usable URLs.
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('Could not select any suitable \'page\' target with a webSocketDebuggerUrl'));
    });

    it('should filter out targets with no webSocketDebuggerUrl from the final result (mixed case)', async () => {
        const mockTargets = [
            { type: 'page', url: 'workbench.html', webSocketDebuggerUrl: 'ws://valid', title: 'Valid Workbench' },
            { type: 'page', url: 'workbench.html', title: 'Invalid Workbench' }, // No webSocketDebuggerUrl
        ];
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockTargets });
        const result = await getWebSocketDebuggerUrlJs();
        expect(result).toEqual([{ url: 'ws://valid', title: 'Valid Workbench' }]);
    });

    it('should use target.url as fallback for title if title is missing', async () => {
        const mockTargets = [
            { type: 'page', url: 'http://my.site/interesting-url', webSocketDebuggerUrl: 'ws://title-test' }, // No title field
        ];
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockTargets });
        const result = await getWebSocketDebuggerUrlJs();
        expect(result).toEqual([{ url: 'ws://title-test', title: 'http://my.site/interesting-url' }]);
    });
});

// Mock WebSocket for sendCdpCommandJs and evaluateJavascriptInPageJs tests
const mockWs = {
    send: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
    // Add other methods if needed, like close, readyState, etc.
};

describe('CDP Helper - sendCdpCommandJs', () => {
    let messageHandler;
    let errorHandler;
    let closeHandler;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers(); // Use real timers by default, switch to fake for timeout tests

        // Reset handlers by capturing them via ws.on
        mockWs.on.mockImplementation((event, handler) => {
            if (event === 'message') messageHandler = handler;
            if (event === 'error') errorHandler = handler;
            if (event === 'close') closeHandler = handler;
        });
    });

    afterEach(() => {
        messageHandler = null;
        errorHandler = null;
        closeHandler = null;
    });

    it('should send a command and resolve with the result on success', async () => {
        const commandMethod = 'Test.method';
        const commandParams = { foo: 'bar' };
        const expectedResult = { data: 'success' };
        // Capture the cdpMessageId for matching the response
        let cdpMessageIdForTest;

        mockWs.send.mockImplementation(payload => {
            const sentObject = JSON.parse(payload);
            cdpMessageIdForTest = sentObject.id; // Capture the ID used
        });

        const promise = sendCdpCommandJs(mockWs, commandMethod, commandParams);

        // Ensure send was called before simulating response
        expect(mockWs.send).toHaveBeenCalled();
        expect(JSON.parse(mockWs.send.mock.calls[0][0]).method).toBe(commandMethod);
        expect(JSON.parse(mockWs.send.mock.calls[0][0]).params).toEqual(commandParams);

        // Simulate receiving the correct response
        expect(messageHandler).toBeDefined();
        messageHandler(Buffer.from(JSON.stringify({ id: cdpMessageIdForTest, result: expectedResult })));

        await expect(promise).resolves.toEqual(expectedResult);
        expect(mockWs.removeListener).toHaveBeenCalledWith('message', expect.any(Function));
        expect(mockWs.removeListener).toHaveBeenCalledWith('error', expect.any(Function));
        expect(mockWs.removeListener).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should reject if CDP returns an error', async () => {
        const commandMethod = 'Test.errorMethod';
        const cdpError = { code: -32000, message: 'Something went wrong' };
        let cdpMessageIdForTest;
         mockWs.send.mockImplementation(payload => {
            cdpMessageIdForTest = JSON.parse(payload).id;
        });

        const promise = sendCdpCommandJs(mockWs, commandMethod);
        expect(mockWs.send).toHaveBeenCalled(); // Ensure send was called

        expect(messageHandler).toBeDefined();
        messageHandler(Buffer.from(JSON.stringify({ id: cdpMessageIdForTest, error: cdpError })));

        await expect(promise).rejects.toThrow(`CDP Error: ${cdpError.message} (Code: ${cdpError.code})`);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining('CDP Error'), cdpError);
        expect(mockWs.removeListener).toHaveBeenCalledTimes(3);
    });

    it('should reject on timeout', async () => {
        jest.useFakeTimers();
        const commandMethod = 'Test.timeoutMethod';
        const timeoutMs = 100; // Short timeout for testing

        const promise = sendCdpCommandJs(mockWs, commandMethod, {}, timeoutMs);
        expect(mockWs.send).toHaveBeenCalled(); // Ensure send was called

        // Advance timers to trigger timeout
        jest.advanceTimersByTime(timeoutMs + 1);

        await expect(promise).rejects.toThrow(`Timeout waiting for CDP response for ${commandMethod}`);
        expect(logError).toHaveBeenCalledWith(expect.stringContaining(`Timeout waiting for CDP response for method ${commandMethod}`));
        expect(mockWs.removeListener).toHaveBeenCalledTimes(3);
        jest.useRealTimers();
    });

    it('should reject if WebSocket emits an error', async () => {
        const commandMethod = 'Test.wsError';
        const wsError = new Error('WebSocket connection failed');

        const promise = sendCdpCommandJs(mockWs, commandMethod);
        expect(mockWs.send).toHaveBeenCalled(); // Ensure send was called

        expect(errorHandler).toBeDefined();
        errorHandler(wsError);

        await expect(promise).rejects.toThrow(`CDP WebSocket error: ${wsError.message}`);
        expect(logError).toHaveBeenCalledWith('Pocket Agent: CDP WebSocket error:', wsError);
        expect(mockWs.removeListener).toHaveBeenCalledTimes(3);
    });

    it('should reject if WebSocket closes unexpectedly', async () => {
        const commandMethod = 'Test.wsClose';
        const closeCode = 1006;
        const closeReason = 'Abnormal closure';

        const promise = sendCdpCommandJs(mockWs, commandMethod);
        expect(mockWs.send).toHaveBeenCalled(); // Ensure send was called

        expect(closeHandler).toBeDefined();
        closeHandler(closeCode, Buffer.from(closeReason)); // reason can be a Buffer

        await expect(promise).rejects.toThrow(`CDP WebSocket closed: ${closeCode} ${closeReason}`);
        expect(log).toHaveBeenCalledWith('Pocket Agent: CDP WebSocket closed unexpectedly:', closeCode, closeReason);
        expect(mockWs.removeListener).toHaveBeenCalledTimes(3);
    });

    it('should log error and not reject for unrelated parsing error in message handler', (done) => {
        const commandMethod = 'Test.parsingError';
        let cdpMessageIdForTest;
        mockWs.send.mockImplementation(payload => {
            cdpMessageIdForTest = JSON.parse(payload).id;
        });

        // We don't await the promise here as we're testing an intermediate state (error logging)
        // before the promise would normally resolve or reject due to its own timeout.
        const promise = sendCdpCommandJs(mockWs, commandMethod, {}, 50); // Short timeout

        expect(mockWs.send).toHaveBeenCalled();
        expect(messageHandler).toBeDefined();

        const malformedMessage = "this is not json";
        messageHandler(Buffer.from(malformedMessage));

        expect(logError).toHaveBeenCalledWith('Pocket Agent: Error parsing CDP message:', expect.any(Error), malformedMessage);

        // We expect the original promise to eventually time out, as the malformed message isn't its response.
        promise.catch(() => {
            // The test is that logError was called above, and the promise itself isn't resolved by bad msg.
            // It will reject due to timeout, which is fine.
            done();
        });

        jest.useFakeTimers();
        jest.advanceTimersByTime(51);
        jest.useRealTimers();
    });
});

describe('CDP Helper - evaluateJavascriptInPageJs', () => {
    // We will not mock sendCdpCommandJs directly here.
    // Instead, we'll control its behavior via mockWs, as evaluateJavascriptInPageJs
    // calls the actual sendCdpCommandJs, which is already tested with mockWs.

    let evalMessageHandler;
    let evalErrorHandler; // Can be reused if ws instance is the same
    let evalCloseHandler; // Can be reused if ws instance is the same

    // cdpMessageId is now internal to cdpHelper module. We need to anticipate its value
    // or make tests less dependent on the exact ID if possible.
    // For these tests, we'll assume cdpMessageId increments from where sendCdpCommandJs tests left off,
    // or better, make sendCdpCommandJs inside evaluateJavascriptInPageJs always see a fresh message handler setup.

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();

        // Reset mockWs for each evaluateJavascriptInPageJs test.
        // sendCdpCommandJs will attach new listeners to mockWs.
        mockWs.on.mockImplementation((event, handler) => {
            if (event === 'message') evalMessageHandler = handler;
            // error and close handlers might be set by sendCdpCommandJs
        });
        mockWs.send.mockImplementation(payload => {
            // The ID is generated by sendCdpCommandJs. We need to capture it
            // if we want to send a response with the same ID.
            // This is implicitly handled if sendCdpCommandJs uses its internal cdpMessageId
        });
    });

    it('should call Runtime.evaluate and return the value on success', async () => {
        const expression = '1 + 1';
        const expectedValue = 2;

        // Configure mockWs.send to capture the ID used by sendCdpCommandJs
        let cdpIdForEval;
        mockWs.send.mockImplementationOnce(payload => {
            const sentObject = JSON.parse(payload);
            expect(sentObject.method).toBe('Runtime.evaluate');
            expect(sentObject.params.expression).toBe(expression);
            cdpIdForEval = sentObject.id;

            // Simulate async response after send
            process.nextTick(() => {
                if (evalMessageHandler) {
                    evalMessageHandler(Buffer.from(JSON.stringify({ id: cdpIdForEval, result: { result: { value: expectedValue } } })));
                }
            });
        });

        const result = await evaluateJavascriptInPageJs(mockWs, expression);
        expect(result).toBe(expectedValue);
        expect(mockWs.send).toHaveBeenCalledTimes(1);
    });

    it('should throw an error if Runtime.evaluate returns exceptionDetails', async () => {
        const expression = 'throw new Error("test error")';
        const exceptionDetails = {
            text: 'Uncaught Error: test error',
            exception: { description: 'Error: test error' }
        };

        let cdpIdForEval;
        mockWs.send.mockImplementationOnce(payload => {
            cdpIdForEval = JSON.parse(payload).id;
            process.nextTick(() => {
                if (evalMessageHandler) {
                     evalMessageHandler(Buffer.from(JSON.stringify({ id: cdpIdForEval, result: { exceptionDetails } })));
                }
            });
        });

        await expect(evaluateJavascriptInPageJs(mockWs, expression)).rejects.toThrow('JavaScript execution error: Error: test error');
        expect(logError).toHaveBeenCalledWith('Pocket Agent: JavaScript execution error in CDP:', 'Error: test error', exceptionDetails);
        expect(mockWs.send).toHaveBeenCalledTimes(1);
    });

    it('should use exceptionDetails.text if description is missing', async () => {
        const expression = 'throw "just a string"';
        const exceptionDetails = { text: 'Uncaught just a string' };
        let cdpIdForEval;
        mockWs.send.mockImplementationOnce(payload => {
            cdpIdForEval = JSON.parse(payload).id;
            process.nextTick(() => {
                if (evalMessageHandler) {
                    evalMessageHandler(Buffer.from(JSON.stringify({ id: cdpIdForEval, result: { exceptionDetails } })));
                }
            });
        });

        await expect(evaluateJavascriptInPageJs(mockWs, expression)).rejects.toThrow('JavaScript execution error: Uncaught just a string');
        expect(logError).toHaveBeenCalledWith('Pocket Agent: JavaScript execution error in CDP:', 'Uncaught just a string', exceptionDetails);
    });

    it('should use generic message if exception text and description are missing', async () => {
        const expression = 'throw {}'; // Throwing an empty object
        const exceptionDetails = { someOtherProp: 'details' }; // No text or exception.description
        let cdpIdForEval;
        mockWs.send.mockImplementationOnce(payload => {
            cdpIdForEval = JSON.parse(payload).id;
            process.nextTick(() => {
                if (evalMessageHandler) {
                    evalMessageHandler(Buffer.from(JSON.stringify({ id: cdpIdForEval, result: { exceptionDetails } })));
                }
            });
        });

        await expect(evaluateJavascriptInPageJs(mockWs, expression)).rejects.toThrow('JavaScript execution error: Unknown JavaScript execution error');
        expect(logError).toHaveBeenCalledWith('Pocket Agent: JavaScript execution error in CDP:', 'Unknown JavaScript execution error', exceptionDetails);
    });

    it('should re-throw error if sendCdpCommandJs fails (e.g. due to WebSocket error)', async () => {
        const expression = '1 + 1';
        const cdpError = new Error('Internal CDP command failed via WS error');

        // Simulate sendCdpCommandJs failing by having the ws emit an error
        mockWs.send.mockImplementationOnce(payload => {
            // Simulate that after send, the websocket connection errors out
            process.nextTick(() => {
                let boundErrorHandler;
                // Find the error handler sendCdpCommandJs attached
                const errorCall = mockWs.on.mock.calls.find(call => call[0] === 'error');
                if (errorCall) boundErrorHandler = errorCall[1];

                if (boundErrorHandler) {
                    boundErrorHandler(cdpError);
                }
            });
        });

        await expect(evaluateJavascriptInPageJs(mockWs, expression)).rejects.toThrow(cdpError.message);
        // This log comes from sendCdpCommandJs
        expect(logError).toHaveBeenCalledWith('Pocket Agent: CDP WebSocket error:', cdpError);
        // This log comes from evaluateJavascriptInPageJs itself
        expect(logError).toHaveBeenCalledWith('Pocket Agent: Error during evaluateJavascriptInPageJs:', expect.objectContaining({ message: `CDP WebSocket error: ${cdpError.message}` }));
    });
});
