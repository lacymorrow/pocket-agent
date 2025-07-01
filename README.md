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

2. (Optional) Build the VS Code extension package
```bash
npm run package
```

The command above creates a `cursor-pocket-agent-x.y.z.vsix` file that you can share or publish to the VS Code Marketplace.

## Configuration

The extension exposes the following user/workspace settings (they can be accessed from **Settings → Extensions → Pocket Agent** or by editing `settings.json`).

| Setting | Default | Description |
|---------|---------|-------------|
| `pocketAgent.serverUrl` | `http://localhost:3300` | URL of the Pocket Agent backend server that receives chat updates. |
| `pocketAgent.pollInterval` | `5000` | Interval (in ms) at which chat updates are collected and sent to the backend. |
| `pocketAgent.cursorDebugPort` | `9223` | Remote-debugging port used when launching Cursor (`--remote-debugging-port`). |

Changes to these settings are applied instantly—no need to reload VS Code.

---

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
