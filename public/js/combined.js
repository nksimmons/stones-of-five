// =====================================================================
// STONES OF FIVE — COMBINED (host + player 1) — PeerJS, static GitHub Pages
// =====================================================================
// One device acts as host AND plays as player 1. Remote players scan a
// QR code to join as player.html?room=<peerId>.
// =====================================================================

const BG_COLORS = ['#e63946','#457b9d','#2a9d8f','#e9c46a','#f4a261','#264653','#6a4c93','#1982c4','#8ac926','#ff595e','#ff924c','#c77dff'];
const DRAW_COLORS = ['#111111','#ff4444','#ff8800','#ffdd00','#44cc44','#2299ff','#aa44ff','#ff66cc','#88ccff','#888888','#ffffff'];
const PILE_POSITIONS = [
  { x: 8,  y: 14, rot: -15 },
  { x: 34, y: 4,  rot: 8 },
  { x: 58, y: 18, rot: -5 },
  { x: 82, y: 6,  rot: 14 },
  { x: 110, y: 12, rot: -9 },
];
const BOT_NAMES = ['🤖 Alice', '🤖 Bob', '🤖 Charlie'];

// ── Shared host state ─────────────────────────────────────────────────
let gs = null;
let peer = null;
const connections = new Map(); // playerId → DataConnection
let nextId = 100;
let botTimer = null;
let undoSnapshot = null;
let undoRequest = null;
let selfPlayerId = null; // player 1 (us)

function resetGs() {
  const prevBotLevel = gs ? gs.botChallengeLevel : 2;
  const selfPlayer = gs ? gs.players.find(p => p.id === selfPlayerId) : null;
  const kept = gs ? gs.players.filter(p => !p.isBot && p.id !== selfPlayerId) : [];
  gs = {
    phase: 'lobby', board: createBoard(), players: [], currentTurnIndex: 0,
    moveNumber: 0, lastMove: null, lastCaptures: [], winner: null,
    hostPlayerId: selfPlayerId || null, botChallengeLevel: prevBotLevel,
  };
  // Re-add self as player 1
  if (selfPlayer) gs.players.push({ ...selfPlayer, captures: 0, stoneNumber: 1 });
  // Re-add remote players that were connected
  for (const p of kept) {
    gs.players.push({ ...p, captures: 0, stoneNumber: gs.players.length + 1 });
  }
}

// ── Device ID / profile ───────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('sof-combined-device-id');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem('sof-combined-device-id', id); }
  return id;
}
function saveProfile(name, avatar) { localStorage.setItem('sof-combined-name', name); localStorage.setItem('sof-combined-avatar', JSON.stringify(avatar)); }
function loadProfile() {
  const name = localStorage.getItem('sof-combined-name'); let avatar = null;
  try { avatar = JSON.parse(localStorage.getItem('sof-combined-avatar') || 'null'); } catch(e) {}
  return { name, avatar };
}
const deviceId = getDeviceId();

// ── Player helpers ────────────────────────────────────────────────────
function nextStoneNumber() {
  const used = new Set(gs.players.map(p => p.stoneNumber));
  for (let i = 1; i <= 4; i++) if (!used.has(i)) return i;
  return 1;
}

function playerView(playerId) {
  const me = gs.players.find(p => p.id === playerId);
  return {
    phase: gs.phase,
    players: gs.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, stoneNumber: p.stoneNumber, captures: p.captures, connected: p.connected, isBot: p.isBot })),
    board: gs.board,
    currentTurnPlayerId: gs.players[gs.currentTurnIndex]?.id ?? null,
    myStoneNumber: me?.stoneNumber ?? null,
    lastMove: gs.lastMove,
    lastCaptures: gs.lastCaptures,
    winner: gs.winner ? { playerId: gs.winner.playerId, name: gs.winner.name, reason: gs.winner.reason } : null,
    hostPlayerId: gs.hostPlayerId,
    botChallengeLevel: gs.botChallengeLevel,
  };
}

function broadcastAll() {
  for (const [pid, conn] of connections.entries()) {
    if (conn.open) conn.send({ type: 'state', data: playerView(pid) });
  }
  // Update self
  selfState = selfPlayerId ? playerView(selfPlayerId) : null;
  renderScreen();
}

function pidFromConn(conn) {
  for (const [pid, c] of connections.entries()) { if (c === conn) return pid; }
  return null;
}

// ── Sound effects ─────────────────────────────────────────────────────
let audioCtx = null;
function getAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }
function playTone(freq1, freq2, type, dur, vol = 0.2) {
  const ctx = getAudio(); const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = type; osc.frequency.setValueAtTime(freq1, ctx.currentTime);
  if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, ctx.currentTime + dur);
  gain.gain.setValueAtTime(vol, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + dur);
  osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
}
function playPlaceSound()   { playTone(600, 400, 'sine', 0.12); }
function playCaptureSound() { playTone(300, 1200, 'sawtooth', 0.2); }
function playYourTurnSound() { [523,659,784].forEach((f,i) => setTimeout(() => playTone(f, 0, 'sine', 0.15), i*100)); }
function playWinSound()     { [523,659,784,1047].forEach((f,i) => setTimeout(() => playTone(f, 0, 'triangle', 0.3, 0.2), i*150)); }

// ── Avatar builder ────────────────────────────────────────────────────
let drawCtx, drawCanvas, drawStrokes = [], currentStroke = null, drawColor = DRAW_COLORS[0], isDrawing = false;
let avatarChoice = { drawing: null, bgColor: BG_COLORS[0] };

function initAvatarBuilder() {
  drawCanvas = document.getElementById('draw-canvas');
  drawCtx = drawCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = drawCanvas.getBoundingClientRect();
  drawCanvas.width = rect.width * dpr; drawCanvas.height = rect.height * dpr;
  drawCtx.scale(dpr, dpr);

  const colorsEl = document.getElementById('draw-colors');
  colorsEl.innerHTML = DRAW_COLORS.map(c => `<div class="draw-color ${c === drawColor ? 'selected' : ''}" data-color="${c}" style="background:${c};border:1px solid #ccc"></div>`).join('');
  colorsEl.addEventListener('click', (e) => { const el = e.target.closest('.draw-color'); if (!el) return; colorsEl.querySelectorAll('.draw-color').forEach(d => d.classList.remove('selected')); el.classList.add('selected'); drawColor = el.dataset.color; });

  const colorContainer = document.getElementById('color-options');
  colorContainer.innerHTML = BG_COLORS.map(c => `<div class="color-option ${c === avatarChoice.bgColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`).join('');
  colorContainer.addEventListener('click', (e) => { const opt = e.target.closest('.color-option'); if (!opt) return; colorContainer.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected')); opt.classList.add('selected'); avatarChoice.bgColor = opt.dataset.color; redrawCanvas(); updateAvatarPreview(); });

  drawCanvas.addEventListener('pointerdown', onDrawStart);
  drawCanvas.addEventListener('pointermove', onDrawMove);
  drawCanvas.addEventListener('pointerup', onDrawEnd);
  drawCanvas.addEventListener('pointerleave', onDrawEnd);
  document.getElementById('btn-undo').addEventListener('click', () => { drawStrokes.pop(); redrawCanvas(); updateAvatarPreview(); });
  document.getElementById('btn-clear').addEventListener('click', () => { drawStrokes = []; redrawCanvas(); updateAvatarPreview(); });

  const p = loadProfile();
  if (p.name) document.getElementById('player-name').value = p.name;
  if (p.avatar) { avatarChoice = { ...avatarChoice, ...p.avatar }; const sel = colorContainer.querySelector(`[data-color="${avatarChoice.bgColor}"]`); if (sel) { colorContainer.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected')); sel.classList.add('selected'); } }
  if (avatarChoice.drawing) {
    const img = new Image();
    img.onload = () => { drawCtx.drawImage(img, 0, 0, drawCanvas.getBoundingClientRect().width, drawCanvas.getBoundingClientRect().height); drawStrokes = [{ restored: true }]; updateAvatarPreview(); };
    img.src = avatarChoice.drawing;
  } else { redrawCanvas(); }
  updateAvatarPreview();
}

function getCanvasPos(e) { const r = drawCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function onDrawStart(e) { e.preventDefault(); drawCanvas.setPointerCapture(e.pointerId); isDrawing = true; const pos = getCanvasPos(e); currentStroke = { color: drawColor, width: 3, points: [pos] }; if (drawStrokes.length === 1 && drawStrokes[0].restored) drawStrokes = []; }
function onDrawMove(e) { if (!isDrawing || !currentStroke) return; e.preventDefault(); const pos = getCanvasPos(e); currentStroke.points.push(pos); const pts = currentStroke.points; drawCtx.beginPath(); drawCtx.strokeStyle = currentStroke.color; drawCtx.lineWidth = currentStroke.width; drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round'; if (pts.length >= 2) { drawCtx.moveTo(pts[pts.length-2].x, pts[pts.length-2].y); drawCtx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y); } drawCtx.stroke(); }
function onDrawEnd(e) { if (!isDrawing || !currentStroke) return; isDrawing = false; if (currentStroke.points.length >= 2) drawStrokes.push(currentStroke); else if (currentStroke.points.length === 1) { const p = currentStroke.points[0]; drawCtx.beginPath(); drawCtx.fillStyle = currentStroke.color; drawCtx.arc(p.x, p.y, currentStroke.width, 0, Math.PI*2); drawCtx.fill(); drawStrokes.push(currentStroke); } currentStroke = null; updateAvatarPreview(); }
function redrawCanvas() { const rect = drawCanvas.getBoundingClientRect(); drawCtx.clearRect(0, 0, rect.width, rect.height); drawCtx.fillStyle = avatarChoice.bgColor || BG_COLORS[0]; drawCtx.fillRect(0, 0, rect.width, rect.height); for (const stroke of drawStrokes) { if (stroke.restored) continue; const pts = stroke.points; drawCtx.beginPath(); drawCtx.strokeStyle = stroke.color; drawCtx.lineWidth = stroke.width; drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round'; if (pts.length === 1) { drawCtx.fillStyle = stroke.color; drawCtx.arc(pts[0].x, pts[0].y, stroke.width, 0, Math.PI*2); drawCtx.fill(); } else { drawCtx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) drawCtx.lineTo(pts[i].x, pts[i].y); drawCtx.stroke(); } } }
function getDrawingDataUrl() { const exp = document.createElement('canvas'); exp.width = 60; exp.height = 60; const ectx = exp.getContext('2d'); ectx.fillStyle = avatarChoice.bgColor || BG_COLORS[0]; ectx.fillRect(0, 0, 60, 60); ectx.drawImage(drawCanvas, 0, 0, drawCanvas.width, drawCanvas.height, 0, 0, 60, 60); return exp.toDataURL('image/png'); }
function updateAvatarPreview() { const preview = document.getElementById('avatar-preview'); preview.textContent = ''; preview.style.background = avatarChoice.bgColor; if (drawStrokes.length > 0) { const url = getDrawingDataUrl(); avatarChoice.drawing = url; preview.style.backgroundImage = `url(${url})`; preview.style.backgroundSize = 'cover'; } else { avatarChoice.drawing = null; preview.style.backgroundImage = ''; } }

// ── Self-join ─────────────────────────────────────────────────────────
function selfJoin() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { document.getElementById('player-name').focus(); return; }
  saveProfile(name, avatarChoice);
  selfPlayerId = String(nextId++);
  gs.players.push({
    id: selfPlayerId, name, avatar: avatarChoice,
    stoneNumber: nextStoneNumber(), captures: 0, connected: true,
    isBot: false, deviceId,
  });
  gs.hostPlayerId = selfPlayerId;
  selfState = playerView(selfPlayerId);
  initPeer();
  renderScreen();
}

// ── Trystero host ─────────────────────────────────────────────────────
function initPeer() {
  peer = new TrysteroHostPeer('nksimmons-stones-of-five');
  peer.on('open', (id) => {
    showQrCode(buildPlayerUrl(id));
    document.getElementById('room-id').textContent = id;
    document.getElementById('lobby-url').textContent = buildPlayerUrl(id);
  });
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      conn.on('data', (msg) => handleMessage(conn, msg));
      conn.on('close', () => {
        const pid = pidFromConn(conn);
        if (pid && gs.players.find(p => p.id === pid)) {
          const p = gs.players.find(pp => pp.id === pid); if (p) p.connected = false;
          broadcastAll();
        }
      });
    });
  });
  peer.on('error', err => console.warn('Trystero error:', err));
}

function buildPlayerUrl(peerId) {
  const base = location.href.replace('combined.html', 'player.html');
  return `${base}?room=${peerId}`;
}

function showQrCode(url) {
  const img = document.getElementById('qr-img'); if (!img) return;
  try {
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    img.src = qr.createDataURL(4, 4); img.style.display = 'block';
  } catch(e) { console.error('QR error', e); }
}

// ── Message handler ───────────────────────────────────────────────────
function handleMessage(conn, msg) {
  switch (msg.type) {
    case 'player-join': handleJoin(conn, msg); break;
    case 'reconnect': handleReconnect(conn, msg); break;
    case 'place-stone': handlePlaceStone(conn, msg); break;
    case 'start-game': handleStartGame(conn); break;
    case 'restart': handleRestart(conn); break;
    case 'add-bot': handleAddBot(conn); break;
    case 'remove-bot': handleRemoveBot(conn); break;
    case 'set-bot-level': handleSetBotLevel(conn, msg); break;
    case 'undo-request': handleUndoRequest(conn); break;
    case 'undo-vote': handleUndoVote(conn, msg); break;
  }
}

function handleJoin(conn, msg) {
  if (gs.phase !== 'lobby') { conn.send({ type: 'error', message: 'Game already started.' }); return; }
  if (gs.players.length >= 4) { conn.send({ type: 'error', message: 'Game is full.' }); return; }
  const id = String(nextId++);
  const player = { id, name: msg.name || 'Player', avatar: msg.avatar || { bgColor: BG_COLORS[0], drawing: null }, stoneNumber: nextStoneNumber(), captures: 0, connected: true, isBot: false, deviceId: msg.deviceId || null };
  gs.players.push(player);
  connections.set(id, conn);
  conn.send({ type: 'joined', playerId: id, data: playerView(id) });
  broadcastAll();
}

function handleReconnect(conn, msg) {
  const existing = gs.players.find(p => p.deviceId === msg.deviceId && !p.isBot);
  if (!existing) { conn.send({ type: 'unknown-device' }); return; }
  existing.connected = true;
  connections.set(existing.id, conn);
  conn.send({ type: 'reconnected', playerId: existing.id, data: playerView(existing.id) });
  broadcastAll();
}

function handleStartGame(conn) {
  const pid = pidFromConn(conn);
  if (pid !== gs.hostPlayerId && conn !== 'self') return;
  if (gs.phase !== 'lobby' || gs.players.length < 1) return;
  gs.phase = 'playing'; gs.board = createBoard(); gs.currentTurnIndex = 0; gs.moveNumber = 0;
  gs.lastMove = null; gs.lastCaptures = []; gs.winner = null;
  gs.players.forEach(p => { p.captures = 0; });
  broadcastAll(); scheduleBot();
}

function handleRestart(conn) {
  const pid = pidFromConn(conn);
  if (pid !== gs.hostPlayerId && conn !== 'self') return;
  resetGs(); broadcastAll();
}

function addBot() {
  const existing = new Set(gs.players.filter(p => p.isBot).map(p => p.name));
  const botName = BOT_NAMES.find(n => !existing.has(n));
  if (!botName) return;
  gs.players.push({ id: String(nextId++), name: botName, avatar: { bgColor: '#8a8a8a', drawing: null }, stoneNumber: nextStoneNumber(), captures: 0, connected: true, isBot: true, deviceId: null });
  broadcastAll();
}
function handleAddBot(conn) { const pid = pidFromConn(conn); if (pid !== gs.hostPlayerId && conn !== 'self') return; if (gs.phase !== 'lobby' || gs.players.length >= 4) return; addBot(); }
function handleRemoveBot(conn) { const pid = pidFromConn(conn); if (pid !== gs.hostPlayerId && conn !== 'self') return; const idx = gs.players.findLastIndex(p => p.isBot); if (idx < 0) return; gs.players.splice(idx, 1); broadcastAll(); }
function handleSetBotLevel(conn, msg) { const pid = pidFromConn(conn); if (pid !== gs.hostPlayerId && conn !== 'self') return; gs.botChallengeLevel = Math.min(4, Math.max(1, Number(msg.level))); broadcastAll(); }

function handlePlaceStone(conn, msg) {
  const pid = pidFromConn(conn);
  if (!pid) return;
  if (gs.phase !== 'playing') { conn.send({ type: 'move-result', valid: false, reason: 'Not playing.' }); return; }
  const cur = gs.players[gs.currentTurnIndex];
  if (!cur || cur.id !== pid) { conn.send({ type: 'move-result', valid: false, reason: 'Not your turn.' }); return; }
  if (!isValidMove(gs.board, msg.row, msg.col).valid) { conn.send({ type: 'move-result', valid: false, reason: 'Invalid move.' }); return; }
  conn.send({ type: 'move-result', valid: true });
  applyMove(msg.row, msg.col, cur);
}

function applyMove(row, col, player) {
  undoSnapshot = { board: gs.board.map(r => [...r]), captures: gs.players.map(p => p.captures), turnIndex: gs.currentTurnIndex, moveNumber: gs.moveNumber, lastMove: gs.lastMove, lastCaptures: gs.lastCaptures };
  undoRequest = null;
  const caps = placeStone(gs.board, row, col, player.stoneNumber);
  gs.lastMove = { row, col };
  gs.lastCaptures = caps;
  player.captures += caps.length / 2;
  gs.moveNumber++;
  const win = checkWin(gs.board, row, col, player.stoneNumber, player.captures);
  if (win) {
    gs.phase = 'gameOver'; gs.winner = { playerId: player.id, name: player.name, reason: win };
    broadcastAll();
    if (player.id === selfPlayerId) playWinSound();
    return;
  }
  if (isBoardFull(gs.board)) {
    gs.phase = 'gameOver'; gs.winner = null; broadcastAll(); return;
  }
  gs.currentTurnIndex = (gs.currentTurnIndex + 1) % gs.players.length;
  const nextPlayer = gs.players[gs.currentTurnIndex];
  if (nextPlayer && nextPlayer.id === selfPlayerId) playYourTurnSound();
  broadcastAll(); scheduleBot();
}

function scheduleBot() {
  if (botTimer) clearTimeout(botTimer);
  const cur = gs.players[gs.currentTurnIndex];
  if (gs.phase === 'playing' && cur && cur.isBot) botTimer = setTimeout(runBotMove, 1000);
}
function runBotMove() {
  if (gs.phase !== 'playing') return;
  const cur = gs.players[gs.currentTurnIndex]; if (!cur || !cur.isBot) return;
  const allStones = gs.players.map(p => p.stoneNumber);
  const caps = Object.fromEntries(gs.players.map(p => [p.stoneNumber, p.captures]));
  const move = getBotMove(gs.board, cur.stoneNumber, allStones, caps, gs.moveNumber, gs.players.length, gs.botChallengeLevel);
  if (move) applyMove(move.row, move.col, cur);
}

function handleUndoRequest(conn) {
  const pid = pidFromConn(conn); if (!pid) return;
  if (gs.phase !== 'playing' || !undoSnapshot) return;
  if (gs.players.length <= 1) { applyUndo(); return; }
  undoRequest = { requesterId: pid, votes: new Map([[pid, true]]), required: gs.players.filter(p => !p.isBot && p.connected).length };
  const requester = gs.players.find(p => p.id === pid);
  for (const [vpid, vc] of connections.entries()) {
    if (vpid !== pid && vc.open) vc.send({ type: 'undo-request', requesterId: pid, requesterName: requester?.name ?? '?' });
  }
  conn.send({ type: 'undo-pending' });
}
function handleUndoVote(conn, msg) {
  if (!undoRequest) return;
  const pid = pidFromConn(conn); if (!pid) return;
  undoRequest.votes.set(pid, msg.approve);
  const approved = [...undoRequest.votes.values()].every(v => v);
  const allVoted = undoRequest.votes.size >= undoRequest.required;
  if (!approved) { broadcastUndoResult(false); undoRequest = null; return; }
  if (allVoted) { broadcastUndoResult(true); applyUndo(); undoRequest = null; }
}
function broadcastUndoResult(approved) {
  for (const [, c] of connections.entries()) if (c.open) c.send({ type: 'undo-result', approved });
}
function applyUndo() {
  if (!undoSnapshot) return;
  gs.board = undoSnapshot.board;
  gs.players.forEach((p, i) => { p.captures = undoSnapshot.captures[i]; });
  gs.currentTurnIndex = undoSnapshot.turnIndex;
  gs.moveNumber = undoSnapshot.moveNumber;
  gs.lastMove = undoSnapshot.lastMove;
  gs.lastCaptures = undoSnapshot.lastCaptures;
  undoSnapshot = null;
  broadcastAll();
}

// ── Self state + rendering ────────────────────────────────────────────
let selfState = null;
let previewPos = null;
let isDragging = false;
let lastMoveWasMine = false;

function renderScreen() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  if (!selfPlayerId) { document.getElementById('screen-join').classList.add('active'); return; }
  if (!gs) return;
  const screen = document.getElementById(`screen-${gs.phase}`);
  if (screen) screen.classList.add('active');
  if (gs.phase === 'lobby') renderLobby();
  else if (gs.phase === 'playing') renderPlaying();
  else if (gs.phase === 'gameOver') renderGameOver();
}

function renderLobby() {
  const urlEl = document.getElementById('lobby-url'); if (urlEl && peer && peer.id) urlEl.textContent = buildPlayerUrl(peer.id);
  const container = document.getElementById('lobby-player-list');
  if (!container || !gs.players) return;
  container.innerHTML = `<div class="scoreboard">${gs.players.map(p => `
    <div class="player-card" ${p.id === selfPlayerId ? 'style="border:2px solid var(--accent)"' : ''}>
      <div class="avatar" style="background:${p.avatar.bgColor}">${p.avatar.drawing ? `<img src="${p.avatar.drawing}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : '🎯'}</div>
      <div class="player-name">${esc(p.name)}</div>
      <span class="stone-dot s${p.stoneNumber}"></span>
    </div>`).join('')}</div>`;
  const hasBots = gs.players.some(p => p.isBot);
  const isFull = gs.players.length >= 4;
  const addBotBtn = document.getElementById('btn-add-bot'); if (addBotBtn) addBotBtn.style.display = isFull ? 'none' : '';
  const remBotBtn = document.getElementById('btn-remove-bot'); if (remBotBtn) remBotBtn.style.display = hasBots ? '' : 'none';
  const botLevel = document.getElementById('bot-level'); if (botLevel) botLevel.value = String(gs.botChallengeLevel);
}

function renderPlaying() {
  if (!selfState) selfState = playerView(selfPlayerId);
  previewPos = null;
  document.getElementById('btn-confirm').disabled = true;
  const isMyTurn = selfState.currentTurnPlayerId === selfPlayerId;
  const cur = gs.players.find(p => p.id === selfState.currentTurnPlayerId);
  const turnEl = document.getElementById('turn-indicator');
  if (isMyTurn) {
    turnEl.className = 'turn-indicator my-turn';
    turnEl.innerHTML = `<span class="stone-dot stone-dot-large s${selfState.myStoneNumber}"></span> Your Turn`;
  } else if (cur) {
    turnEl.className = 'turn-indicator waiting';
    turnEl.innerHTML = `<span class="stone-dot stone-dot-large s${cur.stoneNumber}"></span> ${esc(cur.name)}'s Turn`;
  }
  sizeBoard();
  const tray = document.getElementById('stone-tray');
  if (tray) { tray.style.opacity = isMyTurn ? '' : '0.35'; tray.style.pointerEvents = isMyTurn ? '' : 'none'; }
  renderStonePile();
  const undoBtn = document.getElementById('btn-undo-move');
  if (undoBtn) { const canUndo = lastMoveWasMine && !isMyTurn; undoBtn.disabled = !canUndo; undoBtn.style.opacity = canUndo ? '' : '0.3'; }
  const bar = document.getElementById('captures-bar');
  bar.innerHTML = gs.players.map(p => `<div class="capture-info"><span class="stone-dot s${p.stoneNumber}"></span><span>${esc(p.name)}</span><span class="capture-count">${p.captures}/5</span></div>`).join('');
}

function sizeBoard() {
  const canvas = document.getElementById('game-board');
  const container = canvas.parentElement;
  const size = Math.min(container.clientWidth, container.clientHeight);
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  drawBoard(canvas, selfState ? selfState.board : gs.board, { lastMove: selfState?.lastMove ?? gs.lastMove, previewPos, previewStone: selfState?.myStoneNumber });
}

function renderStonePile() {
  const pile = document.getElementById('stone-pile');
  if (!pile || !selfState || !selfState.myStoneNumber) return;
  pile.innerHTML = PILE_POSITIONS.map((p, i) => `<div class="pile-stone s${selfState.myStoneNumber}" style="left:${p.x}px;top:${p.y}px;transform:rotate(${p.rot}deg)" data-pile="${i}"></div>`).join('');
}

function renderGameOver() {
  const wd = document.getElementById('winner-info');
  if (gs.winner && gs.winner.playerId) {
    const reason = gs.winner.reason === 'five-in-a-row' ? 'Five in a Row!' : 'Five Captures!';
    const isMe = gs.winner.playerId === selfPlayerId;
    wd.innerHTML = `<h1>${isMe ? '🎉 You Win!' : '🏆 Game Over!'}</h1><div class="winner-name">${esc(gs.winner.name)}</div><div class="win-reason">${reason}</div>`;
  } else {
    wd.innerHTML = `<h1>🤝 Draw!</h1>`;
  }
  const canvas = document.getElementById('final-board');
  if (canvas && gs.board) drawBoard(canvas, gs.board, { lastMove: gs.lastMove });
}

// ── Board interaction ─────────────────────────────────────────────────
function setupBoardInteraction() {
  const canvas = document.getElementById('game-board');
  let boardDragging = false;

  canvas.addEventListener('click', (e) => {
    if (isDragging || boardDragging) return;
    if (!selfState || gs.phase !== 'playing' || selfState.currentTurnPlayerId !== selfPlayerId) return;
    const pos = getIntersection(canvas, e.clientX, e.clientY);
    if (!pos) { previewPos = null; document.getElementById('btn-confirm').disabled = true; redrawBoard(); return; }
    previewPos = pos; document.getElementById('btn-confirm').disabled = false; redrawBoard();
  });
  canvas.addEventListener('pointerdown', (e) => { if (!selfState || gs.phase !== 'playing' || selfState.currentTurnPlayerId !== selfPlayerId) return; boardDragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (!boardDragging) return; e.preventDefault(); const pos = getIntersection(canvas, e.clientX, e.clientY); if (pos && gs.board && gs.board[pos.row][pos.col] === 0) previewPos = pos; redrawBoard(); });
  canvas.addEventListener('pointerup', () => { if (!boardDragging) return; boardDragging = false; if (previewPos) document.getElementById('btn-confirm').disabled = false; });
  canvas.addEventListener('pointercancel', () => { boardDragging = false; });
  canvas.style.touchAction = 'none';

  document.getElementById('btn-confirm').addEventListener('click', () => {
    if (!previewPos) return;
    const cur = gs.players[gs.currentTurnIndex];
    if (!cur || cur.id !== selfPlayerId) return;
    const row = previewPos.row, col = previewPos.col;
    previewPos = null; document.getElementById('btn-confirm').disabled = true;
    if (!isValidMove(gs.board, row, col).valid) { toast('Invalid move', 'error'); return; }
    lastMoveWasMine = true;
    applyMove(row, col, cur);
    selfState = playerView(selfPlayerId);
  });

  setupStoneDrag();
}

function setupStoneDrag() {
  const pile = document.getElementById('stone-pile');
  const canvas = document.getElementById('game-board');
  const floater = document.getElementById('drag-floater');
  if (!pile || !floater) return;
  let dragTarget = null; const HALF = 30, LIFT = 50;
  pile.addEventListener('pointerdown', (e) => {
    const stone = e.target.closest('.pile-stone'); if (!stone) return;
    if (!selfState || gs.phase !== 'playing' || selfState.currentTurnPlayerId !== selfPlayerId) return;
    e.preventDefault(); isDragging = true; dragTarget = stone;
    floater.style.display = 'block'; floater.style.left = (e.clientX - HALF) + 'px'; floater.style.top = (e.clientY - LIFT - HALF) + 'px';
    floater.className = 'drag-floater s' + selfState.myStoneNumber;
    stone.setPointerCapture(e.pointerId); stone.style.opacity = '0.3';
  });
  pile.addEventListener('pointermove', (e) => {
    if (!isDragging) return; e.preventDefault();
    floater.style.left = (e.clientX - HALF) + 'px'; floater.style.top = (e.clientY - LIFT - HALF) + 'px';
    const pos = getIntersection(canvas, e.clientX, e.clientY - LIFT);
    if (pos && gs.board && gs.board[pos.row][pos.col] === 0) previewPos = pos; else previewPos = null;
    redrawBoard();
  });
  pile.addEventListener('pointerup', () => {
    if (!isDragging) return; isDragging = false; floater.style.display = 'none';
    if (dragTarget) dragTarget.style.opacity = ''; dragTarget = null;
    if (previewPos) { document.getElementById('btn-confirm').disabled = false; redrawBoard(); }
  });
  pile.addEventListener('pointercancel', () => { isDragging = false; floater.style.display = 'none'; if (dragTarget) dragTarget.style.opacity = ''; dragTarget = null; previewPos = null; redrawBoard(); });
}

function redrawBoard() {
  const canvas = document.getElementById('game-board');
  if (canvas && selfState && selfState.board)
    drawBoard(canvas, selfState.board, { lastMove: selfState.lastMove, previewPos, previewStone: selfState.myStoneNumber });
}

// ── Helpers ───────────────────────────────────────────────────────────
function esc(str) { const el = document.createElement('span'); el.textContent = str; return el.innerHTML; }
function toast(text, type = 'success') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = text;
  container.appendChild(el); setTimeout(() => el.remove(), 2500);
}

// ── Event listeners ───────────────────────────────────────────────────
document.getElementById('btn-join').addEventListener('click', () => {
  const btn = document.getElementById('btn-join'); if (btn.disabled) return;
  btn.disabled = true; selfJoin(); setTimeout(() => { btn.disabled = false; }, 3000);
});
document.getElementById('player-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btn-join').click(); });
document.getElementById('btn-start-game').addEventListener('click', () => handleStartGame('self'));
document.getElementById('btn-add-bot').addEventListener('click', () => { if (gs.phase !== 'lobby' || gs.players.length >= 4) return; addBot(); });
document.getElementById('btn-remove-bot').addEventListener('click', () => handleRemoveBot('self'));
document.getElementById('bot-level').addEventListener('change', (e) => handleSetBotLevel('self', { level: Number(e.target.value) }));
document.getElementById('btn-play-again').addEventListener('click', () => handleRestart('self'));
document.getElementById('btn-undo-move').addEventListener('click', () => {
  if (gs.players.length <= 1 || !connections.size) { applyUndo(); lastMoveWasMine = false; return; }
  // Build undo request
  undoRequest = { requesterId: selfPlayerId, votes: new Map([[selfPlayerId, true]]), required: gs.players.filter(p => !p.isBot && p.connected).length };
  const me = gs.players.find(p => p.id === selfPlayerId);
  for (const [, vc] of connections.entries()) { if (vc.open) vc.send({ type: 'undo-request', requesterId: selfPlayerId, requesterName: me?.name ?? '?' }); }
  toast('Asking others…', 'success');
});

// ── Init ──────────────────────────────────────────────────────────────
resetGs();
initAvatarBuilder();
setupBoardInteraction();
renderScreen();
window.addEventListener('resize', () => { if (gs && gs.phase === 'playing') sizeBoard(); });
