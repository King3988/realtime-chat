// Chinese Chess (Xiangqi) Engine

const PIECE_NAMES = {
  K:'帅', A:'仕', B:'相', N:'马', R:'车', C:'炮', P:'兵',
  k:'将', a:'士', b:'象', n:'馬', r:'車', c:'砲', p:'卒',
};

function colorOf(p) { return p && (p === p.toUpperCase() ? 'red' : 'black'); }

function isRed(p) { return p && p === p.toUpperCase(); }
function isBlack(p) { return p && p === p.toLowerCase(); }

function cloneBoard(board) { return board.map(r=>[...r]); }

function initialBoard() {
  const B = 'rnbakabnr';
  const b = Array(10).fill(null).map(()=>Array(9).fill(null));
  for (let i=0;i<9;i++) {
    b[0][i] = B[i];           // black back rank
    b[9][i] = B[i].toUpperCase(); // red back rank
  }
  b[2][1] = b[2][7] = 'c';    // black cannons
  b[7][1] = b[7][7] = 'C';    // red cannons
  for (let i=0;i<9;i+=2) {
    b[3][i] = 'p';             // black pawns
    b[6][i] = 'P';             // red pawns
  }
  return b;
}

function inBoard(r,c) { return r>=0 && r<=9 && c>=0 && c<=8; }

function inPalace(r,c,color) {
  if (c<3||c>5) return false;
  return color==='red' ? (r>=7&&r<=9) : (r>=0&&r<=2);
}

function inOwnHalf(r,color) {
  return color==='red' ? r>=5 : r<=4;
}

// Generate raw moves for a piece at (r,c) on board (no check filter)
function rawMoves(board, r, c) {
  const p = board[r][c];
  if (!p) return [];
  const col = colorOf(p);
  const type = p.toUpperCase();
  const moves = [];

  function addIf(r2,c2) {
    if (!inBoard(r2,c2)) return;
    const t = board[r2][c2];
    if (t && colorOf(t)===col) return;
    moves.push([r2,c2]);
  }

  if (type === 'K') { // General
    for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const r2=r+dr, c2=c+dc;
      if (inPalace(r2,c2,col)) addIf(r2,c2);
    }
    // Flying general: can capture opposing general if on same column with no pieces between
    const dir = col==='red' ? -1 : 1;
    let rr=r+dir, cc=c;
    while (inBoard(rr,cc)) {
      const t = board[rr][cc];
      if (t) {
        if (t.toUpperCase()==='K' && colorOf(t)!==col) moves.push([rr,cc]);
        break;
      }
      rr += dir;
    }
  } else if (type === 'A') { // Advisor
    for (const [dr,dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const r2=r+dr, c2=c+dc;
      if (inPalace(r2,c2,col)) addIf(r2,c2);
    }
  } else if (type === 'B') { // Elephant
    for (const [dr,dc] of [[2,2],[2,-2],[-2,2],[-2,-2]]) {
      const r2=r+dr, c2=c+dc;
      const eyeR=r+dr/2, eyeC=c+dc/2;
      if (!inBoard(r2,c2)) continue;
      if (!inOwnHalf(r2,col)) continue; // Cannot cross river
      if (board[eyeR][eyeC]) continue; // Eye blocked
      addIf(r2,c2);
    }
  } else if (type === 'N') { // Horse
    for (const [dr,dc,legR,legC] of [[-2,-1,-1,0],[-2,1,-1,0],[2,-1,1,0],[2,1,1,0],[-1,-2,0,-1],[-1,2,0,1],[1,-2,0,-1],[1,2,0,1]]) {
      const r2=r+dr, c2=c+dc;
      if (!inBoard(r2,c2)) continue;
      if (board[r+legR][c+legC]) continue; // Leg blocked
      addIf(r2,c2);
    }
  } else if (type === 'R') { // Chariot
    for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      let rr=r+dr, cc=c+dc;
      while (inBoard(rr,cc)) {
        const t = board[rr][cc];
        if (t) {
          if (colorOf(t)!==col) moves.push([rr,cc]);
          break;
        }
        moves.push([rr,cc]);
        rr+=dr; cc+=dc;
      }
    }
  } else if (type === 'C') { // Cannon
    for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      let rr=r+dr, cc=c+dc;
      let foundScreen = false;
      while (inBoard(rr,cc)) {
        const t = board[rr][cc];
        if (!foundScreen) {
          if (t) { foundScreen=true; }
          else { moves.push([rr,cc]); }
        } else {
          if (t) {
            if (colorOf(t)!==col) moves.push([rr,cc]);
            break;
          }
        }
        rr+=dr; cc+=dc;
      }
    }
  } else if (type === 'P') { // Soldier
    const forward = col==='red' ? -1 : 1;
    const crossed = !inOwnHalf(r,col);
    addIf(r+forward,c);
    if (crossed) { addIf(r,c-1); addIf(r,c+1); }
  }

  return moves;
}

// Check if the given color's general is in check
function inCheck(board, color) {
  // Find general
  let gr=-1,gc=-1;
  const generalChar = color==='red' ? 'K' : 'k';
  for (let r=0;r<10;r++) for (let c=0;c<9;c++) {
    if (board[r][c]===generalChar) { gr=r; gc=c; break; }
  }
  if (gr===-1) return true; // General captured = in check

  const opp = color==='red' ? 'black' : 'red';
  // Check if any opponent piece can capture the general
  for (let r=0;r<10;r++) for (let c=0;c<9;c++) {
    const p = board[r][c];
    if (!p || colorOf(p)!==opp) continue;
    const m = rawMoves(board,r,c);
    for (const [mr,mc] of m) {
      if (mr===gr && mc===gc) return true;
    }
  }
  return false;
}

class ChineseChessGame {
  constructor(roomId, hostId) {
    this.roomId = roomId;
    this.hostId = hostId;
    this.board = initialBoard();
    this.players = []; // {id, username, color}
    this.spectators = [];
    this.turn = 'red'; // red moves first
    this.phase = 'waiting'; // waiting|playing|red_wins|black_wins|draw
    this.moveHistory = [];
    this.selected = null; // [r,c] of selected piece
    this.legalMoves = []; // [[r,c],...]
  }

  addPlayer(user) {
    if (this.players.length >= 2) return false;
    if (this.players.find(p => p.id === user.id)) return false;
    const color = this.players.length === 0 ? 'red' : 'black';
    this.players.push({...user, color});
    return true;
  }

  removePlayer(userId) {
    const idx = this.players.findIndex(p => p.id === userId);
    if (idx === -1) return;
    this.players.splice(idx, 1);
    if (this.players.length === 0) this.phase = 'waiting';
  }

  canStart() { return this.players.length === 2 && this.phase === 'waiting'; }

  start() {
    if (!this.canStart()) return false;
    this.board = initialBoard();
    this.turn = 'red';
    this.phase = 'playing';
    this.moveHistory = [];
    this.selected = null;
    this.legalMoves = [];
    return true;
  }

  // Generate legal moves for piece at (r,c), excluding moves that leave own general in check
  getLegalMoves(r, c) {
    const p = this.board[r][c];
    if (!p) return [];
    if (colorOf(p) !== this.turn) return [];
    const raw = rawMoves(this.board, r, c);
    const legal = [];
    for (const [rr,cc] of raw) {
      const sim = cloneBoard(this.board);
      sim[rr][cc] = sim[r][c];
      sim[r][c] = null;
      if (!inCheck(sim, this.turn)) legal.push([rr,cc]);
    }
    return legal;
  }

  // Make a move. Returns null if valid, error string if invalid.
  makeMove(fromR, fromC, toR, toC) {
    if (this.phase !== 'playing') return '游戏未开始';
    if (this.turn !== colorOf(this.board[fromR][fromC])) return '未轮到你走棋';
    const legal = this.getLegalMoves(fromR, fromC);
    if (!legal.some(([r,c]) => r===toR && c===toC)) return '不合法的走法';
    // Execute
    const captured = this.board[toR][toC];
    this.board[toR][toC] = this.board[fromR][fromC];
    this.board[fromR][fromC] = null;
    this.moveHistory.push({from:[fromR,fromC], to:[toR,toC], piece:this.board[toR][toC], captured});
    this.selected = null;
    this.legalMoves = [];
    // Check win
    const opp = this.turn === 'red' ? 'black' : 'red';
    if (captured && captured.toUpperCase() === 'K') {
      this.phase = this.turn === 'red' ? 'red_wins' : 'black_wins';
      return null;
    }
    // Check if opponent has any legal moves
    let oppHasMove = false;
    for (let r=0;r<10 && !oppHasMove;r++) for (let c=0;c<9 && !oppHasMove;c++) {
      if (this.board[r][c] && colorOf(this.board[r][c])===opp) {
        if (rawMoves(this.board,r,c).length > 0) oppHasMove = true;
      }
    }
    // Actually need check-filtered moves
    oppHasMove = false;
    for (let r=0;r<10 && !oppHasMove;r++) for (let c=0;c<9 && !oppHasMove;c++) {
      if (this.board[r][c] && colorOf(this.board[r][c])===opp) {
        const raw = rawMoves(this.board,r,c);
        for (const [rr,cc] of raw) {
          const sim = cloneBoard(this.board);
          sim[rr][cc] = sim[r][c];
          sim[r][c] = null;
          if (!inCheck(sim, opp)) { oppHasMove = true; break; }
        }
      }
    }
    if (!oppHasMove) {
      // Checkmate or stalemate
      if (inCheck(this.board, opp)) {
        this.phase = this.turn === 'red' ? 'red_wins' : 'black_wins';
      } else {
        this.phase = this.turn === 'red' ? 'red_wins' : 'black_wins'; // Stalemate = loss in Chinese chess
      }
      return null;
    }
    this.turn = opp;
    return null;
  }

  selectPiece(r, c) {
    if (this.phase !== 'playing') return;
    const p = this.board[r][c];
    if (!p || colorOf(p) !== this.turn) return;
    this.selected = [r, c];
    this.legalMoves = this.getLegalMoves(r, c);
  }

  clearSelection() {
    this.selected = null;
    this.legalMoves = [];
  }

  resign(userId) {
    const p = this.players.find(pl => pl.id === userId);
    if (!p || this.phase !== 'playing') return;
    this.phase = p.color === 'red' ? 'black_wins' : 'red_wins';
  }

  getState(userId) {
    const isPlaying = this.players.some(p => p.id === userId);
    const p = this.players.find(pl => pl.id === userId);
    return {
      roomId: this.roomId,
      hostId: this.hostId,
      phase: this.phase,
      turn: this.turn,
      board: this.board,
      players: this.players,
      myColor: p ? p.color : null,
      selected: isPlaying ? this.selected : null,
      legalMoves: isPlaying ? this.legalMoves : [],
      moveHistory: this.moveHistory.length,
    };
  }
}

module.exports = { ChineseChessGame, colorOf, PIECE_NAMES, inCheck, rawMoves, cloneBoard, initialBoard };
