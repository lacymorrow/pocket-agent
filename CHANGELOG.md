# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-07-01
### Added
- VS Code configuration schema (`serverUrl`, `pollInterval`, `cursorDebugPort`).
- Runtime validation of configuration values with clear warnings.
- Hot-reload of configuration without requiring extension reload.
- New utility module `src/util/config.js`.
- Basic unit tests (Mocha + Chai) and `npm test` script.
- Logging levels (`log`, `logWarn`, `logError`) for clearer diagnostics.
- Security documentation (`SECURITY.md`) and MIT `LICENSE`.
- This CHANGELOG.

### Changed
- Constants moved to mutable values that respect both environment variables and user/workspace settings.
- Improved error handling around network operations (`fetch`, WebSocket).

## [1.0.0] - 2025-06-30
### Added
- Initial release with chat HTML polling and mobile viewer.