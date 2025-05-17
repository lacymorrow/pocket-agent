const constants = require('../constants');

describe('Constants', () => {
  it('should export LEADER_ID_KEY correctly', () => {
    expect(constants.LEADER_ID_KEY).toBe('pocketAgentLeaderId');
  });

  it('should export LEADER_TIMESTAMP_KEY correctly', () => {
    expect(constants.LEADER_TIMESTAMP_KEY).toBe('pocketAgentLeaderTimestamp');
  });

  it('should export MAX_LEADER_AGE_MS correctly', () => {
    expect(constants.MAX_LEADER_AGE_MS).toBe(30000);
  });

  it('should export LEADER_HEARTBEAT_INTERVAL_MS correctly', () => {
    expect(constants.LEADER_HEARTBEAT_INTERVAL_MS).toBe(10000);
  });

  it('should export GITHUB_AUTH_PROVIDER_ID correctly', () => {
    expect(constants.GITHUB_AUTH_PROVIDER_ID).toBe('github');
  });

  it('should export SCOPES correctly', () => {
    expect(constants.SCOPES).toEqual(['read:user']);
  });

  it('should export DEFAULT_SERVER_URL correctly', () => {
    expect(constants.DEFAULT_SERVER_URL).toBe('http://localhost:3000');
  });

  it('should export DEFAULT_CURSOR_DEBUG_PORT correctly', () => {
    expect(constants.DEFAULT_CURSOR_DEBUG_PORT).toBe(9223);
  });
});
