// Stones of Five game engine — browser-compatible (no module.exports)
const BOARD_SIZE = 19;
const CENTER = 9;
const WIN_LENGTH = 5;
const CAPTURE_WIN = 5; // 5 pairs to win
const DIRECTIONS = [[0,1],[1,0],[1,1],[1,-1]];
const ALL_DIRS = [[0,1],[0,-1],[1,0],[-1,0],[1,1],[-1,-1],[1,-1],[-1,1]];

function createBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
}

function isValidMove(board, row, col) {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE)
    return { valid: false, reason: 'Out of bounds' };
  if (board[row][col] !== 0)
    return { valid: false, reason: 'Position occupied' };
  return { valid: true };
}

function placeStone(board, row, col, stoneNumber) {
  board[row][col] = stoneNumber;
  return checkCaptures(board, row, col, stoneNumber);
}

function checkCaptures(board, row, col, stoneNumber) {
  const captures = [];
  for (const [dr, dc] of ALL_DIRS) {
    const r1 = row + dr, c1 = col + dc;
    const r2 = row + 2 * dr, c2 = col + 2 * dc;
    const r3 = row + 3 * dr, c3 = col + 3 * dc;
    if (r3 < 0 || r3 >= BOARD_SIZE || c3 < 0 || c3 >= BOARD_SIZE) continue;
    if (r1 < 0 || r1 >= BOARD_SIZE || c1 < 0 || c1 >= BOARD_SIZE) continue;
    if (r2 < 0 || r2 >= BOARD_SIZE || c2 < 0 || c2 >= BOARD_SIZE) continue;
    const s1 = board[r1][c1], s2 = board[r2][c2], s3 = board[r3][c3];
    if (s1 !== 0 && s1 !== stoneNumber && s1 === s2 && s3 === stoneNumber) {
      captures.push({ row: r1, col: c1 });
      captures.push({ row: r2, col: c2 });
      board[r1][c1] = 0;
      board[r2][c2] = 0;
    }
  }
  return captures;
}

function checkWin(board, row, col, stoneNumber, captureCount) {
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    for (let i = 1; i <= 4; i++) {
      const r = row + dr * i, c = col + dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== stoneNumber) break;
      count++;
    }
    for (let i = 1; i <= 4; i++) {
      const r = row - dr * i, c = col - dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== stoneNumber) break;
      count++;
    }
    if (count >= WIN_LENGTH) return 'five-in-a-row';
  }
  if (captureCount >= CAPTURE_WIN) return 'captures';
  return null;
}

function isBoardFull(board) {
  return board.every(row => row.every(cell => cell !== 0));
}

function countLine(board, row, col, stoneNum, dr, dc) {
  let count = 1, openEnds = 0;
  let r = row + dr, c = col + dc;
  while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === stoneNum) { count++; r += dr; c += dc; }
  if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === 0) openEnds++;
  r = row - dr; c = col - dc;
  while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === stoneNum) { count++; r -= dr; c -= dc; }
  if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === 0) openEnds++;
  return { count, openEnds };
}

function scoreMove(board, row, col, stoneNum, allStoneNums, captures, challengeLevel) {
  const testBoard = board.map(r => [...r]);
  testBoard[row][col] = stoneNum;
  const caps = checkCaptures(testBoard, row, col, stoneNum);
  const capturedPairs = caps.length / 2;
  const totalCaptures = (captures[stoneNum] || 0) + capturedPairs;

  let score = 0;
  if (checkWin(testBoard, row, col, stoneNum, totalCaptures)) return 1000000;
  score += capturedPairs * 8000;
  if (totalCaptures >= CAPTURE_WIN) return 1000000;

  for (const [dr, dc] of DIRECTIONS) {
    const li = countLine(testBoard, row, col, stoneNum, dr, dc);
    if (li.count >= 4 && li.openEnds >= 1) score += 50000;
    else if (li.count === 3 && li.openEnds === 2) score += 5000;
    else if (li.count === 3 && li.openEnds === 1) score += 800;
    else if (li.count === 2 && li.openEnds === 2) score += 200;
    else if (li.count === 2 && li.openEnds === 1) score += 50;
    else if (li.count === 1 && li.openEnds === 2) score += 10;
  }

  for (const oppStone of allStoneNums) {
    if (oppStone === stoneNum) continue;
    const oppBoard = board.map(r => [...r]);
    oppBoard[row][col] = oppStone;
    const oppCaps = checkCaptures(oppBoard, row, col, oppStone);
    const oppTotal = (captures[oppStone] || 0) + oppCaps.length / 2;
    if (checkWin(oppBoard, row, col, oppStone, oppTotal)) score += 500000;
    score += (oppCaps.length / 2) * 6000;
    for (const [dr, dc] of DIRECTIONS) {
      const li = countLine(oppBoard, row, col, oppStone, dr, dc);
      if (li.count >= 4 && li.openEnds >= 1) score += 40000;
      else if (li.count === 3 && li.openEnds === 2) score += 4000;
      else if (li.count === 3 && li.openEnds === 1) score += 600;
      else if (li.count === 2 && li.openEnds === 2) score += 100;
    }
  }

  const distFromCenter = Math.abs(row - CENTER) + Math.abs(col - CENTER);
  score += Math.max(0, 20 - distFromCenter);
  let nearStones = 0;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr, c = col + dc;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] !== 0) nearStones++;
    }
  }
  score += nearStones * 3;
  return score;
}

function getBotMove(board, stoneNum, allStoneNums, captures, moveNumber, playerCount, challengeLevel) {
  const hasStones = board.some(r => r.some(c => c !== 0));
  const validMoves = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (!isValidMove(board, r, c).valid) continue;
      if (hasStones) {
        let nearby = false;
        for (let dr = -3; dr <= 3 && !nearby; dr++) {
          for (let dc = -3; dc <= 3 && !nearby; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] !== 0) nearby = true;
          }
        }
        if (!nearby) continue;
      }
      validMoves.push({ row: r, col: c, score: scoreMove(board, r, c, stoneNum, allStoneNums, captures, challengeLevel) });
    }
  }
  if (validMoves.length === 0) {
    for (let r = 0; r < BOARD_SIZE; r++)
      for (let c = 0; c < BOARD_SIZE; c++)
        if (isValidMove(board, r, c).valid) return { row: r, col: c };
    return null;
  }
  validMoves.sort((a, b) => b.score - a.score);
  if (challengeLevel >= 4) return validMoves[0];
  const sizes = [10, 5, 3];
  const pool = validMoves.slice(0, Math.min(sizes[challengeLevel - 1] || 3, validMoves.length));
  const minScore = Math.min(...pool.map(m => m.score));
  const weights = pool.map(m => m.score - minScore + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (let i = 0; i < pool.length; i++) { rand -= weights[i]; if (rand <= 0) return pool[i]; }
  return pool[0];
}
