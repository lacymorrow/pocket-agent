/*
Twitter Like Bot
This script likes every reply to the configured account. It periodically polls the Twitter API for recent replies and likes them automatically.

Prerequisites:
1. Create a Twitter developer account and an application (https://developer.twitter.com/).
2. Generate the following credentials and store them in a .env file at the project root:

TWITTER_API_KEY=...
TWITTER_API_KEY_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...
TWITTER_BEARER_TOKEN=...
TARGET_USER_HANDLE=your_account_handle  # without @

3. Install dependencies:
   npm install --production

4. Run the bot:
   npm run like-bot
*/

require('dotenv/config');
const { TwitterApi } = require('twitter-api-v2');

// Validate required environment variables
const requiredEnv = [
  'TWITTER_API_KEY',
  'TWITTER_API_KEY_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_SECRET',
  'TARGET_USER_HANDLE',
];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.error(`Missing required environment variable ${key}`);
    process.exit(1);
  }
});

const {
  TWITTER_API_KEY: apiKey,
  TWITTER_API_KEY_SECRET: apiSecret,
  TWITTER_ACCESS_TOKEN: accessToken,
  TWITTER_ACCESS_SECRET: accessSecret,
  TWITTER_BEARER_TOKEN: bearerToken,
  TARGET_USER_HANDLE: targetHandle,
} = process.env;

// Initialize Twitter client for both OAuth1a (write actions) and app-only (read)
const userClient = new TwitterApi({
  appKey: apiKey,
  appSecret: apiSecret,
  accessToken: accessToken,
  accessSecret: accessSecret,
});

const readClient = bearerToken
  ? new TwitterApi(bearerToken)
  : userClient; // fallback to user client if bearer not provided

const v2UserClient = userClient.v2;
const v2ReadClient = readClient.v2;

async function getUserIdByHandle(handle) {
  const user = await v2ReadClient.userByUsername(handle, {
    'user.fields': ['id'],
  });
  return user?.data?.id;
}

async function likeTweet(tweetId) {
  try {
    await v2UserClient.like(await getOwnUserId(), tweetId);
    console.log(`Liked tweet ${tweetId}`);
  } catch (err) {
    if (err?.data?.errors?.[0]?.title === 'Forbidden' || err?.code === 403) {
      // Already liked or forbidden. Ignore.
      console.log(`Skipped tweet ${tweetId} (already liked or forbidden)`);
    } else {
      console.error('Error liking tweet', tweetId, err);
    }
  }
}

let cachedOwnUserId = null;
async function getOwnUserId() {
  if (cachedOwnUserId) return cachedOwnUserId;
  const me = await v2UserClient.me();
  cachedOwnUserId = me.data.id;
  return cachedOwnUserId;
}

async function pollReplies() {
  const targetUserId = await getUserIdByHandle(targetHandle);
  if (!targetUserId) {
    console.error(`Could not find user ID for handle @${targetHandle}`);
    process.exit(1);
  }

  console.log(`Monitoring replies to @${targetHandle} (user ID ${targetUserId})`);

  let sinceId = null;

  // Poll every 60 seconds
  setInterval(async () => {
    try {
      let query = `to:${targetHandle}`;
      const searchOptions = {
        since_id: sinceId || undefined,
        max_results: 100,
        expansions: ['author_id'],
        'tweet.fields': ['in_reply_to_user_id', 'conversation_id', 'author_id'],
      };

      const response = await v2ReadClient.search(query, searchOptions);
      const tweets = response?.data;
      if (!tweets?.length) {
        return; // Nothing new
      }

      // Update sinceId to latest tweet ID
      sinceId = tweets[0].id;

      for (const tweet of tweets.reverse()) {
        // Like each tweet
        await likeTweet(tweet.id);
      }
    } catch (err) {
      console.error('Error polling replies:', err);
    }
  }, 60 * 1000);
}

pollReplies();