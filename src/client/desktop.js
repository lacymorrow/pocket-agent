const io = require('socket.io-client');

// Create socket connection
let socket;
let isConnected = false;

function initSocket() {
    if (!socket) {
        socket = io('http://localhost:3000');
        console.log('[Pocket Agent] Initializing socket connection...');

        // Register as desktop client
        socket.on('connect', () => {
            console.log('[Pocket Agent] Connected to server');
            isConnected = true;
            socket.emit('register', 'desktop');
        });

        socket.on('disconnect', () => {
            console.log('[Pocket Agent] Disconnected from server');
            isConnected = false;
        });

        // Handle responses from mobile client
        socket.on('mobile_response', (data) => {
            console.log('[Pocket Agent] Received response:', data);
            const requestCallback = pendingRequests.get(data.timestamp);
            if (requestCallback) {
                requestCallback(data.approved);
                pendingRequests.delete(data.timestamp);
            }
        });
    }
    return socket;
}

// Track pending requests to match responses
const pendingRequests = new Map();

// Function to send composer requests to mobile
function sendComposerRequest(message) {
    console.log('[Pocket Agent] Sending request:', message);
    return new Promise((resolve) => {
        const timestamp = Date.now();
        pendingRequests.set(timestamp, resolve);

        const socket = initSocket();
        socket.emit('composer_request', {
            ...message,
            timestamp
        });
    });
}

// Export for use in Cursor integration
module.exports = {
    sendComposerRequest,
    initSocket
};

// Make it globally available for the composer
if (typeof global !== 'undefined') {
    global.pocketAgent = {
        requestApproval: sendComposerRequest
    };
}
