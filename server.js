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

// === Coin / Check-in Routes ===

app.post('/api/checkin', requireAuth, async (req, res) => {
  const result = await db.doCheckin(req.session.userId);
  if (!result) return res.status(400).json({ error: '今日已签到' });
  res.json(result);
});

app.put('/api/admin/users/:id/coins', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (await isTargetAdmin(targetId) && targetId !== req.session.userId) return res.status(403).json({ error: '不能修改其他超管的金币' });
  const { coins } = req.body;
  if (coins === undefined || coins < 0) return res.status(400).json({ error: '无效数量' });
  await db.updateUserCoins(targetId, coins);
  res.json({ ok: true });
});

// === Poker Engine ===

const Hand = require('pokersolver').Hand;
const { ChineseChessGame } = require('./chess.js');
const ACTION_TIMEOUT_MS = 30000;

function createDeck() {
  const suits = ['c','d','h','s'], ranks = '23456789TJQKA';
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(r+s);
  return deck;
}

function shuffle(arr) {
  for (let i=arr.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}

class PokerGame {
  constructor(roomId, hostId, opts) {
    this.roomId = roomId;
    this.hostId = hostId;
    this.sb = opts.sb||10;
    this.bb = opts.bb||20;
    this.players = [];
    this.spectators = [];
    this.deck = [];
    this.community = [];
    this.phase = 'waiting'; // waiting|preflop|flop|turn|river|showdown|settle
    this.pots = [];
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.lastRaise = 0;
    this.dealerIdx = 0;
    this.turnIdx = -1;
    this.actionOn = -1;
    this.roundNum = 0;
    this.actionTimer = null;
  }

  addPlayer(user) {
    if (this.players.length>=6) return false;
    if (this.players.find(p=>p.id===user.id)) return false;
    this.players.push({...user,hole:[],chips:Math.min(1000,user.coins||500),betTotal:0,roundBet:0,folded:false,allIn:false,acted:false,seat:this.players.length,handResult:null,won:0});
    return true;
  }

  removePlayer(userId) {
    this.clearTimer();
    const p = this.players.find(pl=>pl.id===userId);
    if (!p) return;
    if (this.phase === 'waiting' || this.phase === 'settle') {
      const idx = this.players.indexOf(p);
      this.players.splice(idx, 1);
    } else {
      p.folded = true;
      p.acted = true;
    }
    if (this.players.length === 0) this.phase = 'waiting';
  }

  canStart() { return this.players.length>=2&&this.phase==='waiting'; }

  start() {
    if (!this.canStart()) return false;
    this.roundNum++;
    // Reset players
    for (const p of this.players) {
      p.hole=[]; p.betTotal=0; p.roundBet=0; p.folded=false; p.allIn=false; p.acted=false;
      p.handResult=null; p.won=0; p.chips=Math.min(1000,p.chips);
    }
    this.community=[]; this.pots=[]; this.currentBet=0; this.lastRaise=0; this.phase='preflop';

    // Rotate dealer
    if (this.roundNum>1) this.dealerIdx=(this.dealerIdx+1)%this.players.length;

    // Deal
    this.deck = shuffle(createDeck());
    for (let i=0;i<2;i++) for (const p of this.players) p.hole.push(this.deck.pop());

    // Blinds (heads-up: dealer=SB, others: dealer+1=SB)
    const n = this.players.length;
    let sbIdx, bbIdx;
    if (n === 2) {
      sbIdx = this.dealerIdx;
      bbIdx = (this.dealerIdx + 1) % n;
    } else {
      sbIdx = (this.dealerIdx + 1) % n;
      bbIdx = (this.dealerIdx + 2) % n;
    }
    this.postBlind(this.players[sbIdx], this.sb);
    this.postBlind(this.players[bbIdx], this.bb);
    this.players[sbIdx].acted = true; // SB's blind counts as their preflop action
    this.currentBet = this.bb;
    this.minRaise = this.bb;

    // Action starts to left of BB (UTG)
    const utgIdx = (bbIdx+1)%n;
    this.turnIdx = utgIdx;
    this.actionOn = this.players[this.turnIdx].id;
    this.setTimer();
    return true;
  }

  postBlind(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.betTotal += a; p.roundBet += a;
    if (p.chips===0) p.allIn=true;
  }

  clearTimer() {
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null; }
  }

  setTimer() {
    this.clearTimer();
    const p = this.players.find(pl => pl.id === this.actionOn);
    if (!p) return;
    this.actionTimer = setTimeout(() => {
      p.folded = true; p.acted = true;
      this.clearTimer();
      this.afterAction();
      if (this._notifyUpdate) this._notifyUpdate();
    }, ACTION_TIMEOUT_MS);
  }

  nextActingPlayer(fromIdx) {
    if (fromIdx === undefined) fromIdx = this.turnIdx;
    const n = this.players.length;
    for (let i=1;i<=n;i++) {
      const idx = (fromIdx+i)%n;
      const p = this.players[idx];
      if (!p.folded && !p.allIn) return idx;
    }
    return -1;
  }

  getActivePlayers() { return this.players.filter(p=>!p.folded); }

  getBettingPlayers() { return this.players.filter(p=>!p.folded&&!p.allIn); }

  getRoundBet(playerId) {
    const p = this.players.find(pl=>pl.id===playerId);
    return p ? p.roundBet : 0;
  }

  canCheck(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    return p && !p.folded && !p.allIn && p.roundBet === this.currentBet;
  }

  canCall(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    return p && !p.folded && !p.allIn && p.roundBet < this.currentBet;
  }

  canRaise(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    return p && !p.folded && !p.allIn && p.chips + p.roundBet > this.currentBet;
  }

  getCallAmount(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    if (!p) return 0;
    const needed = this.currentBet - p.roundBet;
    return Math.min(p.chips, needed);
  }

  calcSidePots() {
    const all = this.players;
    const nonFolded = all.filter(p=>!p.folded);
    const allInSorted = [...all].filter(p=>p.allIn).sort((a,b)=>a.betTotal-b.betTotal);
    this.pots = [];
    let prevTotal = 0;
    for (const ap of allInSorted) {
      const slice = ap.betTotal - prevTotal;
      if (slice <= 0) continue;
      const count = all.filter(p => p.betTotal >= ap.betTotal).length;
      const eligible = nonFolded.filter(p => p.betTotal >= ap.betTotal);
      this.pots.push({amount: slice * count, eligible: eligible.map(p=>p.id)});
      prevTotal = ap.betTotal;
    }
    const mainEligible = nonFolded.filter(p => !p.allIn || p.betTotal > prevTotal);
    if (mainEligible.length > 0) {
      const extra = all.reduce((s, p) => s + Math.max(0, p.betTotal - prevTotal), 0);
      this.pots.push({amount: extra, eligible: mainEligible.map(p=>p.id)});
    }
  }

  goToShowdown() {
    // Deal remaining community cards
    for (let i = this.community.length; i < 5 && this.deck.length > 0; i++) {
      this.community.push(this.deck.pop());
    }
    this.phase='showdown';
    this.calcSidePots();

    // Evaluate non-folded hands using pokersolver
    const hands = {};
    for (const p of this.players) {
      if (!p.folded) {
        hands[p.id] = Hand.solve([...p.hole, ...this.community]);
      }
    }

    // Distribute each pot
    for (const pot of this.pots) {
      const candidates = pot.eligible.map(id=>this.players.find(p=>p.id===id)).filter(p=>p&&!p.folded);
      if (candidates.length===0) continue;
      const hList = candidates.map(p=>hands[p.id]).filter(Boolean);
      if (hList.length===0) continue;
      const winners = Hand.winners(hList);
      const winnerPlayers = candidates.filter(p => winners.some(w => w===hands[p.id]));
      if (winnerPlayers.length===0) continue;
      const share = Math.floor(pot.amount / winnerPlayers.length);
      for (const wp of winnerPlayers) { wp.chips += share; wp.won += share; }
      winnerPlayers[0].chips += pot.amount - share * winnerPlayers.length;
    }

    // Attach readable hand name per player
    for (const p of this.players) if (!p.folded && hands[p.id]) p.handResult = hands[p.id];
  }

  // Called after each action, timer expiry, or round advancement
  afterAction() {
    const bettors = this.getBettingPlayers();

    // If one player remains (others folded/all-in), they win
    if (bettors.length === 1) {
      const winner = bettors[0];
      const total = this.players.reduce((s,p)=>s+p.betTotal,0);
      winner.chips += total; winner.won = total;
      this.phase = 'showdown';
      return;
    }

    // If zero betting players (everyone all-in), go to showdown
    if (bettors.length === 0) {
      this.goToShowdown();
      return;
    }

    // Check if everyone has acted and bets are equal (using roundBet vs currentBet)
    let roundComplete = true;
    for (const p of bettors) {
      if (!p.acted) { roundComplete = false; break; }
    }
    if (roundComplete) {
      // All acted, check if all have matched currentBet
      for (const p of bettors) {
        if (p.roundBet !== this.currentBet) { roundComplete = false; break; }
      }
    }

    if (roundComplete) {
      this.advanceRound();
    } else {
      // Next player
      const nextIdx = this.nextActingPlayer();
      if (nextIdx === -1) { this.goToShowdown(); return; }
      this.turnIdx = nextIdx;
      this.actionOn = this.players[nextIdx].id;
      this.setTimer();
    }
  }

  advanceRound() {
    this.clearTimer();
    for (const p of this.players) { p.acted = false; p.roundBet = 0; }
    this.currentBet = 0;
    this.lastRaise = 0;
    this.minRaise = this.bb;

    const prev = this.phase;
    if (prev==='preflop') { this.phase='flop'; this.community.push(this.deck.pop(),this.deck.pop(),this.deck.pop()); }
    else if (prev==='flop') { this.phase='turn'; this.community.push(this.deck.pop()); }
    else if (prev==='turn') { this.phase='river'; this.community.push(this.deck.pop()); }
    else if (prev==='river') { this.goToShowdown(); return; }
    else return;

    const bettors = this.getBettingPlayers();
    if (bettors.length <= 1) { this.goToShowdown(); return; }

    // First active player after dealer starts
    const n = this.players.length;
    let startIdx = (this.dealerIdx+1)%n;
    while (this.players[startIdx].folded||this.players[startIdx].allIn) startIdx=(startIdx+1)%n;
    this.turnIdx = startIdx;
    this.actionOn = this.players[startIdx].id;
    this.setTimer();
  }

  goToSettle() {
    this.phase = 'settle';
    this.clearTimer();
    this.actionOn = -1;
  }
}



// === Poker Room Manager ===
const pokerRooms = new Map();

function getPokerRoom(roomId) { return pokerRooms.get(roomId); }
function generateRoomCode() {
  let code;
  do { code = Math.floor(1000+Math.random()*9000).toString(); } while (pokerRooms.has(code));
  return code;
}
function getRoomForUser(userId) {
  for (const [id, room] of pokerRooms) if (room.players.find(p=>p.id===userId)||room.spectators.includes(userId)) return room;
  return null;
}

// === Chess Room Manager ===
const chessRooms = new Map();
function generateChessCode() {
  let code;
  do { code = Math.floor(1000+Math.random()*9000).toString(); } while (chessRooms.has(code));
  return code;
}
function getChessRoomForUser(userId) {
  for (const [id, room] of chessRooms) if (room.players.find(p=>p.id===userId)||room.spectators.includes(userId)) return room;
  return null;
}

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
    return res.sendFile(path.join(__dirname, 'public', 'app.html'));
  }
  next();
});

async function handlePokerPhaseEnd(game, io) {
  if (game.phase === 'showdown') {
    for (const pl of game.players) {
      await db.updateUserCoins(pl.id, Math.min(1000, pl.chips));
    }
    game.goToSettle();
    const zeroPlayers = game.players.filter(pl => pl.chips <= 0);
    for (const zp of zeroPlayers) {
      io.to(`user:${zp.id}`).emit('poker kicked', '金币耗尽，已退出房间');
      game.removePlayer(zp.id);
    }
    broadcastGame(game);
    setTimeout(() => {
      if (game.phase !== 'settle') return;
      if (game.players.length >= 2) {
        game.phase = 'waiting';
        for (const pl of game.players) { pl.acted = false; pl.folded = false; pl.allIn = false; pl.betTotal = 0; pl.roundBet = 0; pl.hole = []; pl.handResult = null; pl.won = 0; }
        game.community = []; game.pots = []; game.currentBet = 0; game.actionOn = -1;
        broadcastGame(game);
      } else {
        io.to('poker_' + game.roomId).emit('poker msg', '玩家不足，房间关闭');
        game.clearTimer();
        pokerRooms.delete(game.roomId);
      }
    }, 5000);
  }
}

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

  // === Poker Socket Events ===
  socket.on('poker create', async (opts, cb) => {
    if (getRoomForUser(userId)) return cb({error:'已在房间中'});
    const code = generateRoomCode();
    const game = new PokerGame(code, userId, opts||{});
    game.addPlayer({id:userId, username:username, uid:socket.request.session.userId, coins: (await db.getUserById(userId)).coins||500});
    pokerRooms.set(code, game);
    game._notifyUpdate = () => { broadcastGame(game); handlePokerPhaseEnd(game, io).catch(e => console.error('Poker phase end error:', e)); };
    socket.join('poker_'+code);
    cb({roomId:code, game:serializeGame(game, userId)});
  });

  socket.on('poker list', (cb) => {
    const rooms = [];
    for (const [id, g] of pokerRooms) {
      if (g.phase==='waiting') rooms.push({roomId:id, players:g.players.length, host:g.hostId===userId, sb:g.sb, bb:g.bb, hostName:g.players[0]?.username});
    }
    cb({rooms});
  });

  socket.on('poker join', async ({roomId}, cb) => {
    if (getRoomForUser(userId)) return cb({error:'已在房间中'});
    const game = pokerRooms.get(roomId);
    if (!game) return cb({error:'房间不存在'});
    if (game.phase!=='waiting') return cb({error:'游戏已开始'});
    const u = await db.getUserById(userId);
    if (!game.addPlayer({id:userId, username, uid:u.uid, coins: u.coins||500})) return cb({error:'加入失败'});
    socket.join('poker_'+roomId);
    broadcastGame(game);
    cb({roomId, game:serializeGame(game, userId)});
  });

  socket.on('poker leave', async (cb) => {
    const game = getRoomForUser(userId);
    if (!game) return;
    const p = game.players.find(pl=>pl.id===userId);
    // Only save chips during idle phases; mid-hand chips synced at showdown
    if ((game.phase==='settle'||game.phase==='waiting') && p) {
      await db.updateUserCoins(userId, Math.min(1000, p.chips));
    }
    game.removePlayer(userId);
    socket.leave('poker_'+game.roomId);
    if (game.players.length===0) { game.clearTimer(); pokerRooms.delete(game.roomId); }
    else broadcastGame(game);
    if (cb) cb({ok:true});
  });

  socket.on('poker start', async (cb) => {
    const game = getRoomForUser(userId);
    if (!game) return cb({error:'不在房间中'});
    if (game.hostId!==userId) return cb({error:'只有房主可以开始'});
    // Sync chips from DB first, then start posts blinds from correct amounts
    for (const p of game.players) {
      const userData = await db.getUserById(p.id);
      if (userData) { p.chips = Math.min(1000, userData.coins||500); }
    }
    if (!game.start()) return cb({error:'至少需要2名玩家'});
    broadcastGame(game);
    if (cb) cb({ok:true});
  });

  function performAction(game, userId, action, amount) {
    const p = game.players.find(pl=>pl.id===userId);
    if (!p||p.folded||p.allIn) return '无效操作';

    game.clearTimer();

    if (action==='fold') { p.folded=true; p.acted=true; }
    else if (action==='check') {
      if (!game.canCheck(userId)) return '不能让牌';
      p.acted=true;
    }
    else if (action==='call') {
      const callAmt = game.currentBet - p.roundBet;
      const a = Math.min(p.chips, callAmt);
      p.chips-=a; p.betTotal+=a; p.roundBet+=a; p.acted=true;
      if (p.chips===0) p.allIn=true;
    }
    else if (action==='raise'||action==='bet') {
      let total = parseInt(amount);
      if (isNaN(total)||total<0) return '无效金额';
      if (action==='bet'&&game.currentBet>0) return '已有下注，请使用加注';
      if (action==='raise'&&game.currentBet===0) return '无人下注，请使用下注';
      const minTotal = game.currentBet + Math.max(game.minRaise, game.bb);
      if (total < minTotal && total < p.chips + p.roundBet) return `最少需下注 ${minTotal}`;
      total = Math.min(total, p.chips + p.roundBet);
      const delta = total - p.roundBet;
      if (delta > p.chips) return '筹码不足';
      p.chips-=delta; p.betTotal+=delta; p.roundBet=total; p.acted=true;
      game.lastRaise = total - game.currentBet;
      game.minRaise = Math.max(game.minRaise, game.lastRaise);
      game.currentBet = total;
      if (p.chips===0) p.allIn=true;
    }
    else if (action==='allin') {
      const total = p.chips + p.roundBet;
      p.chips=0; p.betTotal+= (total - p.roundBet); p.roundBet=total; p.allIn=true; p.acted=true;
      if (total > game.currentBet) { game.lastRaise = total - game.currentBet; game.minRaise = Math.max(game.minRaise, game.lastRaise); game.currentBet = total; }
    }
    else return '未知操作';

    game.afterAction();
    return null;
  }

  socket.on('poker action', async ({action, amount}, cb) => {
    const game = getRoomForUser(userId);
    if (!game) return cb({error:'不在房间中'});
    if (game.actionOn!==userId) return cb({error:'还没轮到你'});
    const err = performAction(game, userId, action, amount);
    if (err) return cb({error:err});

    broadcastGame(game);
    await handlePokerPhaseEnd(game, io);
    if (cb) cb({ok:true});
  });

  // === Chess Socket Events ===
  function broadcastChess(game) {
    for (const p of game.players) {
      io.to(`user:${p.id}`).emit('chess update', game.getState(p.id));
    }
  }

  socket.on('chess create', (cb) => {
    if (getChessRoomForUser(userId)) return cb({error:'已在房间中'});
    const code = generateChessCode();
    const game = new ChineseChessGame(code, userId);
    game.addPlayer({id:userId, username});
    chessRooms.set(code, game);
    socket.join('chess_'+code);
    cb({roomId:code, game:game.getState(userId)});
  });

  socket.on('chess list', (cb) => {
    const rooms = [];
    for (const [id, g] of chessRooms) {
      if (g.phase==='waiting') rooms.push({roomId:id, players:g.players.length, host:g.hostId===userId});
    }
    cb({rooms});
  });

  socket.on('chess join', ({roomId}, cb) => {
    if (getChessRoomForUser(userId)) return cb({error:'已在房间中'});
    const game = chessRooms.get(roomId);
    if (!game) return cb({error:'房间不存在'});
    if (game.phase!=='waiting') return cb({error:'游戏已开始'});
    if (!game.addPlayer({id:userId, username})) return cb({error:'加入失败'});
    socket.join('chess_'+roomId);
    broadcastChess(game);
    cb({roomId, game:game.getState(userId)});
  });

  socket.on('chess leave', (cb) => {
    const game = getChessRoomForUser(userId);
    if (!game) return;
    game.removePlayer(userId);
    socket.leave('chess_'+game.roomId);
    if (game.players.length===0) chessRooms.delete(game.roomId);
    else broadcastChess(game);
    if (cb) cb({ok:true});
  });

  socket.on('chess start', (cb) => {
    const game = getChessRoomForUser(userId);
    if (!game) return cb({error:'不在房间中'});
    if (game.hostId!==userId) return cb({error:'只有房主可以开始'});
    if (!game.start()) return cb({error:'需要2名玩家'});
    broadcastChess(game);
    if (cb) cb({ok:true});
  });

  socket.on('chess select', ({r, c}, cb) => {
    const game = getChessRoomForUser(userId);
    if (!game || game.phase!=='playing') return;
    const p = game.players.find(pl => pl.id === userId);
    if (!p || game.turn !== p.color) return;
    game.selectPiece(r, c);
    io.to(`user:${userId}`).emit('chess update', game.getState(userId));
    if (cb) cb({ok:true});
  });

  socket.on('chess move', ({fromR, fromC, toR, toC}, cb) => {
    const game = getChessRoomForUser(userId);
    if (!game) return cb({error:'不在房间中'});
    const err = game.makeMove(fromR, fromC, toR, toC);
    if (err) return cb({error:err});
    broadcastChess(game);
    if (cb) cb({ok:true});
  });

  socket.on('chess resign', (cb) => {
    const game = getChessRoomForUser(userId);
    if (!game) return;
    game.resign(userId);
    broadcastChess(game);
    if (cb) cb({ok:true});
  });

  socket.on('disconnect', async () => {
    console.log(`${username} 断开: ${socket.id}`);
    const game = getRoomForUser(userId);
    if (game) {
      game.clearTimer();
      const p = game.players.find(pl=>pl.id===userId);
      if (p && (game.phase==='settle'||game.phase==='waiting')) {
        await db.updateUserCoins(userId, Math.min(1000, p.chips));
      }
      game.removePlayer(userId);
      if (game.players.length===0) { game.clearTimer(); pokerRooms.delete(game.roomId); }
      else broadcastGame(game);
    }
    // Chess room cleanup
    const chessGame = getChessRoomForUser(userId);
    if (chessGame) {
      chessGame.removePlayer(userId);
      socket.leave('chess_'+chessGame.roomId);
      if (chessGame.players.length===0) chessRooms.delete(chessGame.roomId);
      else broadcastChess(chessGame);
    }
    if (isGuest && guestSockets[userId]) {
      guestSockets[userId].delete(socket.id);
      if (guestSockets[userId].size === 0) {
        delete guestSockets[userId];
        db.deleteUser(userId);
      }
    }
  });
});

function broadcastGame(game) {
  for (const p of game.players) {
    io.to(`user:${p.id}`).emit('poker update', serializeGame(game, p.id));
  }
}

function serializeGame(game, viewerId) {
  const pdata = game.players.map(p => ({
    id: p.id, username: p.username, seat: p.seat, chips: p.chips, betTotal: p.betTotal,
    roundBet: game.phase!=='waiting'?p.roundBet:0,
    folded: p.folded, allIn: p.allIn, acted: p.acted,
    isViewer: p.id===viewerId,
    hole: p.id===viewerId ? p.hole : (game.phase==='showdown'||game.phase==='settle'?p.hole:[]),
    handName: (game.phase==='showdown'||game.phase==='settle')&&!p.folded&&p.handResult ? p.handResult.name : null,
    won: p.won||0,
  }));
  const isPlaying = game.players.some(p=>p.id===viewerId);
  return {
    roomId: game.roomId, hostId: game.hostId,
    phase: game.phase,
    players: pdata,
    community: game.community,
    pots: game.pots,
    currentBet: game.currentBet,
    minRaise: game.minRaise,
    actionOn: isPlaying?game.actionOn:null,
    sb: game.sb, bb: game.bb,
    dealerIdx: game.dealerIdx,
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
});
