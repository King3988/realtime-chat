const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id),
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  );
`);

function generateUid() {
  return 'U' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function createUser(username, passwordHash) {
  const uid = generateUid();
  const stmt = db.prepare('INSERT INTO users (uid, username, password_hash) VALUES (?, ?, ?)');
  stmt.run(uid, username, passwordHash);
  return getUserByUsername(username);
}

function createGuestUser(username) {
  const uid = generateUid();
  const stmt = db.prepare('INSERT INTO users (uid, username, is_guest) VALUES (?, ?, 1)');
  stmt.run(uid, username);
  return getUserByUsername(username);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT id, uid, username, is_guest, created_at FROM users WHERE id = ?').get(id);
}

function searchUsers(keyword, excludeId) {
  return db.prepare(
    `SELECT id, uid, username, is_guest, created_at FROM users
     WHERE (username LIKE ? OR uid LIKE ?) AND id != ?
     ORDER BY username ASC LIMIT 20`
  ).all(`%${keyword}%`, `%${keyword}%`, excludeId);
}

function getUsersByIds(ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT id, uid, username FROM users WHERE id IN (${placeholders})`).all(...ids);
}

function sendFriendRequest(userId, friendId) {
  const existing = db.prepare(
    'SELECT * FROM friends WHERE user_id = ? AND friend_id = ?'
  ).get(userId, friendId);
  if (existing) return existing;

  const reverse = db.prepare(
    'SELECT * FROM friends WHERE user_id = ? AND friend_id = ?'
  ).get(friendId, userId);
  if (reverse) {
    if (reverse.status === 'pending') {
      db.prepare('UPDATE friends SET status = ? WHERE id = ?').run('accepted', reverse.id);
      return { status: 'accepted', id: reverse.id };
    }
    return reverse;
  }

  db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)').run(userId, friendId, 'pending');
  return { status: 'pending' };
}

function getFriendRequests(userId) {
  return db.prepare(
    `SELECT u.id, u.uid, u.username, f.created_at
     FROM friends f JOIN users u ON f.user_id = u.id
     WHERE f.friend_id = ? AND f.status = 'pending'`
  ).all(userId);
}

function getFriends(userId) {
  const sent = db.prepare(
    `SELECT u.id, u.uid, u.username, f.created_at
     FROM friends f JOIN users u ON f.friend_id = u.id
     WHERE f.user_id = ? AND f.status = 'accepted'`
  ).all(userId);

  const received = db.prepare(
    `SELECT u.id, u.uid, u.username, f.created_at
     FROM friends f JOIN users u ON f.user_id = u.id
     WHERE f.friend_id = ? AND f.status = 'accepted'`
  ).all(userId);

  return [...sent, ...received];
}

function acceptFriendRequest(userId, friendId) {
  const result = db.prepare(
    'UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ? AND status = ?'
  ).run('accepted', friendId, userId, 'pending');

  return result.changes > 0;
}

function declineFriendRequest(userId, friendId) {
  const result = db.prepare(
    'DELETE FROM friends WHERE user_id = ? AND friend_id = ? AND status = ?'
  ).run(friendId, userId, 'pending');
  return result.changes > 0;
}

function saveMessage(senderId, receiverId, content) {
  db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)').run(senderId, receiverId, content);
}

function getMessages(userId, friendId, limit = 50) {
  return db.prepare(
    `SELECT * FROM messages
     WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
     ORDER BY created_at DESC LIMIT ?`
  ).all(userId, friendId, friendId, userId, limit).reverse();
}

function getFriendStatus(userId, friendId) {
  const row = db.prepare(
    'SELECT status FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  ).get(userId, friendId, friendId, userId);
  return row ? row.status : null;
}

module.exports = {
  createUser, getUserByUsername, getUserById, searchUsers, getUsersByIds, createGuestUser,
  sendFriendRequest, getFriendRequests, getFriends, acceptFriendRequest, declineFriendRequest,
  saveMessage, getMessages, getFriendStatus,
};
