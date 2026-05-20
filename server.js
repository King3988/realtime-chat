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

const RANK_STR = '..23456789TJQKA';
const HAND_NAMES = ['','高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺','皇家同花顺'];

function pRank(c) { return RANK_STR.indexOf(c[0]); }
function pSuit(c) { return c[1]; }

function handScore(type, ranks) {
  return type * 1e10 + (ranks[0]||0)*1e8 + (ranks[1]||0)*1e6 + (ranks[2]||0)*1e4 + (ranks[3]||0)*1e2 + (ranks[4]||0);
}

function eval5(cards) {
  const rks = cards.map(pRank).sort((a,b)=>b-a);
  const flush = cards.every(c=>c[1]===cards[0][1]);
  const uniq = [...new Set(rks)].sort((a,b)=>b-a);
  let straight = false, sh = 0;
  if (uniq.length===5 && uniq[0]-uniq[4]===4) { straight=true; sh=uniq[0]; }
  if (uniq[0]===14 && uniq[1]===5 && uniq[2]===4 && uniq[3]===3 && uniq[4]===2) { straight=true; sh=5; }
  const cnt = {}; rks.forEach(r=>cnt[r]=(cnt[r]||0)+1);
  const grp = Object.entries(cnt).map(([r,c])=>({r:+r,c})).sort((a,b)=>b.c-a.c||b.r-a.r);

  if (flush && straight) return sh===14?{n:10,sc:1000,na:'皇家同花顺'}:{n:9,sc:900+sh,na:'同花顺'};
  if (grp[0].c===4) return {n:8,sc:800+grp[0].r*15+grp[1].r,na:'四条'};
  if (grp[0].c===3&&grp[1].c===2) return {n:7,sc:700+grp[0].r*15+grp[1].r,na:'葫芦'};
  if (flush) return {n:6,sc:handScore(6,rks),na:'同花'};
  if (straight) return {n:5,sc:500+sh,na:'顺子'};
  if (grp[0].c===3) return {n:4,sc:400+grp[0].r*15+grp[1].r*10+grp[2].r,na:'三条'};
  if (grp[0].c===2&&grp[1].c===2) return {n:3,sc:300+grp[0].r*15+grp[1].r*10+grp[2].r,na:'两对'};
  if (grp[0].c===2) return {n:2,sc:200+grp[0].r*100+grp[1].r*10+grp[2].r,na:'一对'};
  return {n:1,sc:handScore(1,rks),na:'高牌'};
}

function bestHand(hole, community) {
  const all = [...hole,...community]; let best = null;
  for (let a=0;a<all.length;a++) for (let b=a+1;b<all.length;b++) for (let c=b+1;c<all.length;c++)
    for (let d=c+1;d<all.length;d++) for (let e=d+1;e<all.length;e++) {
      const h = eval5([all[a],all[b],all[c],all[d],all[e]]);
      if (!best||h.sc>best.sc) best = h;
    }
  return best;
}

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
    this.phase = 'waiting'; // waiting|preflop|flop|turn|river|showdown
    this.pots = [];
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.lastRaise = 0;
    this.dealerIdx = 0;
    this.turnIdx = -1;
    this.betStartIdx = -1;
    this.actionOn = -1;
    this.dealCount = 0;
  }
  addPlayer(user) {
    if (this.players.length>=6) return false;
    if (this.players.find(p=>p.id===user.id)) return false;
    this.players.push({...user,hole:[],chips:Math.min(1000,user.coins||500),betTotal:0,folded:false,allIn:false,acted:false,seat:this.players.length});
    return true;
  }
  removePlayer(userId) {
    const idx = this.players.findIndex(p=>p.id===userId);
    if (idx===-1) return;
    this.players.splice(idx,1);
    if (this.players.length===0) this.phase='waiting';
  }
  canStart() { return this.players.length>=2&&this.phase==='waiting'; }
  start() {
    if (!this.canStart()) return false;
    this.dealCount++;
    // Reset players
    for (const p of this.players) { p.hole=[]; p.betTotal=0; p.folded=false; p.allIn=false; p.acted=false; p.chips=Math.min(1000,p.chips); }
    this.community=[]; this.pots=[]; this.currentBet=0; this.lastRaise=0; this.phase='preflop';

    // Rotate dealer
    if (this.dealCount>1) this.dealerIdx=(this.dealerIdx+1)%this.players.length;

    // Deal
    this.deck = shuffle(createDeck());
    for (let i=0;i<2;i++) for (const p of this.players) p.hole.push(this.deck.pop());

    // Blinds
    const active = this.players.filter(p=>!p.folded);
    const sbIdx = (this.dealerIdx+1)%active.length;
    const bbIdx = (this.dealerIdx+2)%active.length;
    this.postBlind(active[sbIdx], this.sb);
    this.postBlind(active[bbIdx], this.bb);
    active[sbIdx].acted = true; // SB's blind counts as their preflop action
    // BB stays acted=false so they get the option when action returns
    this.currentBet = this.bb;
    this.minRaise = this.bb;

    // Action starts to the left of BB (UTG)
    this.betStartIdx = (bbIdx+1)%active.length;
    this.turnIdx = this.betStartIdx;
    this.actionOn = active[this.turnIdx].id;
    return true;
  }
  postBlind(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.betTotal += a;
    if (p.chips===0) p.allIn=true;
  }
  nextActive(fromIdx) {
    const active = this.players.filter(p=>!p.folded&&!p.allIn);
    for (let i=1;i<=active.length;i++) {
      const p = active[(fromIdx+i)%active.length];
      if (!p.folded&&!p.allIn) return this.players.indexOf(p);
    }
    return -1;
  }
  getActivePlayers() { return this.players.filter(p=>!p.folded); }
  getBettingPlayers() { return this.players.filter(p=>!p.folded&&!p.allIn); }

  advanceRound() {
    if (this.phase==='preflop') { this.phase='flop'; this.community.push(this.deck.pop(),this.deck.pop(),this.deck.pop()); }
    else if (this.phase==='flop') { this.phase='turn'; this.community.push(this.deck.pop()); }
    else if (this.phase==='turn') { this.phase='river'; this.community.push(this.deck.pop()); }
    else return;
    for (const p of this.players) p.acted=false;
    this.currentBet = 0;
    this.lastRaise = 0;
    this.minRaise = this.bb;
    const active = this.getBettingPlayers();
    if (active.length<=1) { this.goToShowdown(); return; }
    // Action starts from first active player after dealer
    const dealerP = this.players[this.dealerIdx];
    let startIdx = (this.players.indexOf(dealerP)+1)%this.players.length;
    while (this.players[startIdx].folded||this.players[startIdx].allIn) startIdx=(startIdx+1)%this.players.length;
    this.betStartIdx = startIdx;
    this.turnIdx = startIdx;
    this.actionOn = this.players[startIdx].id;
  }

  canCheck(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    return p && !p.folded && !p.allIn && p.betTotal === this.currentBet;
  }
  canCall(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    return p && !p.folded && !p.allIn && p.betTotal < this.currentBet;
  }
  canRaise(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    return p && !p.folded && !p.allIn && p.chips + p.betTotal > this.currentBet;
  }
  getCallAmount(userId) {
    const p = this.players.find(pl=>pl.id===userId);
    return p ? Math.min(p.chips, this.currentBet - p.betTotal) : 0;
  }

  calcSidePots() {
    const involved = this.players.filter(p=>!p.folded);
    const sorted = [...involved].filter(p=>p.allIn).sort((a,b)=>a.betTotal-b.betTotal);
    this.pots = [];
    let prevTotal = 0;
    for (const ap of sorted) {
      const slice = ap.betTotal - prevTotal;
      if (slice<=0) continue;
      const eligible = involved.filter(p=>p.betTotal>=ap.betTotal);
      this.pots.push({amount:slice*eligible.length, eligible: eligible.map(p=>p.id)});
      prevTotal = ap.betTotal;
    }
    // Main pot for remaining
    const remaining = involved.filter(p=>!p.allIn||p.betTotal>prevTotal);
    if (remaining.length>0) {
      const extra = remaining.reduce((s,p)=>s+(p.betTotal-prevTotal),0);
      this.pots.push({amount:extra, eligible: remaining.map(p=>p.id)});
    }
  }

  goToShowdown() {
    this.phase='showdown';
    this.calcSidePots();
    // Evaluate all non-folded hands
    for (const p of this.players) {
      if (!p.folded) p.handResult = bestHand(p.hole, this.community);
    }
    // Distribute pots
    for (const pot of this.pots) {
      const candidates = pot.eligible.map(id=>this.players.find(p=>p.id===id)).filter(Boolean);
      let best = null, winners = [];
      for (const p of candidates) {
        if (!p.handResult) continue;
        if (!best||p.handResult.sc>best.sc) { best=p.handResult; winners=[p]; }
        else if (p.handResult.sc===best.sc) winners.push(p);
      }
      const share = Math.floor(pot.amount/winners.length);
      for (const w of winners) { w.chips += share; w.wonPot = (w.wonPot||0)+share; }
      // Remainder to first winner
      if (winners.length>0) winners[0].chips += pot.amount - share*winners.length;
    }
  }

  checkRoundComplete() {
    const bettors = this.getBettingPlayers();
    if (bettors.length===0) { this.goToShowdown(); return true; }
    if (bettors.length===1) { // Everyone else folded or all-in
      const winner = bettors[0];
      const total = this.players.reduce((s,p)=>s+p.betTotal,0);
      winner.chips += total;
      winner.wonPot = total;
      this.phase='showdown';
      return true;
    }
    // Check if all non-all-in players have acted and bets equal
    for (const p of bettors) if (!p.acted || p.betTotal!==this.currentBet) return false;
    return true;
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

  // === Poker Socket Events ===
  socket.on('poker create', async (opts, cb) => {
    if (getRoomForUser(userId)) return cb({error:'已在房间中'});
    const code = generateRoomCode();
    const game = new PokerGame(code, userId, opts||{});
    game.addPlayer({id:userId, username:username, uid:socket.request.session.userId, coins: (await db.getUserById(userId)).coins||500});
    pokerRooms.set(code, game);
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
    if (p) await db.updateUserCoins(userId, Math.min(1000, p.chips));
    game.removePlayer(userId);
    socket.leave('poker_'+game.roomId);
    if (game.players.length===0) pokerRooms.delete(game.roomId);
    else broadcastGame(game);
    if (cb) cb({ok:true});
  });

  socket.on('poker start', async (cb) => {
    const game = getRoomForUser(userId);
    if (!game) return cb({error:'不在房间中'});
    if (game.hostId!==userId) return cb({error:'只有房主可以开始'});
    if (!game.start()) return cb({error:'至少需要2名玩家'});
    // Deduct blinds from DB for anti-cheat
    for (const p of game.players) {
      const userData = await db.getUserById(p.id);
      if (userData) { p.chips = Math.min(1000, userData.coins||500); }
    }
    broadcastGame(game);
    if (cb) cb({ok:true});
  });

  socket.on('poker action', async ({action, amount}, cb) => {
    const game = getRoomForUser(userId);
    if (!game) return cb({error:'不在房间中'});
    if (game.actionOn!==userId) return cb({error:'还没轮到你'});
    const p = game.players.find(pl=>pl.id===userId);
    if (!p||p.folded||p.allIn) return cb({error:'无效操作'});

    const callAmt = game.currentBet - p.betTotal;
    if (action==='fold') { p.folded=true; p.acted=true; }
    else if (action==='check') { if (!game.canCheck(userId)) return cb({error:'不能让牌'}); p.acted=true; }
    else if (action==='call') {
      const a = Math.min(p.chips, callAmt);
      p.chips-=a; p.betTotal+=a; p.acted=true;
      if (p.chips===0) p.allIn=true;
    }
    else if (action==='raise'||action==='bet') {
      let total = parseInt(amount);
      if (isNaN(total)||total<0) return cb({error:'无效金额'});
      if (action==='bet'&&game.currentBet>0) return cb({error:'已有下注，请使用加注'});
      if (action==='raise'&&game.currentBet===0) return cb({error:'无人下注，请使用下注'});
      const minTotal = game.currentBet + Math.max(game.minRaise, game.bb);
      if (total < minTotal && total < p.chips + p.betTotal) return cb({error:`最少需下注 ${minTotal}`});
      total = Math.min(total, p.chips + p.betTotal);
      const delta = total - p.betTotal;
      if (delta > p.chips) return cb({error:'筹码不足'});
      p.chips-=delta; p.betTotal=total; p.acted=true;
      game.lastRaise = total - game.currentBet;
      game.minRaise = Math.max(game.minRaise, game.lastRaise);
      game.currentBet = total;
      if (p.chips===0) p.allIn=true;
    }
    else if (action==='allin') {
      const total = p.chips + p.betTotal;
      p.chips=0; p.betTotal=total; p.allIn=true; p.acted=true;
      if (total > game.currentBet) { game.lastRaise = total - game.currentBet; game.minRaise = Math.max(game.minRaise, game.lastRaise); game.currentBet = total; }
    }
    else return cb({error:'未知操作'});

    // Check round completion
    if (game.checkRoundComplete()) {
      if (game.phase!=='showdown') game.advanceRound();
      broadcastGame(game);
      if (cb) cb({ok:true});
      return;
    }

    // Next turn
    const nextIdx = game.nextActive(game.turnIdx);
    if (nextIdx===-1) { game.advanceRound(); }
    else { game.turnIdx = nextIdx; game.actionOn = game.players[nextIdx].id; }
    broadcastGame(game);
    if (cb) cb({ok:true});
  });

  socket.on('disconnect', () => {
    console.log(`${username} 断开: ${socket.id}`);
    // Remove from poker room
    const game = getRoomForUser(userId);
    if (game) {
      game.removePlayer(userId);
      if (game.players.length===0) pokerRooms.delete(game.roomId);
      else broadcastGame(game);
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
    folded: p.folded, allIn: p.allIn, acted: p.acted,
    isViewer: p.id===viewerId,
    hole: p.id===viewerId ? p.hole : (game.phase==='showdown'?p.hole:[]),
    handName: game.phase==='showdown'&&!p.folded&&p.handResult ? p.handResult.na : null,
    wonPot: p.wonPot||0,
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
    actionOn: isPlaying ? game.actionOn : null,
    sb: game.sb, bb: game.bb,
    dealerIdx: game.dealerIdx,
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
});
