const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
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

// ------------------------------------------------------------------
// Basic rate limiting to protect /chat-update and other write routes
// ------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1 minute default
  max: parseInt(process.env.RATE_LIMIT_MAX || '60', 10), // limit each IP to 60 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(['/chat-update'], apiLimiter);

app.use(express.static(path.join(__dirname, '../client')));
// Also serve static files from project root for CSS access
app.use(express.static(path.join(__dirname, '../../')));

// In-memory store for the latest chat HTML
let latestChatHtml = "<p>No chat content received yet.</p>";

// Endpoint for VS Code extension to post chat HTML
app.post('/chat-update', (req, res) => {
    const { htmlContent, source, timestamp } = req.body;
    if (typeof htmlContent === 'string') {
        latestChatHtml = htmlContent;
        console.log(`[Server] Received chat HTML update from ${source} at ${timestamp}. Size: ${htmlContent.length} bytes.`);
        res.status(200).send({ message: "Chat HTML updated successfully." });
    } else {
        console.log("[Server] Received invalid chat update (htmlContent not a string):", req.body);
        res.status(400).send({ message: "Invalid payload. htmlContent must be a string." });
    }
});

// Endpoint to serve the page that will display the chat content
app.get('/view-chat', (req, res) => {
    // Serve a simple HTML page with an iframe
    // The iframe will point to /get-chat-html to load the content safely
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>View Cursor Chat</title>
            <style>
                body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; font-family: sans-serif; }
                iframe { width: 100%; height: 100%; border: none; }
                .header { padding: 10px; background-color: #f0f0f0; border-bottom: 1px solid #ccc; text-align: center; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>Cursor Chat Viewer</h1>
                <p>Content below is captured from the VS Code Cursor AI chat panel.</p>
            </div>
            <iframe
                src="/get-chat-html"
                sandbox="allow-same-origin allow-scripts"
                title="Cursor Chat Content">
            </iframe>
        </body>
        </html>
    `);
});

// Endpoint that the iframe will use to fetch the actual chat HTML
app.get('/get-chat-html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');

    // Link to the external pocket-chat.css file instead of inline styles
    const styles = `
        <link href="/pocket-chat.css" rel="stylesheet" type="text/css">
        <style>
            html, body {
                height: 100%;
                margin: 0;
                padding: 0;
                overflow: hidden;
            }
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "HelveticaNeue-Light", system-ui, "Ubuntu", "Droid Sans", sans-serif;
                background-color: var(--vscode-editor-background, #1e1e1e);
                color: var(--vscode-editor-foreground, #d4d4d4);
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
            }

            /* Hide-if-empty utility */
            .hide-if-empty:empty {
                display: none;
            }
        </style>
    `;
    res.send(styles + latestChatHtml);
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
        console.log(`    Content: "${msg.content.replace(/\n/g, '\\n')}"`);
        console.log(`    Timestamp: ${new Date(msg.timestamp).toLocaleString()}`);
      });
    } else {
      console.log('[Server] chatUpdate event received, but no messages or empty array.');
    }
  });

  socket.on('disconnect', (reason) => {
    Object.keys(activeConnections).forEach((key) => {
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