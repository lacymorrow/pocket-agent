const LEADER_ID_KEY = 'pocketAgentLeaderId';
const LEADER_TIMESTAMP_KEY = 'pocketAgentLeaderTimestamp';
const MAX_LEADER_AGE_MS = 30000; // 30 seconds for a leader to be considered stale
const LEADER_HEARTBEAT_INTERVAL_MS = 10000; // Leader updates its timestamp every 10 seconds

const GITHUB_AUTH_PROVIDER_ID = 'github';
const SCOPES = ['read:user']; // Basic scope to read user profile

const DEFAULT_SERVER_URL = 'http://localhost:3000';
const DEFAULT_CURSOR_DEBUG_PORT = 9223;

module.exports = {
    LEADER_ID_KEY,
    LEADER_TIMESTAMP_KEY,
    MAX_LEADER_AGE_MS,
    LEADER_HEARTBEAT_INTERVAL_MS,
    GITHUB_AUTH_PROVIDER_ID,
    SCOPES,
    DEFAULT_SERVER_URL,
    DEFAULT_CURSOR_DEBUG_PORT,
};
