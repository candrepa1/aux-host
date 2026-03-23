const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parties (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      host_name TEXT,
      host_refresh_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS guests (
      party_id TEXT REFERENCES parties(id) ON DELETE CASCADE,
      sub TEXT NOT NULL,
      name TEXT,
      taste JSONB NOT NULL DEFAULT '[]',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (party_id, sub)
    );

    CREATE TABLE IF NOT EXISTS queue_tracks (
      party_id TEXT REFERENCES parties(id) ON DELETE CASCADE,
      uri TEXT NOT NULL,
      name TEXT NOT NULL,
      artist TEXT NOT NULL,
      popularity INT,
      score DOUBLE PRECISION NOT NULL,
      guest_count INT NOT NULL,
      position INT NOT NULL,
      PRIMARY KEY (party_id, uri)
    );
  `);
}

async function createParty(id, { host, hostName, hostRefreshToken }) {
  await pool.query(
    `INSERT INTO parties (id, host, host_name, host_refresh_token) VALUES ($1, $2, $3, $4)`,
    [id, host, hostName, hostRefreshToken]
  );
}

async function getParty(id) {
  const { rows } = await pool.query(`SELECT * FROM parties WHERE id = $1`, [id]);
  if (!rows[0]) return null;

  const party = rows[0];
  const guests = await pool.query(`SELECT * FROM guests WHERE party_id = $1`, [id]);
  const queue = await pool.query(
    `SELECT * FROM queue_tracks WHERE party_id = $1 ORDER BY position`,
    [id]
  );

  return {
    host: party.host,
    hostName: party.host_name,
    hostRefreshToken: party.host_refresh_token,
    createdAt: party.created_at,
    guests: Object.fromEntries(
      guests.rows.map((g) => [
        g.sub,
        { name: g.name, taste: g.taste, joinedAt: g.joined_at },
      ])
    ),
    queue: queue.rows.map((t) => ({
      uri: t.uri,
      name: t.name,
      artist: t.artist,
      popularity: t.popularity,
      score: t.score,
      guestCount: t.guest_count,
    })),
  };
}

async function addGuest(partyId, sub, name, taste) {
  await pool.query(
    `INSERT INTO guests (party_id, sub, name, taste)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (party_id, sub) DO UPDATE SET taste = $4, name = $3`,
    [partyId, sub, name, JSON.stringify(taste)]
  );
}

async function saveQueue(partyId, queue) {
  await pool.query(`DELETE FROM queue_tracks WHERE party_id = $1`, [partyId]);

  if (queue.length === 0) return;

  const values = [];
  const params = [];
  queue.forEach((track, i) => {
    const offset = i * 7;
    values.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
    );
    params.push(partyId, track.uri, track.name, track.artist, track.popularity ?? null, track.score, i);
  });

  await pool.query(
    `INSERT INTO queue_tracks (party_id, uri, name, artist, popularity, score, position)
     VALUES ${values.join(', ')}`,
    params
  );
}

async function deleteParty(id) {
  await pool.query(`DELETE FROM parties WHERE id = $1`, [id]);
}

module.exports = { pool, initDB, createParty, getParty, addGuest, saveQueue, deleteParty };
