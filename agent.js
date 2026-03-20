const { Auth0AI, getAccessTokenFromTokenVault } = require('@auth0/ai-langchain');
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');

const auth0AI = new Auth0AI({
  auth0: {
    domain: process.env.AUTH0_DOMAIN,
    clientId: process.env.AUTH_CLIENT_ID,
    clientSecret: process.env.AUTH_CLIENT_SECRET,
  },
});

// Guest: read-only scopes
const withSpotifyGuest = auth0AI.withTokenVault({
  connection: 'spotify',
  scopes: [
    'user-read-private',
    'user-top-read',
    'user-read-recently-played',
    'user-library-read',
  ],
});

// Host: read + playback control
const withSpotifyHost = auth0AI.withTokenVault({
  connection: 'spotify',
  scopes: [
    'user-read-private',
    'user-top-read',
    'user-read-recently-played',
    'user-library-read',
    'user-modify-playback-state',
  ],
});

// --- Guest tools (read-only) ---

const getTopTracks = withSpotifyGuest(
  tool(
    async (input) => {
      const credentials = getAccessTokenFromTokenVault();
      const res = await fetch(
        `https://api.spotify.com/v1/me/top/tracks?limit=${input.limit}&time_range=${input.timeRange}`,
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } }
      );
      if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);
      const data = await res.json();
      return JSON.stringify(
        data.items.map((t) => ({
          name: t.name,
          artist: t.artists.map((a) => a.name).join(', '),
          uri: t.uri,
          popularity: t.popularity,
        }))
      );
    },
    {
      name: 'get_top_tracks',
      description: "Get a user's top tracks from Spotify",
      schema: z.object({
        limit: z.number().default(20),
        timeRange: z.enum(['short_term', 'medium_term', 'long_term']).default('medium_term'),
      }),
    }
  )
);

const getRecentlyPlayed = withSpotifyGuest(
  tool(
    async (input) => {
      const credentials = getAccessTokenFromTokenVault();
      const res = await fetch(
        `https://api.spotify.com/v1/me/player/recently-played?limit=${input.limit}`,
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } }
      );
      if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);
      const data = await res.json();
      return JSON.stringify(
        data.items.map((item) => ({
          name: item.track.name,
          artist: item.track.artists.map((a) => a.name).join(', '),
          uri: item.track.uri,
          popularity: item.track.popularity,
        }))
      );
    },
    {
      name: 'get_recently_played',
      description: "Get a user's recently played tracks from Spotify",
      schema: z.object({
        limit: z.number().default(20),
      }),
    }
  )
);

const getSavedTracks = withSpotifyGuest(
  tool(
    async (input) => {
      const credentials = getAccessTokenFromTokenVault();
      const res = await fetch(
        `https://api.spotify.com/v1/me/tracks?limit=${input.limit}`,
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } }
      );
      if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);
      const data = await res.json();
      return JSON.stringify(
        data.items.map((item) => ({
          name: item.track.name,
          artist: item.track.artists.map((a) => a.name).join(', '),
          uri: item.track.uri,
          popularity: item.track.popularity,
        }))
      );
    },
    {
      name: 'get_saved_tracks',
      description: "Get a user's saved/liked tracks from Spotify library",
      schema: z.object({
        limit: z.number().default(20),
      }),
    }
  )
);

// --- Host tools (playback control) ---

const addToQueue = withSpotifyHost(
  tool(
    async (input) => {
      const credentials = getAccessTokenFromTokenVault();
      const res = await fetch(
        `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(input.uri)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Spotify API error: ${res.status} - ${err.error?.message || ''}`);
      }
      return JSON.stringify({ success: true, uri: input.uri });
    },
    {
      name: 'add_to_queue',
      description: "Add a track to the host's Spotify playback queue",
      schema: z.object({
        uri: z.string().describe('Spotify track URI (e.g. spotify:track:xxx)'),
      }),
    }
  )
);

const skipTrack = withSpotifyHost(
  tool(
    async () => {
      const credentials = getAccessTokenFromTokenVault();
      const res = await fetch('https://api.spotify.com/v1/me/player/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Spotify API error: ${res.status} - ${err.error?.message || ''}`);
      }
      return JSON.stringify({ success: true });
    },
    {
      name: 'skip_track',
      description: "Skip to the next track on the host's Spotify player",
      schema: z.object({}),
    }
  )
);


/**
 * Fetch a guest's music taste using Token Vault-protected tools.
 * Returns scored tracks from top tracks, recently played, and saved library.
 */
async function fetchGuestTaste(refreshToken) {
  const config = { configurable: { _credentials: { refreshToken } } };

  const [topRaw, recentRaw, savedRaw] = await Promise.all([
    getTopTracks.invoke({ limit: 50, timeRange: 'medium_term' }, config),
    getRecentlyPlayed.invoke({ limit: 50 }, config),
    getSavedTracks.invoke({ limit: 50 }, config),
  ]);

  const topTracks = JSON.parse(topRaw);
  const recentTracks = JSON.parse(recentRaw);
  const savedTracks = JSON.parse(savedRaw);

  const scored = new Map();

  for (const track of topTracks) {
    scored.set(track.uri, {
      ...track,
      score: (scored.get(track.uri)?.score || 0) + 3,
    });
  }
  for (const track of recentTracks) {
    scored.set(track.uri, {
      ...track,
      score: (scored.get(track.uri)?.score || 0) + 2,
    });
  }
  for (const track of savedTracks) {
    scored.set(track.uri, {
      ...track,
      score: (scored.get(track.uri)?.score || 0) + 1,
    });
  }

  return Array.from(scored.values());
}

/**
 * Queue tracks on the host's Spotify player.
 */
async function queueTracks(refreshToken, uris) {
  const config = { configurable: { _credentials: { refreshToken } } };
  const results = [];
  for (const uri of uris) {
    const result = await addToQueue.invoke({ uri }, config);
    results.push(JSON.parse(result));
  }
  return results;
}

/**
 * Skip current track on host's player.
 */
async function skipCurrentTrack(refreshToken) {
  const config = { configurable: { _credentials: { refreshToken } } };
  return JSON.parse(await skipTrack.invoke({}, config));
}

module.exports = {
  fetchGuestTaste,
  queueTracks,
  skipCurrentTrack,
};
