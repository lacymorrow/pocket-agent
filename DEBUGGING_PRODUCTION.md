# Production Debugging Guide

This guide outlines tools & techniques to diagnose issues in a live Pocket-Agent deployment.

## 1. Quick Checklist
1. `kubectl logs` / `docker logs` – check container logs.  
2. `/health` endpoint – verify server is running.  
3. Grafana dashboard – inspect CPU / memory / latency panels.  
4. Sentry – look for recent uncaught exceptions (if enabled).  
5. Cloud provider status – ensure no regional outages.

## 2. Enabling Verbose Logs
Set environment variable `POCKET_AGENT_LOG_LEVEL=debug` and restart the pod/container. This enables extra CDP, WebSocket & rate-limit logs.

## 3. Remote Debugging VS Code Extension
1. Open the extension code in VS Code.  
2. Run the **Launch Extension (Production Attach)** debug config – it attaches to the running instance via port `9229` (make sure it's exposed).  
3. Set breakpoints in `src/cursor-plugin.js`.

## 4. Profiling Performance
* Use the built-in **Perf** logs emitted by `util/perf.js`.  
* For deeper insight, attach Node's inspector: `node --inspect=0.0.0.0:9230 src/server/index.js` and use Chrome DevTools.

## 5. Common Issues
| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| 429 Too Many Requests | Hitting rate-limit | Increase `RATE_LIMIT_MAX` or investigate client spam |
| Chat not updating | Cursor debugging port not exposed | Start Cursor with `--remote-debugging-port=9223` |
| Mobile UI blank | `/get-chat-html` returns empty | Check that `latestChatHtml` is updated (look at server logs) |

## 6. Escalation
If you cannot resolve the issue:
1. Tag the on-call engineer in Slack `#pocket-agent-alerts`.  
2. Create a ticket with *severity* and all gathered evidence.  
3. If security-related, follow the [Security Policy](SECURITY.md).