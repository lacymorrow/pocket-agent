const { sendComposerRequest } = require('./client/desktop');

// Function to parse tool calls from XML format
function parseToolCall(xmlString) {
    // Basic XML parsing - could be more robust with a proper XML parser
    const matches = xmlString.match(/<invoke name="([^"]+)">([\s\S]*?)<\/antml:invoke>/);
    if (!matches) return null;

    const toolName = matches[1];
    const paramsMatches = matches[2].matchAll(/<parameter name="([^"]+)">([\s\S]*?)<\/antml:parameter>/g);

    const params = {};
    for (const match of paramsMatches) {
        params[match[1]] = match[2];
    }

    return {
        toolName,
        params
    };
}

/**
 * Hook function to intercept tool calls
 * @param {string} toolCallXml - The XML string of the tool call
 * @returns {Promise<any>} - The result of the tool call
 */
async function interceptToolCall(toolCallXml) {
    const toolCall = parseToolCall(toolCallXml);
    if (!toolCall) return null;

    // Send to socket
    await sendComposerRequest({
        type: 'tool_call',
        tool: toolCall.toolName,
        params: toolCall.params,
        timestamp: Date.now()
    });

    return toolCall;
}

/**
 * This function should be called by Cursor when it needs user approval
 * @param {string} message - The message to show to the user
 * @returns {Promise<boolean>} - Resolves to true if approved, false if rejected
 */
async function requestUserApproval(message) {
    try {
        const approved = await sendComposerRequest({
            type: 'approval_request',
            message,
            timestamp: Date.now()
        });
        return approved;
    } catch (error) {
        console.error('Error requesting user approval:', error);
        return false;
    }
}

// Export for use in Cursor
module.exports = {
    interceptToolCall,
    requestUserApproval: async (message) => {
        try {
            const approved = await sendComposerRequest({
                type: 'approval_request',
                message,
                timestamp: Date.now()
            });
            return approved;
        } catch (error) {
            console.error('Error requesting user approval:', error);
            return false;
        }
    }
};
