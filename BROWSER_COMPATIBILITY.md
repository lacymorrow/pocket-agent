# Browser Compatibility

The Pocket-Agent web UI (`src/client`) is built with vanilla JS + Socket.IO and is designed to work on modern evergreen browsers.

| Browser | Minimum Version | Tested On |
|---------|-----------------|-----------|
| Chrome  |  106            | ✔️  Mac / Windows / Android |
| Edge    |  106            | ✔️  Windows |
| Firefox |  102 ESR        | ✔️  Mac / Windows |
| Safari  |  16             | ✔️  macOS / iOS |
| Mobile Chrome | 106       | ✔️  Android |
| Mobile Safari | 16        | ✔️  iOS |

### Known Limitations
* Legacy browsers (IE 11, old Android WebView) are **not supported**.
* Notifications require user permission; on iOS < 16.4 web push isn't supported.

### Testing Matrix
We use **BrowserStack** for cross-browser checks. A GitHub Action job `browser-tests` is available but disabled by default – enable it when you connect your BrowserStack credentials.