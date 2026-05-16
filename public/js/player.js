// =====================================================================
// STONES OF FIVE — PLAYER
// =====================================================================
// Connects to host via Trystero (BitTorrent signaling) on GitHub Pages,
// or via local WebSocket relay when running node server.js on LAN.
// Room code is in the URL: ?room=<code>
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

let peer = null;
let conn = null;
let playerId = null;
let state = null;
let kicked = false;
let avatarChoice = { drawing: null, bgColor: BG_COLORS[0] };
let previewPos = null;
let boardLayout = null;
let isDragging = false;
let lastMoveWasMine = false;
let undoRequestActive = null;

// ── Device identity ───────────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('sof-device-id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    localStorage.setItem('sof-device-id', id);
  }
  return id;
}
function saveProfile(name, avatar) {
  localStorage.setItem('sof-name', name);
  localStorage.setItem('sof-avatar', JSON.stringify(avatar));
}
function loadProfile() {
  const name = localStorage.getItem('sof-name');
  let avatar = null;
  try { avatar = JSON.parse(localStorage.getItem('sof-avatar') || 'null'); } catch(e) {}
  return { name, avatar };
}
const deviceId = getDeviceId();

// ── Sound effects ─────────────────────────────────────────────────────
let audioCtx = null;
function getAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }
function playTone(freq1, freq2, type, dur, vol = 0.2) {
  const ctx = getAudio();
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = type; osc.frequency.setValueAtTime(freq1, ctx.currentTime);
  if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, ctx.currentTime + dur);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + dur);
  osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
}
function playPlaceSound()   { playTone(600, 400, 'sine', 0.12); }
function playCaptureSound() { playTone(300, 1200, 'sawtooth', 0.2); }
function playYourTurnSound() { [523,659,784].forEach((f,i) => setTimeout(() => playTone(f, 0, 'sine', 0.15), i*100)); }
function playWinSound()     { [523,659,784,1047].forEach((f,i) => setTimeout(() => playTone(f, 0, 'triangle', 0.3, 0.2), i*150)); }
function playErrorSound()   { playTone(200, 120, 'square', 0.2, 0.15); }

// ── Avatar builder ────────────────────────────────────────────────────
let drawCtx, drawCanvas, drawStrokes = [], currentStroke = null, drawColor = DRAW_COLORS[0], isDrawing = false;

function initAvatarBuilder() {
  drawCanvas = document.getElementById('draw-canvas');
  drawCtx = drawCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = drawCanvas.getBoundingClientRect();
  drawCanvas.width = rect.width * dpr; drawCanvas.height = rect.height * dpr;
  drawCtx.scale(dpr, dpr);

  const colorsEl = document.getElementById('draw-colors');
  colorsEl.innerHTML = DRAW_COLORS.map(c =>
    `<div class="draw-color ${c === drawColor ? 'selected' : ''}" data-color="${c}" style="background:${c};border:1px solid #ccc"></div>`
  ).join('');
  colorsEl.addEventListener('click', (e) => {
    const el = e.target.closest('.draw-color'); if (!el) return;
    colorsEl.querySelectorAll('.draw-color').forEach(d => d.classList.remove('selected'));
    el.classList.add('selected'); drawColor = el.dataset.color;
  });

  const colorContainer = document.getElementById('color-options');
  colorContainer.innerHTML = BG_COLORS.map(c =>
    `<div class="color-option ${c === avatarChoice.bgColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`
  ).join('');
  colorContainer.addEventListener('click', (e) => {
    const opt = e.target.closest('.color-option'); if (!opt) return;
    colorContainer.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected'); avatarChoice.bgColor = opt.dataset.color;
    redrawCanvas(); updateAvatarPreview();
  });

  drawCanvas.addEventListener('pointerdown', onDrawStart);
  drawCanvas.addEventListener('pointermove', onDrawMove);
  drawCanvas.addEventListener('pointerup', onDrawEnd);
  drawCanvas.addEventListener('pointerleave', onDrawEnd);
  document.getElementById('btn-undo').addEventListener('click', () => { drawStrokes.pop(); redrawCanvas(); updateAvatarPreview(); });
  document.getElementById('btn-clear').addEventListener('click', () => { drawStrokes = []; redrawCanvas(); updateAvatarPreview(); });

  if (avatarChoice.drawing) {
    const img = new Image();
    img.onload = () => { drawCtx.drawImage(img, 0, 0, drawCanvas.getBoundingClientRect().width, drawCanvas.getBoundingClientRect().height); drawStrokes = [{ restored: true }]; updateAvatarPreview(); };
    img.src = avatarChoice.drawing;
  } else { redrawCanvas(); }
  updateAvatarPreview();
}

function getCanvasPos(e) { const r = drawCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function onDrawStart(e) { e.preventDefault(); drawCanvas.setPointerCapture(e.pointerId); isDrawing = true; const pos = getCanvasPos(e); currentStroke = { color: drawColor, width: 3, points: [pos] }; if (drawStrokes.length === 1 && drawStrokes[0].restored) drawStrokes = []; }
function onDrawMove(e) {
  if (!isDrawing || !currentStroke) return; e.preventDefault();
  const pos = getCanvasPos(e); currentStroke.points.push(pos);
  const pts = currentStroke.points;
  drawCtx.beginPath(); drawCtx.strokeStyle = currentStroke.color; drawCtx.lineWidth = currentStroke.width; drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';
  if (pts.length >= 2) { drawCtx.moveTo(pts[pts.length-2].x, pts[pts.length-2].y); drawCtx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y); }
  drawCtx.stroke();
}
function onDrawEnd(e) {
  if (!isDrawing || !currentStroke) return; isDrawing = false;
  if (currentStroke.points.length >= 2) drawStrokes.push(currentStroke);
  else if (currentStroke.points.length === 1) { const p = currentStroke.points[0]; drawCtx.beginPath(); drawCtx.fillStyle = currentStroke.color; drawCtx.arc(p.x, p.y, currentStroke.width, 0, Math.PI*2); drawCtx.fill(); drawStrokes.push(currentStroke); }
  currentStroke = null; updateAvatarPreview();
}
function redrawCanvas() {
  const rect = drawCanvas.getBoundingClientRect();
  drawCtx.clearRect(0, 0, rect.width, rect.height);
  drawCtx.fillStyle = avatarChoice.bgColor || BG_COLORS[0]; drawCtx.fillRect(0, 0, rect.width, rect.height);
  for (const stroke of drawStrokes) {
    if (stroke.restored) continue;
    const pts = stroke.points;
    drawCtx.beginPath(); drawCtx.strokeStyle = stroke.color; drawCtx.lineWidth = stroke.width; drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';
    if (pts.length === 1) { drawCtx.fillStyle = stroke.color; drawCtx.arc(pts[0].x, pts[0].y, stroke.width, 0, Math.PI*2); drawCtx.fill(); }
    else { drawCtx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) drawCtx.lineTo(pts[i].x, pts[i].y); drawCtx.stroke(); }
  }
}
function getDrawingDataUrl() {
  const exp = document.createElement('canvas'); exp.width = 60; exp.height = 60;
  const ectx = exp.getContext('2d');
  ectx.fillStyle = avatarChoice.bgColor || BG_COLORS[0]; ectx.fillRect(0, 0, 60, 60);
  ectx.drawImage(drawCanvas, 0, 0, drawCanvas.width, drawCanvas.height, 0, 0, 60, 60);
  return exp.toDataURL('image/png');
}
function updateAvatarPreview() {
  const preview = document.getElementById('avatar-preview');
  preview.textContent = ''; preview.style.background = avatarChoice.bgColor;
  if (drawStrokes.length > 0) {
    const url = getDrawingDataUrl(); avatarChoice.drawing = url;
    preview.style.backgroundImage = `url(${url})`; preview.style.backgroundSize = 'cover';
  } else { avatarChoice.drawing = null; preview.style.backgroundImage = ''; }
}

// ── PeerJS connection ─────────────────────────────────────────────────
let sendQueue = [];
function send(msg) {
  if (conn && conn.open) conn.send(msg);
  else sendQueue.push(msg);
}
function flushQueue() {
  while (sendQueue.length && conn && conn.open) conn.send(sendQueue.shift());
}

function connect() {
  const roomId = new URLSearchParams(location.search).get('room');
  if (!roomId) { showScreenById('screen-no-room'); return; }

  if (isLanMode()) {
    peer = new LocalPlayerPeer();
    peer.on('open', () => {
      conn = peer.connect(roomId, { reliable: true });
      conn.on('open', () => { send({ type: 'reconnect', deviceId }); flushQueue(); });
      conn.on('data', handleServerMsg);
      conn.on('close', () => { if (!kicked) setTimeout(connect, 2000); });
      conn.on('error', () => { if (!kicked) setTimeout(connect, 2000); });
    });
    peer.on('error', () => { if (!kicked) setTimeout(connect, 3000); });
    return;
  }
  // Trystero: BitTorrent-signaled WebRTC, no server needed
  peer = new TrysteroPlayerPeer('nksimmons-stones-of-five');
  peer.on('open', () => {
    conn = peer.connect(roomId);
    conn.on('open', () => {
      send({ type: 'reconnect', deviceId });
      flushQueue();
    });
    conn.on('data', handleServerMsg);
    conn.on('close', () => { if (!kicked) setTimeout(connect, 2000); });
    conn.on('error', () => { if (!kicked) setTimeout(connect, 2000); });
  });
  peer.on('error', () => { if (!kicked) setTimeout(connect, 3000); });
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'joined':
      playerId = msg.playerId; state = msg.data; render(); break;
    case 'reconnected':
      playerId = msg.playerId; state = msg.data; render(); break;
    case 'unknown-device':
      render(); break;
    case 'state': {
      const prev = state; state = msg.data;
      if (prev && prev.phase === 'playing' && state.phase === 'playing') {
        if (state.lastMove && (!prev.lastMove || prev.lastMove.row !== state.lastMove.row || prev.lastMove.col !== state.lastMove.col)) {
          (state.lastCaptures && state.lastCaptures.length > 0) ? playCaptureSound() : playPlaceSound();
          if (navigator.vibrate) navigator.vibrate(30);
        }
        if (state.currentTurnPlayerId === playerId && prev.currentTurnPlayerId !== playerId) {
          lastMoveWasMine = false; playYourTurnSound();
          if (navigator.vibrate) navigator.vibrate([40,30,40]);
        }
      }
      if (state.phase === 'gameOver' && prev && prev.phase !== 'gameOver') {
        if (state.winner && state.winner.playerId === playerId) playWinSound();
      }
      render(); break;
    }
    case 'move-result':
      if (!msg.valid) { toast(msg.reason || 'Invalid move', 'error'); playErrorSound(); }
      else lastMoveWasMine = true;
      break;
    case 'undo-request':
      undoRequestActive = { requesterId: msg.requesterId, requesterName: msg.requesterName };
      showUndoVotePrompt(msg.requesterName); break;
    case 'undo-result':
      dismissUndoPrompt(); undoRequestActive = null; lastMoveWasMine = false;
      toast(msg.approved ? 'Move undone!' : 'Undo rejected', msg.approved ? 'success' : 'error'); break;
    case 'undo-pending': toast('Waiting for others to approve…', 'success'); break;
    case 'error': toast(msg.message, 'error'); break;
    case 'kicked':
      kicked = true; playerId = null; state = null; alert('You have been kicked.'); render(); break;
  }
}

// ── Render ────────────────────────────────────────────────────────────
function render() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  if (!playerId) { document.getElementById('screen-join').classList.add('active'); return; }
  const screen = document.getElementById(`screen-${state.phase}`);
  if (screen) screen.classList.add('active');
  if (state.phase === 'lobby') renderLobby();
  else if (state.phase === 'playing') renderPlaying();
  else if (state.phase === 'gameOver') renderGameOver();
}

function showScreenById(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = document.getElementById(id); if (s) s.classList.add('active');
}

function renderLobby() {
  updateHostControls();
  const container = document.getElementById('lobby-player-list');
  if (!container || !state.players) return;
  container.innerHTML = `<div class="scoreboard">${state.players.map(p => `
    <div class="player-card" ${p.id === playerId ? 'style="border:2px solid var(--accent)"' : ''}>
      <div class="avatar" style="background:${p.avatar.bgColor}">${renderAvatarContent(p.avatar)}</div>
      <div class="player-name">${esc(p.name)}</div>
      <span class="stone-dot s${p.stoneNumber}"></span>
    </div>`).join('')}</div>`;
}

function renderPlaying() {
  previewPos = null;
  document.getElementById('btn-confirm').disabled = true;
  const isMyTurn = state.currentTurnPlayerId === playerId;
  const cur = state.players.find(p => p.id === state.currentTurnPlayerId);
  const turnEl = document.getElementById('turn-indicator');
  if (isMyTurn) {
    turnEl.className = 'turn-indicator my-turn';
    turnEl.innerHTML = `<span class="stone-dot stone-dot-large s${state.myStoneNumber}"></span> Your Turn`;
  } else if (cur) {
    turnEl.className = 'turn-indicator waiting';
    turnEl.innerHTML = `<span class="stone-dot stone-dot-large s${cur.stoneNumber}"></span> ${esc(cur.name)}'s Turn`;
  }
  sizeBoard();
  const tray = document.getElementById('stone-tray');
  const undoBtn = document.getElementById('btn-undo-move');
  if (tray) { tray.style.opacity = isMyTurn ? '' : '0.35'; tray.style.pointerEvents = isMyTurn ? '' : 'none'; }
  renderStonePile();
  if (undoBtn) { const canUndo = lastMoveWasMine && !isMyTurn; undoBtn.disabled = !canUndo; undoBtn.style.opacity = canUndo ? '' : '0.3'; }
  const bar = document.getElementById('captures-bar');
  bar.innerHTML = state.players.map(p =>
    `<div class="capture-info"><span class="stone-dot s${p.stoneNumber}"></span><span>${esc(p.name)}</span><span class="capture-count">${p.captures}/5</span></div>`
  ).join('');
}

function sizeBoard() {
  const canvas = document.getElementById('game-board');
  const container = canvas.parentElement;
  const size = Math.min(container.clientWidth, container.clientHeight);
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  boardLayout = drawBoard(canvas, state.board, { lastMove: state.lastMove, previewPos, previewStone: state.myStoneNumber });
}

function renderStonePile() {
  const pile = document.getElementById('stone-pile');
  if (!pile || !state.myStoneNumber) return;
  pile.innerHTML = PILE_POSITIONS.map((p, i) =>
    `<div class="pile-stone s${state.myStoneNumber}" style="left:${p.x}px;top:${p.y}px;transform:rotate(${p.rot}deg)" data-pile="${i}"></div>`
  ).join('');
}

function renderGameOver() {
  updateHostControls();
  const wd = document.getElementById('winner-info');
  if (state.winner && state.winner.playerId) {
    const reason = state.winner.reason === 'five-in-a-row' ? 'Five in a Row!' : 'Five Captures!';
    const isMe = state.winner.playerId === playerId;
    wd.innerHTML = `<h1>${isMe ? '🎉 You Win!' : '🏆 Game Over!'}</h1><div class="winner-name">${esc(state.winner.name)}</div><div class="win-reason">${reason}</div>`;
  } else {
    wd.innerHTML = `<h1>🤝 Draw!</h1>`;
  }
  const canvas = document.getElementById('final-board');
  if (canvas && state.board) drawBoard(canvas, state.board, { lastMove: state.lastMove });
}

// ── Board interaction ─────────────────────────────────────────────────
function setupBoardInteraction() {
  const canvas = document.getElementById('game-board');
  let boardDragging = false;

  canvas.addEventListener('click', (e) => {
    if (isDragging || boardDragging) return;
    if (!state || state.phase !== 'playing' || state.currentTurnPlayerId !== playerId) return;
    const pos = getIntersection(canvas, e.clientX, e.clientY);
    if (!pos) { previewPos = null; document.getElementById('btn-confirm').disabled = true; redrawGameBoard(); return; }
    previewPos = pos; document.getElementById('btn-confirm').disabled = false; redrawGameBoard();
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!state || state.phase !== 'playing' || state.currentTurnPlayerId !== playerId) return;
    boardDragging = true; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!boardDragging) return; e.preventDefault();
    const pos = getIntersection(canvas, e.clientX, e.clientY);
    if (pos && state.board && state.board[pos.row][pos.col] === 0) previewPos = pos;
    redrawGameBoard();
  });
  canvas.addEventListener('pointerup', () => {
    if (!boardDragging) return; boardDragging = false;
    if (previewPos) document.getElementById('btn-confirm').disabled = false;
  });
  canvas.addEventListener('pointercancel', () => { boardDragging = false; });
  canvas.style.touchAction = 'none';

  document.getElementById('btn-confirm').addEventListener('click', () => {
    if (!previewPos) return;
    send({ type: 'place-stone', row: previewPos.row, col: previewPos.col });
    previewPos = null; document.getElementById('btn-confirm').disabled = true;
  });

  setupStoneDrag();
}

function setupStoneDrag() {
  const pile = document.getElementById('stone-pile');
  const canvas = document.getElementById('game-board');
  const floater = document.getElementById('drag-floater');
  if (!pile || !floater) return;
  let dragTarget = null;
  const HALF = 30, LIFT = 50;

  pile.addEventListener('pointerdown', (e) => {
    const stone = e.target.closest('.pile-stone'); if (!stone) return;
    if (!state || state.phase !== 'playing' || state.currentTurnPlayerId !== playerId) return;
    e.preventDefault(); isDragging = true; dragTarget = stone;
    floater.style.display = 'block';
    floater.style.left = (e.clientX - HALF) + 'px'; floater.style.top = (e.clientY - LIFT - HALF) + 'px';
    floater.className = 'drag-floater s' + state.myStoneNumber;
    stone.setPointerCapture(e.pointerId); stone.style.opacity = '0.3';
  });
  pile.addEventListener('pointermove', (e) => {
    if (!isDragging) return; e.preventDefault();
    floater.style.left = (e.clientX - HALF) + 'px'; floater.style.top = (e.clientY - LIFT - HALF) + 'px';
    const pos = getIntersection(canvas, e.clientX, e.clientY - LIFT);
    if (pos && state.board && state.board[pos.row][pos.col] === 0) previewPos = pos; else previewPos = null;
    redrawGameBoard();
  });
  pile.addEventListener('pointerup', () => {
    if (!isDragging) return; isDragging = false; floater.style.display = 'none';
    if (dragTarget) dragTarget.style.opacity = ''; dragTarget = null;
    if (previewPos) { document.getElementById('btn-confirm').disabled = false; redrawGameBoard(); }
  });
  pile.addEventListener('pointercancel', () => {
    isDragging = false; floater.style.display = 'none';
    if (dragTarget) dragTarget.style.opacity = ''; dragTarget = null; previewPos = null; redrawGameBoard();
  });
}

function redrawGameBoard() {
  const canvas = document.getElementById('game-board');
  if (canvas && state && state.board)
    boardLayout = drawBoard(canvas, state.board, { lastMove: state.lastMove, previewPos, previewStone: state.myStoneNumber });
}

// ── Undo UI ───────────────────────────────────────────────────────────
function showUndoVotePrompt(requesterName) {
  dismissUndoPrompt();
  const overlay = document.createElement('div');
  overlay.id = 'undo-overlay'; overlay.className = 'undo-overlay';
  overlay.innerHTML = `<div class="undo-prompt card"><h3>🙏 ${esc(requesterName)} wants to undo</h3><p style="margin:0.75rem 0;color:var(--text-dim)">"pls lemme redo"</p><div style="display:flex;gap:1rem;justify-content:center"><button class="btn btn-success undo-vote-btn" data-vote="approve" style="flex:1">k</button><button class="btn undo-vote-btn" data-vote="reject" style="flex:1;background:var(--danger);color:white">nah</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.undo-vote-btn').forEach(btn => {
    btn.addEventListener('click', () => { send({ type: 'undo-vote', approve: btn.dataset.vote === 'approve' }); dismissUndoPrompt(); });
  });
}
function dismissUndoPrompt() { const el = document.getElementById('undo-overlay'); if (el) el.remove(); undoRequestActive = null; }

// ── Host controls (if this player is the host) ────────────────────────
function isHostPlayer() { return state && state.hostPlayerId && state.hostPlayerId === playerId; }
function updateHostControls() {
  const isHP = isHostPlayer();
  const startBtn = document.getElementById('btn-start-game');
  const lobbyWait = document.getElementById('lobby-waiting-msg');
  if (startBtn) startBtn.style.display = isHP ? '' : 'none';
  if (lobbyWait) lobbyWait.style.display = isHP ? 'none' : '';
  const botControls = document.getElementById('player-bot-controls');
  const addBot = document.getElementById('player-btn-add-bot');
  const removeBot = document.getElementById('player-btn-remove-bot');
  const botLevel = document.getElementById('player-bot-level');
  const hasBots = state && state.players && state.players.some(p => p.isBot);
  const isFull = state && state.players && state.players.length >= 4;
  if (botControls) botControls.style.display = isHP ? '' : 'none';
  if (addBot) addBot.style.display = (isHP && !isFull) ? '' : 'none';
  if (removeBot) removeBot.style.display = (isHP && hasBots) ? '' : 'none';
  if (botLevel && state) botLevel.value = String(state.botChallengeLevel);
  const goControls = document.getElementById('gameover-host-controls');
  const goWait = document.getElementById('gameover-waiting-msg');
  if (goControls) goControls.style.display = isHP ? '' : 'none';
  if (goWait) goWait.style.display = isHP ? 'none' : '';
}

// ── Helpers ───────────────────────────────────────────────────────────
function renderAvatarContent(avatar) {
  if (avatar.drawing) return `<img src="${avatar.drawing}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  return '🎯';
}
function esc(str) { const el = document.createElement('span'); el.textContent = str; return el.innerHTML; }
function toast(text, type = 'success') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = text;
  container.appendChild(el); setTimeout(() => el.remove(), 2500);
}

// ── Event wiring ──────────────────────────────────────────────────────
document.getElementById('btn-join').addEventListener('click', () => {
  const btn = document.getElementById('btn-join');
  if (btn.disabled) return;
  const name = document.getElementById('player-name').value.trim();
  if (!name) { document.getElementById('player-name').focus(); return; }
  btn.disabled = true;
  saveProfile(name, avatarChoice);
  send({ type: 'player-join', name, avatar: avatarChoice, deviceId });
  setTimeout(() => { btn.disabled = false; }, 3000);
});
document.getElementById('player-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btn-join').click(); });
document.getElementById('btn-start-game').addEventListener('click', () => send({ type: 'start-game' }));
document.getElementById('player-btn-add-bot').addEventListener('click', () => send({ type: 'add-bot' }));
document.getElementById('player-btn-remove-bot').addEventListener('click', () => send({ type: 'remove-bot' }));
document.getElementById('player-bot-level').addEventListener('change', (e) => send({ type: 'set-bot-level', level: Number(e.target.value) }));
document.getElementById('btn-play-again').addEventListener('click', () => send({ type: 'restart' }));
document.getElementById('btn-undo-move').addEventListener('click', () => { send({ type: 'undo-request' }); toast('Asking others…', 'success'); });

// ── Init ──────────────────────────────────────────────────────────────
(function prefill() {
  const p = loadProfile();
  if (p.name) document.getElementById('player-name').value = p.name;
  if (p.avatar) avatarChoice = { ...avatarChoice, ...p.avatar };
})();
initAvatarBuilder();
setupBoardInteraction();
connect();
window.addEventListener('resize', () => { if (state && state.phase === 'playing') sizeBoard(); });
