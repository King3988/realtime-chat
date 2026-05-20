const crypto = require('crypto');
const path = require('path');

const isProd = !!process.env.DATABASE_URL;

let sqlite;
if (!isProd) {
  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(__dirname, 'data.db'));
  sqlite.pragma('journal_mode = WAL');
}

let pgPool;
if (isProd) {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

async function initSchema() {
  if (isProd) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        uid TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        is_guest INTEGER DEFAULT 0,
        role TEXT DEFAULT 'user',
        xp INTEGER DEFAULT 0,
        banned INTEGER DEFAULT 0,
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
    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER DEFAULT 500`);
    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_checkin DATE`);
  } else {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        is_guest INTEGER DEFAULT 0,
        role TEXT DEFAULT 'user',
        xp INTEGER DEFAULT 0,
        banned INTEGER DEFAULT 0,
        coins INTEGER DEFAULT 500,
        last_checkin TEXT,
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
    const cols = sqlite.prepare("PRAGMA table_info('users')").all().map(c => c.name);
    if (!cols.includes('role')) sqlite.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    if (!cols.includes('xp')) sqlite.exec("ALTER TABLE users ADD COLUMN xp INTEGER DEFAULT 0");
    if (!cols.includes('banned')) sqlite.exec("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0");
    if (!cols.includes('coins')) sqlite.exec("ALTER TABLE users ADD COLUMN coins INTEGER DEFAULT 500");
    if (!cols.includes('last_checkin')) sqlite.exec("ALTER TABLE users ADD COLUMN last_checkin TEXT");
  }
}

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

// === XP / Level ===
const XP_MULTIPLIER = { user: 1, vip: 2, svip: 3, admin: 1 };

function levelForXp(xp) {
  if (xp < 100) return 1;
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

function xpForNextLevel(level) {
  return level * level * 50;
}

async function addXp(userId, baseXp) {
  const user = await get('SELECT role, xp FROM users WHERE id = ?', [userId]);
  if (!user) return;
  const mult = XP_MULTIPLIER[user.role] || 1;
  const gained = Math.round(baseXp * mult);
  await run('UPDATE users SET xp = xp + ? WHERE id = ?', [gained, userId]);
  return { gained, total: (user.xp || 0) + gained };
}

// === Public API ===
async function createUser(username, passwordHash) {
  const uid = generateUid();
  await run('INSERT INTO users (uid, username, password_hash, role, xp) VALUES (?, ?, ?, ?, ?)', [uid, username, passwordHash, 'user', 0]);
  return getUserByUsername(username);
}

async function createGuestUser(username) {
  const uid = generateUid();
  await run('INSERT INTO users (uid, username, is_guest, role, xp) VALUES (?, ?, 1, ?, ?)', [uid, username, 'user', 0]);
  return getUserByUsername(username);
}

async function getUserByUsername(username) {
  return get('SELECT * FROM users WHERE username = ?', [username]);
}

async function getUserById(id) {
  return get('SELECT id, uid, username, is_guest, role, xp, coins, created_at FROM users WHERE id = ?', [id]);
}

async function searchUsers(keyword, excludeId) {
  const like = isProd ? 'ILIKE' : 'LIKE';
  const rows = await query(
    `SELECT id, uid, username, is_guest, role, xp FROM users WHERE (username ${like} ? OR uid ${like} ?) AND id != ? ORDER BY username ASC LIMIT 20`,
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

// === Admin ===
async function getAllUsers(page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  const rows = await query(
    `SELECT id, uid, username, is_guest, role, xp, coins, banned, created_at FROM users ORDER BY id ASC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  const countRow = await get('SELECT COUNT(*) as total FROM users');
  return { users: rows.rows, total: countRow ? countRow.total : 0 };
}

async function updateUserRole(userId, role) {
  await run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
}

async function updateUserXp(userId, xp) {
  const target = Math.max(0, Math.floor(xp));
  await run('UPDATE users SET xp = ? WHERE id = ?', [target, userId]);
}

async function updateUserPassword(userId, hash) {
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
}

async function deleteUser(userId) {
  await run('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [userId, userId]);
  await run('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', [userId, userId]);
  await run('DELETE FROM users WHERE id = ?', [userId]);
}

async function banUser(userId) {
  await run('UPDATE users SET banned = 1 WHERE id = ?', [userId]);
}

async function unbanUser(userId) {
  await run('UPDATE users SET banned = 0 WHERE id = ?', [userId]);
}

async function deleteAllGuests() {
  const guests = await query('SELECT id FROM users WHERE is_guest = 1');
  for (const g of guests.rows) {
    await deleteUser(g.id);
  }
  return guests.rows.length;
}

// === Coins ===
async function getUserCoins(userId) {
  const row = await get('SELECT coins FROM users WHERE id = ?', [userId]);
  return row ? row.coins : 0;
}

async function updateUserCoins(userId, amount) {
  await run('UPDATE users SET coins = ? WHERE id = ?', [amount, userId]);
}

async function addCoins(userId, delta) {
  await run('UPDATE users SET coins = MAX(0, coins + ?) WHERE id = ?', [delta, userId]);
  const row = await get('SELECT coins FROM users WHERE id = ?', [userId]);
  return row ? row.coins : 0;
}

async function getCheckinStatus(userId) {
  const row = await get('SELECT last_checkin FROM users WHERE id = ?', [userId]);
  const today = new Date().toISOString().slice(0, 10);
  return { checkedIn: row && row.last_checkin === today, today };
}

async function doCheckin(userId) {
  const status = await getCheckinStatus(userId);
  if (status.checkedIn) return null;
  const reward = 200;
  await run('UPDATE users SET coins = coins + ?, last_checkin = ? WHERE id = ?', [reward, status.today, userId]);
  const row = await get('SELECT coins FROM users WHERE id = ?', [userId]);
  return { reward, coins: row.coins };
}

initSchema();

module.exports = {
  createUser, getUserByUsername, getUserById, searchUsers, createGuestUser,
  sendFriendRequest, getFriendRequests, getFriends, acceptFriendRequest, declineFriendRequest,
  saveMessage, getMessages, getFriendStatus,
  addXp, levelForXp, xpForNextLevel, XP_MULTIPLIER,
  getAllUsers, updateUserRole, updateUserXp, updateUserPassword, deleteUser,
  banUser, unbanUser, deleteAllGuests,
  getUserCoins, updateUserCoins, addCoins, getCheckinStatus, doCheckin,
};
