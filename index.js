require('dotenv').config();
const express = require('express');
const { auth, requiresAuth } = require('express-openid-connect');
const { auth: jwtAuth } = require('express-oauth2-jwt-bearer');
const { fetchGuestTaste, queueTracks, skipCurrentTrack } = require('./agent');
const { initDB, createParty, getParty, addGuest, saveQueue } = require('./db');

const app = express();
app.use(express.json());

const config = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.AUTH_SECRET,
  baseURL: 'http://localhost:3000',
  clientID: process.env.AUTH_CLIENT_ID,
  clientSecret: process.env.AUTH_CLIENT_SECRET,
  issuerBaseURL: process.env.AUTH_ISSUER_BASE_URL,
  authorizationParams: {
    response_type: 'code',
    scope: 'openid profile email offline_access',
  },
};

app.use(auth(config));

// JWT validation for Bearer token auth (iOS app)
const checkJwt = jwtAuth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH_ISSUER_BASE_URL,
  tokenSigningAlg: 'RS256',
});

// Unified auth middleware: supports both session (browser) and Bearer token (iOS)
function requiresAuthUnified() {
  return async (req, res, next) => {
    // Check if there's a valid OIDC session (browser)
    if (req.oidc?.isAuthenticated()) {
      req.user = {
        sub: req.oidc.user.sub,
        name: req.oidc.user.name || req.oidc.user.email,
        email: req.oidc.user.email,
        refreshToken: req.oidc.refreshToken,
      };
      return next();
    }

    // Check for Bearer token (iOS app)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      checkJwt(req, res, (err) => {
        if (err) {
          console.error('JWT validation error:', err.message);
          return res.status(401).json({ error: 'Invalid token', details: err.message });
        }
        // req.auth is set by express-oauth2-jwt-bearer
        req.user = {
          sub: req.auth.payload.sub,
          name: req.auth.payload.name || req.auth.payload.email || req.auth.payload.sub,
          email: req.auth.payload.email,
          // iOS app must send refresh token in the request body for Token Vault
          refreshToken: req.body?.refreshToken,
        };
        next();
      });
      return;
    }

    res.status(401).json({ error: 'Authentication required' });
  };
}

// Initialize database tables on startup
initDB().then(() => console.log('Database initialized')).catch(console.error);

app.get('/', (req, res) => {
  res.send(req.oidc.isAuthenticated() ? 'Logged in' : 'Logged out');
});

app.get('/profile', requiresAuth(), (req, res) => {
  res.send(JSON.stringify(req.oidc.user));
});

/**
 * Blend multiple guests' tastes into a single ranked queue.
 * Tracks that appear for multiple guests get boosted.
 */
function blendTastes(guestTastes) {
  const blended = new Map();

  for (const taste of guestTastes) {
    for (const track of taste) {
      const existing = blended.get(track.uri);
      if (existing) {
        existing.score += track.score;
        existing.guestCount += 1;
      } else {
        blended.set(track.uri, { ...track, guestCount: 1 });
      }
    }
  }

  // Boost tracks liked by multiple guests
  for (const track of blended.values()) {
    track.score *= track.guestCount;
  }

  return Array.from(blended.values()).sort((a, b) => b.score - a.score);
}

// Middleware: check if current user is the party host
function requiresHost(req, res, party) {
  if (party.host !== req.user.sub) {
    res.status(403).json({ error: 'Only the host can do this' });
    return false;
  }
  return true;
}

// Host creates a party
app.post('/party', requiresAuthUnified(), async (req, res) => {
  const partyId = Math.random().toString(36).substring(2, 8);
  const { sub, name, email, refreshToken } = req.user;

  if (!refreshToken) {
    return res.status(400).json({ error: 'No refresh token. Send refreshToken in request body.' });
  }

  try {
    await createParty(partyId, {
      host: sub,
      hostName: name || email,
      hostRefreshToken: refreshToken,
    });
    res.json({ partyId });
  } catch (err) {
    console.error('Create party error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Guest joins a party (must be logged in with Spotify connected)
app.post('/party/:id/join', requiresAuthUnified(), async (req, res) => {
  const party = await getParty(req.params.id);
  if (!party) return res.status(404).json({ error: 'Party not found' });

  const { sub, name, email, refreshToken } = req.user;
  if (!refreshToken) {
    return res.status(400).json({ error: 'No refresh token. Send refreshToken in request body.' });
  }

  try {
    const taste = await fetchGuestTaste(refreshToken);
    await addGuest(req.params.id, sub, name || email, taste);

    // Re-blend the queue every time someone joins
    party.guests[sub] = { name: name || email, taste };
    const allTastes = Object.values(party.guests).map((g) => g.taste);
    const queue = blendTastes(allTastes);
    await saveQueue(req.params.id, queue);

    res.json({
      message: `${name || email} joined the party!`,
      guestCount: Object.keys(party.guests).length,
      queueLength: queue.length,
    });
  } catch (err) {
    console.error('Join error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get the blended queue for a party
app.get('/party/:id/queue', async (req, res) => {
  const party = await getParty(req.params.id);
  if (!party) return res.status(404).json({ error: 'Party not found' });

  const limit = parseInt(req.query.limit) || 20;
  res.json({
    partyId: req.params.id,
    host: party.hostName,
    guestCount: Object.keys(party.guests).length,
    guests: Object.values(party.guests).map((g) => g.name),
    queue: party.queue.slice(0, limit),
  });
});

// Get party info
app.get('/party/:id', async (req, res) => {
  const party = await getParty(req.params.id);
  if (!party) return res.status(404).json({ error: 'Party not found' });

  res.json({
    partyId: req.params.id,
    host: party.hostName,
    guestCount: Object.keys(party.guests).length,
    guests: Object.values(party.guests).map((g) => g.name),
    queueLength: party.queue.length,
    createdAt: party.createdAt,
  });
});

// Host: push top N blended tracks to Spotify queue
app.post('/party/:id/play', requiresAuthUnified(), async (req, res) => {
  const party = await getParty(req.params.id);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  if (!requiresHost(req, res, party)) return;

  const count = parseInt(req.query.count) || 10;
  const uris = party.queue.slice(0, count).map((t) => t.uri);

  try {
    const results = await queueTracks(party.hostRefreshToken, uris);
    res.json({ queued: results.length, tracks: uris });
  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Host: skip current track
app.post('/party/:id/skip', requiresAuthUnified(), async (req, res) => {
  const party = await getParty(req.params.id);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  if (!requiresHost(req, res, party)) return;

  try {
    await skipCurrentTrack(party.hostRefreshToken);
    res.json({ success: true });
  } catch (err) {
    console.error('Skip error:', err);
    res.status(500).json({ error: err.message });
  }
});


const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
