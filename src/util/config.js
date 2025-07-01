const { URL } = require('url');

/**
 * Validate and sanitize Pocket Agent configuration values.
 * @param {{serverUrl:string,pollInterval:number,cursorDebugPort:number}} cfg
 * @returns {{errors:string[], validated: {serverUrl?:string,pollInterval?:number,cursorDebugPort?:number}}}
 */
function validateConfig(cfg) {
    const errors = [];
    const validated = {};

    // Validate serverUrl
    try {
        const url = new URL(cfg.serverUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('Protocol must be http or https');
        }
        validated.serverUrl = url.toString().replace(/\/$/, ''); // remove trailing slash
    } catch (e) {
        errors.push(`Invalid serverUrl "${cfg.serverUrl}": ${e.message}`);
    }

    // Validate pollInterval (>=1000)
    if (typeof cfg.pollInterval !== 'number' || !Number.isFinite(cfg.pollInterval) || cfg.pollInterval < 1000) {
        errors.push('pollInterval must be a number (>= 1000 ms).');
    } else {
        validated.pollInterval = cfg.pollInterval;
    }

    // Validate cursorDebugPort (1..65535)
    if (!Number.isInteger(cfg.cursorDebugPort) || cfg.cursorDebugPort < 1 || cfg.cursorDebugPort > 65535) {
        errors.push('cursorDebugPort must be an integer between 1 and 65535.');
    } else {
        validated.cursorDebugPort = cfg.cursorDebugPort;
    }

    return { errors, validated };
}

module.exports = { validateConfig };