# Pocket Agent for Cursor

A mobile interface for interacting with Cursor's composer remotely. This allows you to receive notifications and respond to composer requests from your mobile device.

## Features

- Real-time communication between Cursor and your mobile device
- Mobile-friendly web interface
- Push notifications for new composer requests
- Request history tracking
- Approve/reject composer requests remotely

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Access the mobile interface:
   - Open `http://YOUR_COMPUTER_IP:3300` on your mobile device
   - Replace `YOUR_COMPUTER_IP` with your computer's local IP address
   - Make sure your mobile device is on the same network as your computer

4. Integration with Cursor:
   - The desktop client (`src/client/desktop.js`) provides the interface to connect with Cursor
   - Import and use the `sendComposerRequest` function to forward composer requests to mobile

## Security Note

This is intended for local network use only. If you need to access it from outside your local network, please implement appropriate security measures like authentication and HTTPS.

## Development

For development with auto-reload:
```bash
npm run dev
``` 
