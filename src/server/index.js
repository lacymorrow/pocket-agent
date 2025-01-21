const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// Store active connections
let activeConnections = {
  desktop: null,
  mobile: null
};

io.on('connection', (socket) => {
  console.log('New client connected');

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

  socket.on('disconnect', () => {
    // Remove disconnected client
    Object.keys(activeConnections).forEach(key => {
      if (activeConnections[key] === socket.id) {
        activeConnections[key] = null;
      }
    });
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
