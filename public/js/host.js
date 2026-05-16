// =====================================================================
// STONES OF FIVE — DEDICATED HOST (PeerJS, static / GitHub Pages)
// =====================================================================
// This runs fully in the browser — no server required.
// Players join by scanning the QR code or visiting the URL shown here.
// =====================================================================

// ── QR code helper ───────────────────────────────────────────────────
function showQrCode(url) {
  const img = document.getElementById('qr-img');
  if (!img) return;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  img.src = qr.createDataURL(4, 4);
}

function buildPlayerUrl(peerId) {
  if (window.SERVER_LAN_IP && window.SERVER_PORT) {
    return `http://${SERVER_LAN_IP}:${SERVER_PORT}/player.html?room=${peerId}`;
  }
  const base = new URL('player.html', location.href);
  base.searchParams.set('room', peerId);
  return base.toString();
}

// ── Game state ───────────────────────────────────────────────────────
let gs = createFreshGs();
let connections = new Map(); // playerId → DataConnection
let nextId = 1;
let botTimer = null;

function createFreshGs() {
  return {
    phase: 'lobby',
    board: null,
    players: [],   // [{id, name, avatar, stoneNumber, captures, connected, peerId, isBot}]
    currentTurnIndex: 0,
    moveNumber: 0,
    lastMove: null,
    lastCaptures: [],
    winner: null,
    hostPlayerId: null,
    botChallengeLevel: 3,
  };
}

function resetGs() {
  stopBotLoop();
  const keep = gs.players.filter(p => !p.isBot && p.connected);
  gs = createFreshGs();
  gs.players = keep.map((p, i) => ({ ...p, stoneNumber: i + 1, captures: 0 }));
  if (gs.players.length > 0) gs.hostPlayerId = gs.players[0].id;
  broadcastAll();
  render();
}

// ── PeerJS setup ─────────────────────────────────────────────────────
let peer = null;
let myPeerId = null;
let _peerRetries = 0;

function initHost() {
  if (isLanMode()) {
    _initLanHost();
    return;
  }
  _initTrysteroHost();
}

function _initTrysteroHost() {
  const joinUrlEl = document.getElementById('join-url');
  if (joinUrlEl) joinUrlEl.textContent = 'Connecting…';

  peer = new TrysteroHostPeer('nksimmons-stones-of-five');
  peer.on('open', (id) => {
    myPeerId = id;
    const url = buildPlayerUrl(id);
    if (joinUrlEl) joinUrlEl.textContent = url;
    showQrCode(url);
  });
  peer.on('connection', (conn) => {
    conn.on('open', () => handleNewConnection(conn));
    conn.on('error', () => {});
  });
  peer.on('error', (err) => console.warn('Trystero host error:', err));
}

function _initLanHost() {
  const joinUrlEl = document.getElementById('join-url');
  if (joinUrlEl) joinUrlEl.textContent = 'Starting…';
  peer = new LocalHostPeer();
  peer.on('open', id => {
    myPeerId = id;
    const url = buildPlayerUrl(id);
    if (joinUrlEl) joinUrlEl.textContent = url;
    showQrCode(url);
  });
  peer.on('connection', conn => {
    conn.on('open', () => handleNewConnection(conn));
    conn.on('error', () => {});
  });
  peer.on('error', err => console.warn('LAN host error:', err));
}

function handleNewConnection(conn) {
  conn.on('data', (msg) => handleMessage(conn, msg));
  conn.on('close', () => {
    for (const [pid, c] of connections) {
      if (c === conn) { markDisconnected(pid); break; }
    }
  });
}

// ── Message handler ──────────────────────────────────────────────────
function handleMessage(conn, msg) {
  switch (msg.type) {
    case 'player-join': handleJoin(conn, msg); break;
    case 'reconnect':   handleReconnect(conn, msg); break;
    case 'place-stone': handlePlaceStone(conn, msg); break;
    case 'start-game':  handleStartGame(conn); break;
    case 'restart':     handleRestart(conn); break;
    case 'add-bot':     handleAddBot(conn); break;
    case 'remove-bot':  handleRemoveBot(conn); break;
    case 'set-bot-level': handleSetBotLevel(conn, msg); break;
    case 'undo-request': handleUndoRequest(conn, msg); break;
    case 'undo-vote':   handleUndoVote(conn, msg); break;
  }
}

function sendTo(conn, msg) {
  try { if (conn && conn.open) conn.send(msg); } catch (e) {}
}

function broadcastAll() {
  for (const p of gs.players) {
    if (p.isBot || !p.connected) continue;
    const conn = connections.get(p.id);
    if (conn) sendTo(conn, { type: 'state', data: playerView(p.id) });
  }
  render();
}

// ── Player management ────────────────────────────────────────────────
function handleJoin(conn, msg) {
  if (gs.phase !== 'lobby') { sendTo(conn, { type: 'error', message: 'Game already in progress' }); return; }
  if (gs.players.filter(p => !p.isBot).length >= 4) { sendTo(conn, { type: 'error', message: 'Game is full (4 players max)' }); return; }

  const name = String(msg.name || 'Player').slice(0, 20);
  const avatar = sanitizeAvatar(msg.avatar);
  const deviceId = String(msg.deviceId || '');

  // Reconnect by deviceId?
  if (deviceId) {
    const dup = gs.players.find(p => p.deviceId === deviceId);
    if (dup) {
      dup.connected = true;
      connections.set(dup.id, conn);
      sendTo(conn, { type: 'joined', playerId: dup.id, data: playerView(dup.id) });
      broadcastAll(); return;
    }
  }

  const id = String(nextId++);
  const player = {
    id, name, avatar, deviceId,
    stoneNumber: nextStoneNumber(),
    captures: 0, connected: true, isBot: false,
    peerId: conn.peer,
  };
  gs.players.push(player);
  if (!gs.hostPlayerId) gs.hostPlayerId = id;
  connections.set(id, conn);
  sendTo(conn, { type: 'joined', playerId: id, data: playerView(id) });
  broadcastAll();
}

function handleReconnect(conn, msg) {
  const deviceId = String(msg.deviceId || '');
  const p = gs.players.find(pl => pl.deviceId === deviceId);
  if (!p) { sendTo(conn, { type: 'unknown-device' }); return; }
  p.connected = true;
  connections.set(p.id, conn);
  if (!gs.hostPlayerId) gs.hostPlayerId = p.id;
  sendTo(conn, { type: 'reconnected', playerId: p.id, data: playerView(p.id) });
  broadcastAll();
}

function markDisconnected(pid) {
  const p = gs.players.find(pl => pl.id === pid);
  if (p) { p.connected = false; broadcastAll(); }
}

function nextStoneNumber() {
  const used = new Set(gs.players.map(p => p.stoneNumber));
  for (let i = 1; i <= 4; i++) if (!used.has(i)) return i;
  return gs.players.length + 1;
}

function sanitizeAvatar(av) {
  if (!av || typeof av !== 'object') return { bgColor: '#c9a87a' };
  return {
    bgColor: typeof av.bgColor === 'string' ? av.bgColor.slice(0, 20) : '#c9a87a',
    drawing: typeof av.drawing === 'string' ? av.drawing : null,
  };
}

// ── Game control ─────────────────────────────────────────────────────
function handleStartGame(conn) {
  const pid = pidFromConn(conn);
  if (pid !== gs.hostPlayerId) return;
  if (gs.players.length < 2) { sendTo(conn, { type: 'error', message: 'Need at least 2 players' }); return; }
  if (gs.phase !== 'lobby' && gs.phase !== 'gameOver') return;
  startGame();
}

function startGame() {
  gs.board = createBoard();
  gs.phase = 'playing';
  gs.currentTurnIndex = 0;
  gs.moveNumber = 0;
  gs.lastMove = null;
  gs.lastCaptures = [];
  gs.winner = null;
  gs.players.forEach(p => { p.captures = 0; });
  broadcastAll();
  scheduleBot();
}

function handleRestart(conn) {
  const pid = pidFromConn(conn);
  if (pid !== gs.hostPlayerId) return;
  resetGs();
}

// ── Move handling ─────────────────────────────────────────────────────
let undoSnapshot = null;
let undoRequest = null;

function handlePlaceStone(conn, msg) {
  if (gs.phase !== 'playing') return;
  const pid = pidFromConn(conn);
  if (!pid) return;
  const currentPlayer = gs.players[gs.currentTurnIndex];
  if (!currentPlayer || currentPlayer.id !== pid) {
    sendTo(conn, { type: 'move-result', valid: false, reason: 'Not your turn' }); return;
  }
  const { row, col } = msg;
  if (typeof row !== 'number' || typeof col !== 'number') return;
  const v = isValidMove(gs.board, row, col);
  if (!v.valid) { sendTo(conn, { type: 'move-result', valid: false, reason: v.reason }); return; }

  sendTo(conn, { type: 'move-result', valid: true });
  applyMove(row, col, currentPlayer);
}

function applyMove(row, col, player) {
  // Save snapshot for undo
  undoSnapshot = {
    board: gs.board.map(r => [...r]),
    captures: gs.players.map(p => p.captures),
    currentTurnIndex: gs.currentTurnIndex,
    moveNumber: gs.moveNumber,
    lastMove: gs.lastMove,
    lastCaptures: gs.lastCaptures,
  };
  undoRequest = null;

  const caps = placeStone(gs.board, row, col, player.stoneNumber);
  const capPairs = caps.length / 2;
  player.captures += capPairs;

  gs.lastMove = { row, col };
  gs.lastCaptures = caps;
  gs.moveNumber++;

  const win = checkWin(gs.board, row, col, player.stoneNumber, player.captures);
  if (win) {
    gs.phase = 'gameOver';
    gs.winner = { playerId: player.id, name: player.name, reason: win };
    stopBotLoop();
    broadcastAll();
    return;
  }
  if (isBoardFull(gs.board)) {
    gs.phase = 'gameOver';
    gs.winner = null;
    stopBotLoop();
    broadcastAll();
    return;
  }

  gs.currentTurnIndex = (gs.currentTurnIndex + 1) % gs.players.length;
  broadcastAll();
  scheduleBot();
}

// ── Undo ─────────────────────────────────────────────────────────────
function handleUndoRequest(conn, msg) {
  const pid = pidFromConn(conn);
  if (!undoSnapshot || !pid) return;
  if (undoRequest) return; // already pending
  const requester = gs.players.find(p => p.id === pid);
  if (!requester) return;
  // Single player or requester is the only one who moved → just grant
  const others = gs.players.filter(p => !p.isBot && p.connected && p.id !== pid);
  if (others.length === 0) {
    applyUndo(); broadcastAll(); return;
  }
  undoRequest = { requesterId: pid, votes: new Map(), required: others.length };
  sendTo(conn, { type: 'undo-pending' });
  for (const op of others) {
    const oc = connections.get(op.id);
    if (oc) sendTo(oc, { type: 'undo-request', requesterId: pid, requesterName: requester.name });
  }
}

function handleUndoVote(conn, msg) {
  const pid = pidFromConn(conn);
  if (!undoRequest || !pid) return;
  undoRequest.votes.set(pid, msg.approve);
  if (!msg.approve) {
    // Any rejection → deny
    const reqConn = connections.get(undoRequest.requesterId);
    if (reqConn) sendTo(reqConn, { type: 'undo-result', approved: false });
    undoRequest = null;
    return;
  }
  if (undoRequest.votes.size >= undoRequest.required) {
    const reqConn = connections.get(undoRequest.requesterId);
    if (reqConn) sendTo(reqConn, { type: 'undo-result', approved: true });
    applyUndo();
    undoRequest = null;
    broadcastAll();
  }
}

function applyUndo() {
  if (!undoSnapshot) return;
  gs.board = undoSnapshot.board;
  gs.players.forEach((p, i) => { p.captures = undoSnapshot.captures[i]; });
  gs.currentTurnIndex = undoSnapshot.currentTurnIndex;
  gs.moveNumber = undoSnapshot.moveNumber;
  gs.lastMove = undoSnapshot.lastMove;
  gs.lastCaptures = undoSnapshot.lastCaptures;
  undoSnapshot = null;
}

// ── Bots ──────────────────────────────────────────────────────────────
const BOT_NAMES = ['🤖 Alice', '🤖 Bob', '🤖 Charlie'];

function handleAddBot(conn) {
  const pid = pidFromConn(conn);
  if (pid !== gs.hostPlayerId) return;
  if (gs.phase !== 'lobby' || gs.players.length >= 4) return;
  addBot();
}

function handleRemoveBot(conn) {
  const pid = pidFromConn(conn);
  if (pid !== gs.hostPlayerId) return;
  const idx = [...gs.players].reverse().findIndex(p => p.isBot);
  if (idx >= 0) gs.players.splice(gs.players.length - 1 - idx, 1);
  broadcastAll();
}

function handleSetBotLevel(conn, msg) {
  const pid = pidFromConn(conn);
  if (pid !== gs.hostPlayerId) return;
  const level = Number(msg.level);
  if (level >= 1 && level <= 4) { gs.botChallengeLevel = level; broadcastAll(); }
}

function scheduleBot() {
  stopBotLoop();
  const cur = gs.players[gs.currentTurnIndex];
  if (!cur || !cur.isBot) return;
  botTimer = setTimeout(() => runBotMove(), 1000);
}

function runBotMove() {
  if (gs.phase !== 'playing') return;
  const cur = gs.players[gs.currentTurnIndex];
  if (!cur || !cur.isBot) return;
  const allStoneNums = gs.players.map(p => p.stoneNumber);
  const caps = {};
  gs.players.forEach(p => { caps[p.stoneNumber] = p.captures; });
  const move = getBotMove(gs.board, cur.stoneNumber, allStoneNums, caps, gs.moveNumber, gs.players.length, gs.botChallengeLevel);
  if (move) applyMove(move.row, move.col, cur);
}

function stopBotLoop() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
}

// ── State projection ─────────────────────────────────────────────────
function playerView(playerId) {
  const p = gs.players.find(pl => pl.id === playerId);
  return {
    phase: gs.phase,
    players: gs.players.map(pl => ({
      id: pl.id, name: pl.name, avatar: pl.avatar,
      stoneNumber: pl.stoneNumber, captures: pl.captures,
      connected: pl.connected, isBot: pl.isBot,
    })),
    board: gs.board,
    currentTurnPlayerId: gs.players[gs.currentTurnIndex]?.id ?? null,
    myStoneNumber: p?.stoneNumber ?? null,
    lastMove: gs.lastMove,
    lastCaptures: gs.lastCaptures,
    winner: gs.winner,
    hostPlayerId: gs.hostPlayerId,
    botChallengeLevel: gs.botChallengeLevel,
  };
}

function pidFromConn(conn) {
  for (const [id, c] of connections) { if (c === conn) return id; }
  return null;
}

// ── Host display render ───────────────────────────────────────────────
function render() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(`screen-${gs.phase}`);
  if (screen) screen.classList.add('active');

  if (gs.phase === 'lobby') renderLobby();
  else if (gs.phase === 'playing') renderPlaying();
  else if (gs.phase === 'gameOver') renderGameOver();

  updateHostButtons();
}

function renderLobby() {
  const container = document.getElementById('lobby-players');
  if (!container) return;
  container.innerHTML = gs.players.map(p => `
    <div class="player-card">
      <div class="avatar" style="background:${p.avatar.bgColor}">${renderAvatarContent(p.avatar)}</div>
      <div class="player-name">${esc(p.name)}</div>
      <span class="stone-dot s${p.stoneNumber}"></span>
    </div>
  `).join('');
}

function renderPlaying() {
  const cur = gs.players[gs.currentTurnIndex];
  if (cur) {
    const ti = document.getElementById('turn-indicator');
    ti.className = 'turn-indicator waiting';
    ti.innerHTML = `<span class="stone-dot stone-dot-large s${cur.stoneNumber}"></span> ${esc(cur.name)}'s Turn`;
  }
  renderPlayerList('player-list');
  const canvas = document.getElementById('game-board');
  if (canvas && gs.board) drawBoard(canvas, gs.board, { lastMove: gs.lastMove });
}

function renderGameOver() {
  const wd = document.getElementById('winner-display');
  if (gs.winner && gs.winner.playerId) {
    const reason = gs.winner.reason === 'five-in-a-row' ? 'Five in a Row!' : 'Five Captures!';
    wd.innerHTML = `<h1>🏆 Game Over!</h1><div class="winner-name">${esc(gs.winner.name)}</div><div class="win-reason">${reason}</div>`;
  } else {
    wd.innerHTML = `<h1>🤝 Draw!</h1><div class="win-reason">The board is full</div>`;
  }
  const canvas = document.getElementById('final-board');
  if (canvas && gs.board) drawBoard(canvas, gs.board, { lastMove: gs.lastMove });
  renderPlayerList('final-player-list');
}

function renderPlayerList(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = gs.players.map(p => {
    const isActive = gs.players[gs.currentTurnIndex]?.id === p.id;
    return `
      <div class="player-row ${isActive ? 'active-turn' : ''}" ${!p.connected && !p.isBot ? 'style="opacity:0.4"' : ''}>
        <div class="avatar" style="background:${p.avatar.bgColor};width:40px;height:40px;font-size:1.2rem">${renderAvatarContent(p.avatar)}</div>
        <span class="stone-dot stone-dot-large s${p.stoneNumber}"></span>
        <div style="flex:1">
          <div class="player-name" style="margin:0">${esc(p.name)}</div>
          <div style="font-size:0.8rem;color:var(--text-dim)">Captures: ${p.captures}/5</div>
        </div>
        ${isActive ? '<span style="color:var(--success)">◀</span>' : ''}
      </div>`;
  }).join('');
}

function updateHostButtons() {
  const isLobby = gs.phase === 'lobby';
  const isOver = gs.phase === 'gameOver';
  const hasBots = gs.players.some(p => p.isBot);
  const isFull = gs.players.length >= 4;

  const startBtn = document.getElementById('host-btn-start');
  const restartBtn = document.getElementById('host-btn-restart');
  const endBtn = document.getElementById('host-btn-end');
  const addBot = document.getElementById('host-btn-add-bot');
  const removeBot = document.getElementById('host-btn-remove-bot');
  const botControls = document.getElementById('bot-controls');
  const botLevel = document.getElementById('host-bot-level');

  if (startBtn) startBtn.style.display = (isLobby && gs.players.length >= 2) ? '' : 'none';
  if (restartBtn) restartBtn.style.display = isOver ? '' : 'none';
  if (endBtn) endBtn.style.display = (!isLobby) ? '' : 'none';
  if (botControls) botControls.style.display = isLobby ? '' : 'none';
  if (addBot) addBot.style.display = (isLobby && !isFull) ? '' : 'none';
  if (removeBot) removeBot.style.display = (isLobby && hasBots) ? '' : 'none';
  if (botLevel) botLevel.value = String(gs.botChallengeLevel);
}

// ── Helpers ───────────────────────────────────────────────────────────
function renderAvatarContent(avatar) {
  if (avatar.drawing) return `<img src="${avatar.drawing}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  return '🎯';
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ── Button wiring ─────────────────────────────────────────────────────
document.getElementById('host-btn-start')?.addEventListener('click', () => {
  if (gs.players.length < 2) return;
  startGame();
});
document.getElementById('host-btn-restart')?.addEventListener('click', resetGs);
document.getElementById('host-btn-end')?.addEventListener('click', () => {
  if (!confirm('End the game and return to lobby?')) return;
  resetGs();
});
document.getElementById('host-btn-add-bot')?.addEventListener('click', () => {
  if (gs.phase !== 'lobby' || gs.players.length >= 4) return;
  addBot();
});

function addBot() {
  const existing = new Set(gs.players.filter(p => p.isBot).map(p => p.name));
  const botName = BOT_NAMES.find(n => !existing.has(n));
  if (!botName) return;
  gs.players.push({
    id: String(nextId++), name: botName, avatar: { bgColor: '#8a8a8a', drawing: null },
    stoneNumber: nextStoneNumber(), captures: 0, connected: true, isBot: true, deviceId: null,
  });
  if (!gs.hostPlayerId && gs.players.length > 0) gs.hostPlayerId = gs.players[0].id;
  broadcastAll();
}
document.getElementById('host-btn-remove-bot')?.addEventListener('click', () => {
  const idx = [...gs.players].reverse().findIndex(p => p.isBot);
  if (idx >= 0) gs.players.splice(gs.players.length - 1 - idx, 1);
  broadcastAll();
});
document.getElementById('host-bot-level')?.addEventListener('change', (e) => {
  const level = Number(e.target.value);
  if (level >= 1 && level <= 4) { gs.botChallengeLevel = level; broadcastAll(); }
});

// ── Init ──────────────────────────────────────────────────────────────
initHost();
render();
