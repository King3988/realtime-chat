const crypto = require('crypto');
const path = require('path');

const isProd = !!process.env.DATABASE_URL;

// === SQLite backend (development) ===
let sqlite;
if (!isProd) {
  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(__dirname, 'data.db'));
  sqlite.pragma('journal_mode = WAL');
}

// === PostgreSQL backend (production) ===
let pgPool;
if (isProd) {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// === Schema init ===
async function initSchema() {
  if (isProd) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        uid TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        is_guest INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS friends (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        friend_id INTEGER NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, friend_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        receiver_id INTEGER NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        is_guest INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        friend_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, friend_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }
}

// === Helpers ===
function generateUid() {
  return 'U' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function convertSql(sql) {
  if (!isProd) return sql;
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

async function query(sql, params = []) {
  if (isProd) {
    const res = await pgPool.query(convertSql(sql), params);
    return res;
  }
  return { rows: sqlite.prepare(sql).all(...params) };
}

async function get(sql, params = []) {
  if (isProd) {
    const res = await pgPool.query(convertSql(sql), params);
    return res.rows[0] || null;
  }
  return sqlite.prepare(sql).get(...params) || null;
}

async function run(sql, params = []) {
  if (isProd) {
    const res = await pgPool.query(convertSql(sql), params);
    return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id };
  }
  const stmt = sqlite.prepare(sql);
  const info = stmt.run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

// === Public API ===
async function createUser(username, passwordHash) {
  const uid = generateUid();
  await run('INSERT INTO users (uid, username, password_hash) VALUES (?, ?, ?)', [uid, username, passwordHash]);
  return getUserByUsername(username);
}

async function createGuestUser(username) {
  const uid = generateUid();
  await run('INSERT INTO users (uid, username, is_guest) VALUES (?, ?, 1)', [uid, username]);
  return getUserByUsername(username);
}

async function getUserByUsername(username) {
  return get('SELECT * FROM users WHERE username = ?', [username]);
}

async function getUserById(id) {
  return get('SELECT id, uid, username, is_guest, created_at FROM users WHERE id = ?', [id]);
}

async function searchUsers(keyword, excludeId) {
  const like = isProd ? 'ILIKE' : 'LIKE';
  const rows = await query(
    `SELECT id, uid, username, is_guest, created_at FROM users WHERE (username ${like} ? OR uid ${like} ?) AND id != ? ORDER BY username ASC LIMIT 20`,
    [`%${keyword}%`, `%${keyword}%`, excludeId]
  );
  return rows.rows;
}

async function sendFriendRequest(userId, friendId) {
  const existing = await get('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?', [userId, friendId]);
  if (existing) return existing;

  const reverse = await get('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?', [friendId, userId]);
  if (reverse) {
    if (reverse.status === 'pending') {
      await run('UPDATE friends SET status = ? WHERE id = ?', ['accepted', reverse.id]);
      return { status: 'accepted', id: reverse.id };
    }
    return reverse;
  }

  await run('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)', [userId, friendId, 'pending']);
  return { status: 'pending' };
}

async function getFriendRequests(userId) {
  const res = await query(
    `SELECT u.id, u.uid, u.username, f.created_at FROM friends f JOIN users u ON f.user_id = u.id WHERE f.friend_id = ? AND f.status = 'pending'`,
    [userId]
  );
  return res.rows;
}

async function getFriends(userId) {
  const sent = await query(
    `SELECT u.id, u.uid, u.username, f.created_at FROM friends f JOIN users u ON f.friend_id = u.id WHERE f.user_id = ? AND f.status = 'accepted'`,
    [userId]
  );
  const received = await query(
    `SELECT u.id, u.uid, u.username, f.created_at FROM friends f JOIN users u ON f.user_id = u.id WHERE f.friend_id = ? AND f.status = 'accepted'`,
    [userId]
  );
  return [...sent.rows, ...received.rows];
}

async function acceptFriendRequest(userId, friendId) {
  const result = await run(
    'UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ? AND status = ?',
    ['accepted', friendId, userId, 'pending']
  );
  return result.changes > 0;
}

async function declineFriendRequest(userId, friendId) {
  const result = await run(
    'DELETE FROM friends WHERE user_id = ? AND friend_id = ? AND status = ?',
    [friendId, userId, 'pending']
  );
  return result.changes > 0;
}

async function saveMessage(senderId, receiverId, content) {
  await run('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)', [senderId, receiverId, content]);
}

async function getMessages(userId, friendId, limit = 50) {
  const res = await query(
    `SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY created_at DESC LIMIT ?`,
    [userId, friendId, friendId, userId, limit]
  );
  return res.rows.reverse();
}

async function getFriendStatus(userId, friendId) {
  const row = await get(
    'SELECT status FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    [userId, friendId, friendId, userId]
  );
  return row ? row.status : null;
}

initSchema();

module.exports = {
  createUser, getUserByUsername, getUserById, searchUsers, createGuestUser,
  sendFriendRequest, getFriendRequests, getFriends, acceptFriendRequest, declineFriendRequest,
  saveMessage, getMessages, getFriendStatus,
};
