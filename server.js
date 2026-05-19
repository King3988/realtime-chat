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

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写所有字段' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  if (db.getUserByUsername(username)) return res.status(400).json({ error: '用户名已被注册' });

  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const user = db.createUser(username, hash);
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, uid: user.uid, username: user.username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.getUserByUsername(username);
  if (!user || user.is_guest || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, uid: user.uid, username: user.username });
});

app.post('/api/guest-login', (req, res) => {
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const username = `游客_${randomSuffix}`;
  const user = db.createGuestUser(username);
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, uid: user.uid, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.getUserById(req.session.userId);
  res.json({ user });
});

// === Friend Routes ===

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 1) return res.json({ users: [] });
  const users = db.searchUsers(q, req.session.userId);
  res.json({ users });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const friends = db.getFriends(req.session.userId);
  res.json({ friends });
});

app.get('/api/friends/requests', requireAuth, (req, res) => {
  const requests = db.getFriendRequests(req.session.userId);
  res.json({ requests });
});

app.post('/api/friends/request', requireAuth, (req, res) => {
  const { friendId } = req.body;
  if (friendId === req.session.userId) return res.status(400).json({ error: '不能添加自己' });
  const friend = db.getUserById(friendId);
  if (!friend) return res.status(404).json({ error: '用户不存在' });

  const existingStatus = db.getFriendStatus(req.session.userId, friendId);
  if (existingStatus === 'accepted') return res.status(400).json({ error: '已经是好友' });
  if (existingStatus === 'pending') return res.status(400).json({ error: '已发送过请求' });

  const result = db.sendFriendRequest(req.session.userId, friendId);
  if (result.status === 'accepted') {
    const friendUser = db.getUserById(friendId);
    io.to(`user:${friendId}`).emit('friend added', { friend: { id: req.session.userId, uid: db.getUserById(req.session.userId).uid, username: req.session.username } });
    io.to(`user:${req.session.userId}`).emit('friend added', { friend: { id: friendId, uid: friendUser.uid, username: friendUser.username } });
    res.json({ status: 'accepted' });
  } else {
    io.to(`user:${friendId}`).emit('friend request', { from: { id: req.session.userId, uid: db.getUserById(req.session.userId).uid, username: req.session.username } });
    res.json({ status: 'pending' });
  }
});

app.post('/api/friends/accept', requireAuth, (req, res) => {
  const { friendId } = req.body;
  const success = db.acceptFriendRequest(req.session.userId, friendId);
  if (success) {
    const friendUser = db.getUserById(friendId);
    const myUser = db.getUserById(req.session.userId);
    io.to(`user:${friendId}`).emit('friend added', { friend: { id: req.session.userId, uid: myUser.uid, username: myUser.username } });
    io.to(`user:${req.session.userId}`).emit('friend added', { friend: { id: friendId, uid: friendUser.uid, username: friendUser.username } });
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: '请求不存在' });
  }
});

app.post('/api/friends/decline', requireAuth, (req, res) => {
  const { friendId } = req.body;
  const success = db.declineFriendRequest(req.session.userId, friendId);
  res.json({ ok: success });
});

// === Message Routes ===

app.get('/api/messages/:friendId', requireAuth, (req, res) => {
  const friendId = parseInt(req.params.friendId);
  const messages = db.getMessages(req.session.userId, friendId);
  const friend = db.getUserById(friendId);
  const enriched = messages.map(m => ({
    id: m.id,
    content: m.content,
    senderId: m.sender_id,
    receiverId: m.receiver_id,
    createdAt: m.created_at,
  }));
  res.json({ messages: enriched, friend: friend ? { id: friend.id, uid: friend.uid, username: friend.username } : null });
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

io.use((socket, next) => {
  const session = socket.request.session;
  if (session && session.userId) {
    next();
  } else {
    next(new Error('未登录'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;
  const username = socket.request.session.username;
  socket.join(`user:${userId}`);
  console.log(`${username} 连接: ${socket.id}`);

  socket.on('private message', ({ receiverId, content }) => {
    const msg = { senderId: userId, receiverId, content, createdAt: new Date().toISOString() };
    db.saveMessage(userId, receiverId, content);
    io.to(`user:${receiverId}`).emit('private message', msg);
    socket.emit('private message', msg);
  });

  socket.on('disconnect', () => {
    console.log(`${username} 断开: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
});
