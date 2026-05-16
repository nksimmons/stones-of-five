// Shared Stones of Five board renderer
// BOARD_SIZE is declared in game.js which is loaded first
const STONE_COLORS = [null, '#e0e0e0', '#1a1a1a', '#3b82f6', '#ef4444'];
const STONE_HIGHLIGHTS = [null, '#333', '#fff', '#fff', '#fff'];
const STAR_POINTS = [3, 9, 15];

function drawBoard(canvas, board, options = {}) {
  const { lastMove, previewPos, previewStone, playerColors } = options;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const size = Math.min(w, h);
  const padding = size * 0.04;
  const cellSize = (size - 2 * padding) / (BOARD_SIZE - 1);

  // Wood background
  ctx.fillStyle = '#d4a76a';
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < BOARD_SIZE; i++) {
    const offset = padding + i * cellSize;
    ctx.beginPath();
    ctx.moveTo(padding, offset);
    ctx.lineTo(size - padding, offset);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(offset, padding);
    ctx.lineTo(offset, size - padding);
    ctx.stroke();
  }

  // Star points
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  for (const r of STAR_POINTS) {
    for (const c of STAR_POINTS) {
      ctx.beginPath();
      ctx.arc(padding + c * cellSize, padding + r * cellSize, cellSize * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const stoneRadius = cellSize * 0.43;

  // Stones
  if (board) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 0) continue;
        const x = padding + c * cellSize;
        const y = padding + r * cellSize;
        drawStone(ctx, x, y, stoneRadius, board[r][c]);
      }
    }
  }

  // Last move marker (small dot in contrasting color)
  if (lastMove && board && board[lastMove.row] && board[lastMove.row][lastMove.col]) {
    const x = padding + lastMove.col * cellSize;
    const y = padding + lastMove.row * cellSize;
    const sn = board[lastMove.row][lastMove.col];
    ctx.fillStyle = STONE_HIGHLIGHTS[sn] || '#fff';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(x, y, stoneRadius * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Preview stone (semi-transparent)
  if (previewPos && previewStone) {
    const x = padding + previewPos.col * cellSize;
    const y = padding + previewPos.row * cellSize;
    ctx.globalAlpha = 0.5;
    drawStone(ctx, x, y, stoneRadius, previewStone);
    ctx.globalAlpha = 1;
    // Pulsing ring
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, stoneRadius + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  return { padding, cellSize, stoneRadius };
}

function drawStone(ctx, x, y, radius, stoneNum) {
  // Shadow
  ctx.beginPath();
  ctx.arc(x + 1.5, y + 1.5, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fill();

  // Stone with gradient
  const grad = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.3, radius * 0.05, x, y, radius);
  if (stoneNum === 1) { // white
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, '#bbb');
  } else if (stoneNum === 2) { // black
    grad.addColorStop(0, '#555');
    grad.addColorStop(1, '#111');
  } else if (stoneNum === 3) { // blue
    grad.addColorStop(0, '#60a5fa');
    grad.addColorStop(1, '#2563eb');
  } else { // red
    grad.addColorStop(0, '#f87171');
    grad.addColorStop(1, '#dc2626');
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = stoneNum === 1 ? '#999' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

function getIntersection(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  const padding = size * 0.04;
  const cellSize = (size - 2 * padding) / (BOARD_SIZE - 1);

  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const col = Math.round((x - padding) / cellSize);
  const row = Math.round((y - padding) / cellSize);

  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;

  // Check distance from intersection center
  const ix = padding + col * cellSize;
  const iy = padding + row * cellSize;
  const dist = Math.sqrt((x - ix) ** 2 + (y - iy) ** 2);
  if (dist > cellSize * 0.55) return null;

  return { row, col };
}
