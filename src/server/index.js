const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
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

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

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
