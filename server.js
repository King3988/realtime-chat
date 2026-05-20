const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: 'realtime-chat-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
});

app.use(sessionMiddleware);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

const SALT_ROUNDS = 10;

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  next();
}

// === Auth Routes ===

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写所有字段' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  const existing = await db.getUserByUsername(username);
  if (existing) return res.status(400).json({ error: '用户名已被注册' });

  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const user = await db.createUser(username, hash);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ id: user.id, uid: user.uid, username: user.username, role: user.role, xp: user.xp });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.getUserByUsername(username);
  if (!user || user.is_guest || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }
  if (user.banned) return res.status(403).json({ error: '账号已被封禁' });
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ id: user.id, uid: user.uid, username: user.username, role: user.role, xp: user.xp });
});

app.post('/api/guest-login', async (req, res) => {
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const username = `游客_${randomSuffix}`;
  const user = await db.createGuestUser(username);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.is_guest = 1;
  res.json({ id: user.id, uid: user.uid, username: user.username, role: user.role, xp: user.xp });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await db.getUserById(req.session.userId);
  const level = db.levelForXp(user.xp || 0);
  const nextXp = db.xpForNextLevel(level);
  res.json({ user: { ...user, level, nextXp } });
});

// === Friend Routes ===

app.get('/api/users/search', requireAuth, async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 1) return res.json({ users: [] });
  const users = await db.searchUsers(q, req.session.userId);
  res.json({ users });
});

app.get('/api/friends', requireAuth, async (req, res) => {
  const friends = await db.getFriends(req.session.userId);
  res.json({ friends });
});

app.get('/api/friends/requests', requireAuth, async (req, res) => {
  const requests = await db.getFriendRequests(req.session.userId);
  res.json({ requests });
});

app.post('/api/friends/request', requireAuth, async (req, res) => {
  const { friendId } = req.body;
  if (friendId === req.session.userId) return res.status(400).json({ error: '不能添加自己' });
  const friend = await db.getUserById(friendId);
  if (!friend) return res.status(404).json({ error: '用户不存在' });

  const existingStatus = await db.getFriendStatus(req.session.userId, friendId);
  if (existingStatus === 'accepted') return res.status(400).json({ error: '已经是好友' });
  if (existingStatus === 'pending') return res.status(400).json({ error: '已发送过请求' });

  const result = await db.sendFriendRequest(req.session.userId, friendId);
  if (result.status === 'accepted') {
    const friendUser = await db.getUserById(friendId);
    const myUser = await db.getUserById(req.session.userId);
    io.to(`user:${friendId}`).emit('friend added', { friend: { id: req.session.userId, uid: myUser.uid, username: myUser.username } });
    io.to(`user:${req.session.userId}`).emit('friend added', { friend: { id: friendId, uid: friendUser.uid, username: friendUser.username } });
    res.json({ status: 'accepted' });
  } else {
    const myUser = await db.getUserById(req.session.userId);
    io.to(`user:${friendId}`).emit('friend request', { from: { id: req.session.userId, uid: myUser.uid, username: myUser.username } });
    res.json({ status: 'pending' });
  }
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  const { friendId } = req.body;
  const success = await db.acceptFriendRequest(req.session.userId, friendId);
  if (success) {
    const friendUser = await db.getUserById(friendId);
    const myUser = await db.getUserById(req.session.userId);
    io.to(`user:${friendId}`).emit('friend added', { friend: { id: req.session.userId, uid: myUser.uid, username: myUser.username } });
    io.to(`user:${req.session.userId}`).emit('friend added', { friend: { id: friendId, uid: friendUser.uid, username: friendUser.username } });
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: '请求不存在' });
  }
});

app.post('/api/friends/decline', requireAuth, async (req, res) => {
  const { friendId } = req.body;
  const success = await db.declineFriendRequest(req.session.userId, friendId);
  res.json({ ok: success });
});

// === Message Routes ===

app.get('/api/messages/:friendId', requireAuth, async (req, res) => {
  const friendId = parseInt(req.params.friendId);
  const messages = await db.getMessages(req.session.userId, friendId);
  const friend = await db.getUserById(friendId);
  const enriched = messages.map(m => ({
    id: m.id,
    content: m.content,
    senderId: m.sender_id,
    receiverId: m.receiver_id,
    createdAt: m.created_at,
  }));
  res.json({ messages: enriched, friend: friend ? { id: friend.id, uid: friend.uid, username: friend.username } : null });
});

// === Admin Routes ===

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  next();
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const data = await db.getAllUsers(page);
  const enriched = data.users.map(u => ({ ...u, level: db.levelForXp(u.xp || 0) }));
  res.json({ users: enriched, total: data.total });
});

app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = await db.getUserById(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: { ...user, level: db.levelForXp(user.xp || 0) } });
});

async function isTargetAdmin(targetId) {
  const target = await db.getUserById(targetId);
  return target && target.role === 'admin';
}

app.put('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (await isTargetAdmin(targetId)) return res.status(403).json({ error: '不能修改其他超管的权限' });
  const { role } = req.body;
  if (!['user', 'vip', 'svip', 'admin'].includes(role)) return res.status(400).json({ error: '无效角色' });
  await db.updateUserRole(targetId, role);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/xp', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (await isTargetAdmin(targetId)) return res.status(403).json({ error: '不能修改其他超管的经验' });
  const { xp } = req.body;
  if (xp === undefined || xp < 0) return res.status(400).json({ error: '无效经验值' });
  await db.updateUserXp(targetId, xp);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId !== req.session.userId && await isTargetAdmin(targetId)) return res.status(403).json({ error: '不能修改其他超管的密码' });
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  await db.updateUserPassword(targetId, hash);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.userId) return res.status(400).json({ error: '不能封禁自己' });
  if (await isTargetAdmin(targetId)) return res.status(403).json({ error: '不能封禁其他超管' });
  await db.banUser(targetId);
  io.to(`user:${targetId}`).emit('banned');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  await db.unbanUser(parseInt(req.params.id));
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
    return res.sendFile(path.join(__dirname, 'public', 'app.html'));
  }
  next();
});

// === Socket.io ===

const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

io.use(async (socket, next) => {
  const session = socket.request.session;
  if (!session || !session.userId) return next(new Error('未登录'));
  const user = await db.getUserById(session.userId);
  if (user && user.banned) return next(new Error('已被封禁'));
  next();
});

const guestSockets = {};

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;
  const username = socket.request.session.username;
  const isGuest = socket.request.session.is_guest;
  socket.join(`user:${userId}`);
  console.log(`${username} 连接: ${socket.id}`);

  if (isGuest) {
    if (!guestSockets[userId]) guestSockets[userId] = new Set();
    guestSockets[userId].add(socket.id);
  }

  socket.on('private message', async ({ receiverId, content }) => {
    const msg = { senderId: userId, receiverId, content, createdAt: new Date().toISOString() };
    await db.saveMessage(userId, receiverId, content);
    const xpResult = await db.addXp(userId, 10);
    if (xpResult) msg.xpGained = xpResult.gained;
    io.to(`user:${receiverId}`).emit('private message', msg);
    socket.emit('private message', msg);
  });

  socket.on('disconnect', () => {
    console.log(`${username} 断开: ${socket.id}`);
    if (isGuest && guestSockets[userId]) {
      guestSockets[userId].delete(socket.id);
      if (guestSockets[userId].size === 0) {
        delete guestSockets[userId];
        db.deleteUser(userId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
});
