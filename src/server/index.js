const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Configure CORS
const corsOptions = {
    origin: '*', // Allow all origins for simplicity in development. Restrict in production.
    methods: ['GET', 'POST'],
};
app.use(cors(corsOptions));

const io = new Server(server, {
    cors: corsOptions,
});

// Increase the payload limit for JSON requests
// The default is 100kb, which can be too small for rich HTML content.
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../client')));
// Also serve static files from project root for CSS access
app.use(express.static(path.join(__dirname, '../../')));

// In-memory store for the latest chat HTML - CHANGED
let activeConversationsStore = []; // Now: [{ id: String, name: String, html: String, source: String, timestamp: String }]

// Endpoint for VS Code extension to post chat HTML
app.post('/chat-update', (req, res) => {
    const { conversations, source, timestamp } = req.body;

    if (Array.isArray(conversations) && conversations.every(c => typeof c.html === 'string' && typeof c.name === 'string')) {
        // New primary logic: Expects conversations array with {html, name, id?}
        activeConversationsStore = conversations.map((conv, index) => ({
            id: conv.id || `conv-${Date.now()}-${index}`, // Use provided id, or generate a unique one
            name: conv.name || `Chat ${index + 1}`,
            html: conv.html,
            source: source || 'vscode-extension',
            timestamp: timestamp || new Date().toISOString()
        }));
        console.log(`[Server] Received ${conversations.length} conversation(s) from ${source || 'unknown'} at ${timestamp || 'N/A'}.`);
        activeConversationsStore.forEach(conv => {
            console.log(`  - Tab Name: '${conv.name}', ID: ${conv.id}, HTML size: ${conv.html.length} bytes`);
        });
        // Emit only id and name for the tab structure update
        io.emit('conversationsUpdated', activeConversationsStore.map(c => ({id: c.id, name: c.name})));
        res.status(200).send({ message: "Conversations processed successfully." });

    } else if (req.body.htmlContents && Array.isArray(req.body.htmlContents)) { // Backward compatibility for htmlContents (array of strings)
        activeConversationsStore = req.body.htmlContents.map((html, index) => ({
            id: `conv-legacy-${Date.now()}-${index}`, // Ensure unique IDs for legacy
            name: `Chat ${index + 1}`, // Default naming
            html: html,
            source: source || 'vscode-extension',
            timestamp: timestamp || new Date().toISOString()
        }));
        console.log(`[Server] Received ${req.body.htmlContents.length} chat HTML update(s) via htmlContents (legacy) from ${source || 'unknown'} at ${timestamp || 'N/A'}.`);
        io.emit('conversationsUpdated', activeConversationsStore.map(c => ({id: c.id, name: c.name})));
        res.status(200).send({ message: "Chat HTML updates (legacy format) processed successfully." });

    } else if (typeof req.body.htmlContent === 'string') { // Backward compatibility for single htmlContent (string)
        activeConversationsStore = [{
            id: `conv-single-legacy-${Date.now()}`, // Ensure unique ID for legacy
            name: 'Chat 1', // Default naming
            html: req.body.htmlContent,
            source: source || 'vscode-extension',
            timestamp: timestamp || new Date().toISOString()
        }];
        console.log(`[Server] Received single chat HTML update (legacy) from ${source || 'unknown'} at ${timestamp || 'N/A'}. Size: ${req.body.htmlContent.length} bytes.`);
        io.emit('conversationsUpdated', activeConversationsStore.map(c => ({id: c.id, name: c.name})));
        res.status(200).send({ message: "Single chat HTML (legacy format) updated successfully." });
    } else {
        console.log("[Server] Received invalid chat update. Payload structure not recognized:", req.body);
        res.status(400).send({ message: "Invalid payload. Expected 'conversations' array of {html, name, id} objects, or legacy formats." });
    }
});

// Endpoint to serve the page that will display the chat content - CHANGED
app.get('/view-chat', (req, res) => {
    const conversationTabsData = activeConversationsStore.map(c => ({ id: c.id, name: c.name }));
    const scriptData = `let initialConversations = ${JSON.stringify(conversationTabsData)};`;

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>View Cursor Chat - Tabbed</title>
            <style>
                body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; font-family: sans-serif; display: flex; flex-direction: column; background-color: #2c2c2c; color: #d4d4d4; }
                .header { padding: 10px; background-color: #3c3c3c; border-bottom: 1px solid #555; text-align: center; flex-shrink: 0; }
                .header h1 { margin: 0; font-size: 1.2em;}
                .header p { margin: 5px 0 0; font-size: 0.9em; color: #aaa;}
                .tab-bar { display: flex; background-color: #333; padding: 0px 5px; flex-shrink: 0; overflow-x: auto; border-bottom: 1px solid #444;}
                .tab-button { padding: 10px 15px; cursor: pointer; border: none; background-color: transparent; color: #ccc; border-bottom: 3px solid transparent; font-size: 0.9em; white-space: nowrap; }
                .tab-button.active { color: #fff; border-bottom: 3px solid #007acc; }
                .tab-button:hover { background-color: #444; }
                .tab-content { flex-grow: 1; position: relative; background-color: var(--vscode-editor-background, #1e1e1e); }
                .tab-pane { width: 100%; height: 100%; border: none; display: none; }
                .tab-pane.active { display: block; }
                .status-message { padding: 20px; text-align: center; font-style: italic; color: #888; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>Cursor Chat Viewer</h1>
                <p>Live conversations from VS Code Cursor AI</p>
            </div>
            <div class="tab-bar" id="tabBar">
                <!-- Tabs will be dynamically inserted here -->
            </div>
            <div class="tab-content" id="tabContent">
                <!-- Iframes will be dynamically inserted here -->
            </div>

            <script src="/socket.io/socket.io.js"></script>
            <script>
                ${scriptData}

                const tabBar = document.getElementById('tabBar');
                const tabContent = document.getElementById('tabContent');
                let currentConversations = initialConversations;
                let activeTabId = null;

                function renderTabs(conversationsToRender) {
                    const previouslyActiveTabId = activeTabId;
                    tabBar.innerHTML = '';
                    tabContent.innerHTML = ''; // Clear old iframes

                    if (!conversationsToRender || conversationsToRender.length === 0) {
                        tabBar.innerHTML = '<div class="status-message">No conversations available. Waiting for updates...</div>';
                        activeTabId = null;
                        return;
                    }

                    conversationsToRender.forEach((conv) => {
                        const tabButton = document.createElement('button');
                        tabButton.className = 'tab-button';
                        tabButton.textContent = conv.name || \`Chat \${conv.id.split('-')[1]}\`;
                        tabButton.dataset.id = conv.id;
                        tabButton.onclick = () => openTab(conv.id);
                        tabBar.appendChild(tabButton);

                        const iframe = document.createElement('iframe');
                        iframe.id = \`iframe-\${conv.id}\`;
                        iframe.className = 'tab-pane';
                        iframe.sandbox = "allow-same-origin allow-scripts";
                        iframe.title = \`Cursor Chat Content - \${conv.name}\`;
                        tabContent.appendChild(iframe);
                    });

                    if (conversationsToRender.length > 0) {
                        let newActiveTabId = conversationsToRender[0].id;
                        // Try to preserve active tab if it still exists
                        if (previouslyActiveTabId && conversationsToRender.some(c => c.id === previouslyActiveTabId)) {
                            newActiveTabId = previouslyActiveTabId;
                        }
                        openTab(newActiveTabId);
                    } else {
                        activeTabId = null;
                    }
                }

                function openTab(conversationId) {
                    activeTabId = conversationId;
                    document.querySelectorAll('.tab-button').forEach(button => {
                        button.classList.toggle('active', button.dataset.id === conversationId);
                    });
                    document.querySelectorAll('.tab-pane').forEach(pane => {
                        const isActive = pane.id === \`iframe-\${conversationId}\`;
                        pane.classList.toggle('active', isActive);
                        if (isActive && !pane.src) { // Load content only if not already loaded and tab is active
                            pane.src = \`/get-chat-html?id=\${conversationId}\`;
                        }
                    });
                }

                document.addEventListener('DOMContentLoaded', () => {
                    renderTabs(currentConversations);

                    const socket = io();
                    socket.on('conversationsUpdated', (updatedConversations) => {
                        console.log('Received conversationsUpdated event:', updatedConversations);
                        currentConversations = updatedConversations;
                        renderTabs(currentConversations);
                    });
                });
            </script>
        </body>
        </html>
    `);
});

// Endpoint that the iframe will use to fetch the actual chat HTML - CHANGED
app.get('/get-chat-html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const conversationId = req.query.id;
    const conversation = activeConversationsStore.find(c => c.id === conversationId);

    if (!conversation) {
        res.status(404).send("<p>Conversation not found.</p>");
        return;
    }

    // Link to the external pocket-chat.css file and add scroll-enabling styles
    const styles = `
        <link href="/pocket-chat.css" rel="stylesheet" type="text/css">
        <style>
            html, body {
                height: 100%;
                margin: 0;
                padding: 0;
                overflow: hidden; /* Prevent scrolling on html/body themselves */
            }
            body {
                display: flex; /* Use flexbox */
                flex-direction: column; /* Stack children vertically */
                box-sizing: border-box;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "HelveticaNeue-Light", system-ui, "Ubuntu", "Droid Sans", sans-serif;
                background-color: var(--vscode-editor-background, #1e1e1e);
                color: var(--vscode-editor-foreground, #d4d4d4);
                /* Padding is now applied to .scroll-wrapper */
            }
            .scroll-wrapper {
                flex-grow: 1; /* Takes up all available vertical space in the flex container (body) */
                overflow-y: auto; /* Enables vertical scrolling ONLY for this wrapper */
                padding: 10px; /* Apply padding here so content isn't against edges */
                box-sizing: border-box;
            }
            /* Hide-if-empty utility can be applied to elements within the chat if needed */
            .hide-if-empty:empty {
                display: none;
            }

            /* Custom WebKit scrollbar styling for better visibility */
            .scroll-wrapper::-webkit-scrollbar {
                width: 10px; /* Width of the vertical scrollbar */
            }
            .scroll-wrapper::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.1); /* Color of the tracking area */
                border-radius: 5px;
            }
            .scroll-wrapper::-webkit-scrollbar-thumb {
                background-color: rgba(255, 255, 255, 0.3); /* Color of the scroll thumb */
                border-radius: 5px;
                border: 2px solid transparent; /* Creates padding around thumb */
                background-clip: content-box;
            }
            .scroll-wrapper::-webkit-scrollbar-thumb:hover {
                background-color: rgba(255, 255, 255, 0.5);
            }
            /* Message input area styles */
            .message-input-area {
                padding: 10px;
                background-color: var(--vscode-panel-background, #252526); /* Matches typical VS Code panel backgrounds */
                border-top: 1px solid var(--vscode-panel-border, #303030);
                display: flex; /* For aligning textarea and button */
                gap: 10px; /* Space between textarea and button */
                flex-shrink: 0; /* Prevent this area from shrinking */
            }
            .message-input-area textarea {
                flex-grow: 1; /* Textarea takes available space */
                padding: 8px;
                border-radius: 4px;
                border: 1px solid var(--vscode-input-border, #3c3c3c);
                background-color: var(--vscode-input-background, #3c3c3c);
                color: var(--vscode-input-foreground, #cccccc);
                font-family: inherit;
                resize: none; /* Users shouldn't resize it manually */
                min-height: 20px; /* Start fairly small */
                max-height: 120px; /* Max height before scrolling */
                overflow-y: auto; /* Enable scrolling if content exceeds max-height */
                box-sizing: border-box;
            }
            .message-input-area button {
                padding: 8px 15px;
                border-radius: 4px;
                border: none;
                background-color: var(--vscode-button-background, #0e639c);
                color: var(--vscode-button-foreground, #ffffff);
                cursor: pointer;
                font-weight: bold;
                white-space: nowrap; /* Prevent button text from wrapping */
            }
            .message-input-area button:hover {
                background-color: var(--vscode-button-hoverBackground, #1177bb);
            }
        </style>
    `;

    // The actual chat HTML from the stored conversation
    const chatBodyHtml = conversation.html || '<p style="padding:10px; font-style:italic; color:#777;">No chat content available for this conversation.</p>';

    const fullHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chat Content - ${conversation.name}</title>
            ${styles}
        </head>
        <body>
            <div class="scroll-wrapper">
                ${chatBodyHtml}
            </div>
            <div class="message-input-area">
                <textarea id="messageTextarea" placeholder="Type a message to send to Cursor..." rows="1"></textarea>
                <button id="sendMessageButton">Send</button>
            </div>
            <script>
                document.addEventListener('DOMContentLoaded', () => {
                    const messageTextarea = document.getElementById('messageTextarea');
                    const sendMessageButton = document.getElementById('sendMessageButton');
                    const windowId = '${conversation.id}'; // Directly embed windowId for this specific iframe

                    // Auto-resize textarea functionality
                    function autoResizeTextarea(textarea) {
                        textarea.style.height = 'auto'; // Temporarily shrink to get correct scrollHeight
                        let newHeight = textarea.scrollHeight;
                        const maxHeight = 120; // Must match max-height in CSS
                        if (newHeight > maxHeight) {
                            newHeight = maxHeight;
                        }
                        textarea.style.height = newHeight + 'px';
                    }

                    messageTextarea.addEventListener('input', function() {
                        autoResizeTextarea(this);
                    });
                    autoResizeTextarea(messageTextarea); // Initial resize

                    const submitMessage = async () => {
                        const message = messageTextarea.value.trim();
                        if (!message) return; // Don't send empty messages

                        if (!windowId) {
                            console.error('Pocket Agent Client (iframe): windowId is missing for this chat.');
                            // Potentially show an error to the user in the iframe
                            return;
                        }

                        try {
                            sendMessageButton.disabled = true; // Prevent multiple submissions
                            sendMessageButton.textContent = 'Sending...';

                            const response = await fetch('/send-to-cursor', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({ windowId: windowId, messageText: message })
                            });

                            if (response.ok) {
                                messageTextarea.value = ''; // Clear textarea
                                autoResizeTextarea(messageTextarea); // Resize after clearing
                                // console.log('Pocket Agent Client (iframe): Message sent successfully.');
                            } else {
                                const errorData = await response.json();
                                console.error('Pocket Agent Client (iframe): Error sending message - ', errorData.message);
                                // Potentially show an error to the user in the iframe
                            }
                        } catch (error) {
                            console.error('Pocket Agent Client (iframe): Network error sending message:', error);
                            // Potentially show an error to the user in the iframe
                        } finally {
                            sendMessageButton.disabled = false;
                            sendMessageButton.textContent = 'Send';
                        }
                    };

                    sendMessageButton.addEventListener('click', submitMessage);

                    messageTextarea.addEventListener('keypress', (event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault(); // Prevent default Enter behavior (newline)
                            submitMessage();
                        }
                    });

                    // Focus the textarea when the iframe loads (optional, can be annoying)
                    // messageTextarea.focus();
                });
            </script>
        </body>
        </html>
    `;
    res.send(fullHtml);
});

// New endpoint to receive messages from the web view and emit to VS Code extension
app.post('/send-to-cursor', express.json(), (req, res) => {
    const { windowId, messageText } = req.body;

    if (!windowId || typeof windowId !== 'string' || !messageText || typeof messageText !== 'string') {
        console.error('[Server] Invalid /send-to-cursor payload:', req.body);
        return res.status(400).json({ message: 'Invalid payload. windowId and messageText are required and must be strings.' });
    }

    console.log(`[Server] Received message for windowId '${windowId}': "${messageText.substring(0, 100)}..."`);

    // Emit to all connected Socket.IO clients (the VSCode extension should pick this up)
    io.emit('sendMessageToWindow', { windowId, messageText });

    res.status(200).json({ message: 'Message queued to be sent to Cursor window.' });
});

// Store active connections
let activeConnections = {
  desktop: null,
  mobile: null
};

io.on('connection', (socket) => {
  console.log(`[Server] Client connected: ${socket.id}`);

  socket.on('register', (type) => {
    if (type === 'desktop' || type === 'mobile') {
      activeConnections[type] = socket.id;
      console.log(`${type} client registered`);
    }
  });

  // Handle composer questions/requests
  socket.on('composer_request', (data) => {
    if (activeConnections.mobile) {
      io.to(activeConnections.mobile).emit('composer_request', data);
    }
  });

  // Handle mobile responses
  socket.on('mobile_response', (data) => {
    if (activeConnections.desktop) {
      io.to(activeConnections.desktop).emit('mobile_response', data);
    }
  });

  socket.on('chatUpdate', (messages) => {
    console.log(`[Server] Received 'chatUpdate' from client ${socket.id} with ${messages.length} messages.`);
    if (messages && messages.length > 0) {
      console.log('[Server] Message data:');
      messages.forEach((msg, index) => {
        console.log(`  Message ${index + 1}:`);
        console.log(`    Sender: ${msg.sender}`);
        console.log(`    Content: "${msg.content.replace(/\n/g, '\\\\n')}"`); // Escape newlines for cleaner logging
        console.log(`    Timestamp: ${new Date(msg.timestamp).toLocaleString()}`);
      });
    } else {
      console.log('[Server] chatUpdate event received, but no messages or empty array.');
    }
    // Here, you could further process messages, e.g., store them, broadcast to other clients, etc.
  });

  socket.on('disconnect', (reason) => {
    // Remove disconnected client
    Object.keys(activeConnections).forEach(key => {
      if (activeConnections[key] === socket.id) {
        activeConnections[key] = null;
      }
    });
    console.log(`[Server] Client disconnected: ${socket.id}. Reason: ${reason}`);
  });

  socket.on('connect_error', (err) => {
    console.error(`[Server] Client connection error for ${socket.id}: ${err.message}`);
  });
});

const PORT = process.env.PORT || 3300;
server.listen(PORT, () => {
  console.log(`[Server] Pocket Agent server listening on port ${PORT}`);
});
