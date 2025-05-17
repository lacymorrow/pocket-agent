const vscode = require('vscode');

let pocketAgentOutputChannel = null;

/**
 * Initializes the logger with a VS Code OutputChannel.
 * @param {vscode.OutputChannel} channel - The channel to use for logging.
 */
function initializeLogger(channel) {
  if (channel) {
    pocketAgentOutputChannel = channel;
  } else {
    // This case is mainly for testing or if initialization somehow fails
    // The actual creation of the channel happens in activate() in cursor-plugin.js
    pocketAgentOutputChannel = null;
  }
}

/**
 * Returns the current logger instance (OutputChannel).
 * @returns {vscode.OutputChannel | null}
 */
function getLogger() {
    return pocketAgentOutputChannel;
}

/**
 * Logs a message to the Pocket Agent output channel and the console.
 * @param {string} message - The message to log.
 * @param  {...any} optionalParams - Additional parameters to log.
 */
const log = (message, ...optionalParams) => {
  const fullMessage = optionalParams.length > 0 ? `${message} ${optionalParams.join(' ')}` : message;
  console.log(fullMessage);
  if (pocketAgentOutputChannel) {
    pocketAgentOutputChannel.appendLine(fullMessage);
  } else {
    console.warn('Pocket Agent: pocketAgentOutputChannel not (yet) ready for log:', fullMessage);
  }
};

/**
 * Logs an error message to the Pocket Agent output channel and the console.
 * @param {string} message - The error message.
 * @param {Error | string | object} [error] - Optional error object or details.
 */
const logError = (message, error) => {
  let fullMessage = `ERROR: ${message}`;
  let consoleErrorMessage = message; // For console.error, keep it cleaner initially

  if (error) {
    if (error instanceof Error && error.message) {
      fullMessage += ` Details: ${error.message}`;
    } else if (typeof error === 'string') {
      fullMessage += ` Details: ${error}`;
    } else {
      try {
        // Attempt to stringify, but be cautious with complex objects
        const errorStr = JSON.stringify(error);
        fullMessage += ` Details: ${errorStr}`;
      } catch (e) {
        fullMessage += ' Details: (Unserializable error object)';
      }
    }
    console.error(consoleErrorMessage, error); // Log original message and error object to console
  } else {
    console.error(fullMessage, undefined); // Match test expectation for console call
  }

  if (pocketAgentOutputChannel) {
    pocketAgentOutputChannel.appendLine(fullMessage);
  } else {
    console.warn('Pocket Agent: pocketAgentOutputChannel not (yet) ready for logError:', fullMessage);
  }
};

/**
 * Logs a warning message to the Pocket Agent output channel and the console.
 * @param {string} message - The warning message.
 * @param  {...any} optionalParams - Additional parameters to log.
 */
const logWarn = (message, ...optionalParams) => {
  const fullMessage = `WARN: ${optionalParams.length > 0 ? `${message} ${optionalParams.join(' ')}` : message}`;
  console.warn(fullMessage);
  if (pocketAgentOutputChannel) {
    pocketAgentOutputChannel.appendLine(fullMessage);
  } else {
    // If the channel isn't ready, the primary console.warn above already did the job.
    // However, to match the original plugin logic of a specific fallback message:
    console.warn('Pocket Agent: pocketAgentOutputChannel not (yet) ready for logWarn:', fullMessage);
  }
};

module.exports = {
  initializeLogger,
  getLogger,
  log,
  logError,
  logWarn,
};
