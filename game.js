/* ===========================================================
   PUZZLE BATTALION — game.js
   Owns: puzzle grid (drag & drop placement + row clear) +
   battlefield sim/render. Knows NOTHING about networking
   directly — it only calls the hooks in Game.hooks, which
   net.js fills in. This keeps the game fully playable offline
   (solo sandbox) even with no P2P library.

   Puzzle mode: a tray of 3 upcoming pieces sits below the grid.
   Player presses & drags a piece; while held it floats a bit
   above the finger so it stays visible, and a green/red preview
   shows where it would land. Releasing over a valid spot locks
   it into the grid; releasing anywhere invalid just cancels the
   drag and the piece stays in the tray. No falling, no rotation.
   =========================================================== */

const Game = (() => {

  // ---------- constants ----------
  const COLS = 12, ROWS = 15;
  // battlefield "width": only affects how long a unit takes to walk from
  // base to base (toScreenX below normalizes by LANE_LEN, so the UI never
  // gets visually wider/longer — only travel time changes).
  const LANE_LEN = 1500;
  const BASE_MAX_HP = 3000;

  // how far above the finger a dragged piece floats, in units of one grid
  // cell — keeps the shape visible instead of hidden under the fingertip,
  // Block-Blast style: the piece hovers just clear of the finger and the
  // cell it snaps into is the one right under/above the touch point, not
  // wherever the piece's own center happens to be.
  const DRAG_LIFT_CELLS = 1.0;

  // ---------- unit stat sheet (thang điểm 0–10) ----------
  const UNIT_DEFS_RAW = {
    swordsman: { hpBase: 6, atkBase: 0.6, atkSpeedRating: 4,  speedRating: 4, range: 16,  radius: 11, color: '#e5484d' },
    archer:    { hpBase: 3, atkBase: 1,   atkSpeedRating: 8,  speedRating: 3, range: 130, radius: 9,  color: '#3aa0ff' },
    knight:    { hpBase: 4, atkBase: 0.7, atkSpeedRating: 10, speedRating: 7, range: 20,  radius: 13, color: '#4ee08a' }
  };
  const STAT_SCALE = { hp: 20, atk: 20, speedMax: 45 };

  const UNIT_DEFS = {};
  for (const [type, raw] of Object.entries(UNIT_DEFS_RAW)) {
    UNIT_DEFS[type] = {
      ...raw,
      hp: raw.hpBase * STAT_SCALE.hp,
      atk: raw.atkBase * STAT_SCALE.atk,
      cooldown: 10 / raw.atkSpeedRating,
      speed: (raw.speedRating / 10) * STAT_SCALE.speedMax
    };
  }
  const UNIT_TYPE_KEYS = Object.keys(UNIT_DEFS); // ['swordsman','archer','knight']

  // đơn vị mới triệu hồi được +40% tất cả chỉ số chiến đấu trong 1.5s
  const SPAWN_BUFF_MULT = 1.4;
  const SPAWN_BUFF_MS = 1500;

  const CELL_TYPE_WEIGHTS = { swordsman: 1/3, archer: 1/3, knight: 1/3 };

  function weightedRandomType(weights){
    const r = Math.random();
    let acc = 0;
    for (const type of UNIT_TYPE_KEYS) {
      acc += weights[type] || 0;
      if (r <= acc) return type;
    }
    return UNIT_TYPE_KEYS[UNIT_TYPE_KEYS.length - 1];
  }
  function randomCellType(){ return weightedRandomType(CELL_TYPE_WEIGHTS); }

  const CELL_FILL_DIST_BY_SIZE = {
    1: [0.20, 0.80],
    2: [0.20, 0.60, 0.20],
    3: [0.15, 0.55, 0.20, 0.10],
    4: [0.10, 0.50, 0.20, 0.15, 0.05],
    5: [0.08, 0.45, 0.20, 0.15, 0.08, 0.04]
  };
  const BLANK = 'blank';

  function pickFilledCellCount(total){
    const dist = CELL_FILL_DIST_BY_SIZE[total];
    if (!dist) return total;
    const r = Math.random();
    let acc = 0;
    for (let k = 0; k < dist.length; k++) {
      acc += dist[k];
      if (r <= acc) return k;
    }
    return dist.length - 1;
  }

  function assignCellTypes(total){
    const filledCount = pickFilledCellCount(total);
    const indices = Array.from({ length: total }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const filled = new Set(indices.slice(0, filledCount));
    const types = new Array(total).fill(BLANK);
    filled.forEach(i => { types[i] = randomCellType(); });
    return types;
  }

  // 3 độ khó "chơi với máy": khoảng cách giữa các lần máy triệu hồi quân,
  // tỉ lệ loại lính máy chọn, và powerMult — hệ số nhân sát thương/tốc độ
  // (và máu lúc triệu hồi) của lính bên máy, dùng để hạ sức mạnh bot ở độ
  // dễ xuống thấp hơn hẳn thay vì chỉ giãn nhịp triệu hồi (một mình nhịp
  // triệu hồi chậm hơn không đủ nếu mỗi lính vẫn đánh mạnh/nhanh như cũ).
  const BOT_DIFFICULTY = {
    easy:   { minGap: 6.5, maxGap: 10.0, weights: { swordsman: 0.7,  archer: 0.2,  knight: 0.1  }, powerMult: 0.5  },
    medium: { minGap: 3.5, maxGap: 5.5,  weights: { swordsman: 0.45, archer: 0.3,  knight: 0.25 }, powerMult: 0.8  },
    hard:   { minGap: 1.8, maxGap: 3.2,  weights: { swordsman: 0.3,  archer: 0.35, knight: 0.35 }, powerMult: 1.05 }
  };

  const SHAPES = {
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[0,1],[1,1],[2,1],[1,0]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]],
    DOT:    [[1,1]],
    DOMINO: [[1,1],[2,1]],
    TRIO:   [[1,1],[2,1],[3,1]],
    CORNER: [[1,1],[2,1],[1,2]],
    PLUS:   [[1,0],[0,1],[1,1],[2,1],[1,2]]
  };
  const SHAPE_KEYS = Object.keys(SHAPES);

  // ---------- state ----------
  let grid = makeEmptyGrid();      // mỗi ô lưu tên loại lính, BLANK, hoặc null
  let tray = [null, null, null];   // 3 khối tiếp theo hiện đang chờ ở thanh dưới
  let dragState = null;            // { slot, piece, w, h, tx, ty, valid } khi đang kéo
  let rowsCleared = 0;
  let paused = false;
  let gameOver = false;
  let started = false;

  let role = 'solo';       // 'solo' | 'host' | 'client'
  let mySide = 'A';        // 'A' (left) or 'B' (right)

  // simple "chơi với máy" bot: periodically spawns a random unit for side B
  let botEnabled = false;
  let botDifficulty = 'medium';
  let botTimer = BOT_DIFFICULTY[botDifficulty].minGap;

  // battle sim (authoritative when role is solo/host)
  let sim = { baseA: BASE_MAX_HP, baseB: BASE_MAX_HP, units: [], nextId: 1, over: false, winner: null };
  let lastRemoteState = null; // used when role === 'client'
  let groundDetails = null;   // cached perspective grass/rock speckles for the 3D floor

  const hooks = {
    onLocalRowCleared: null,   // (rowTypes: string[], rowsClearedTotal) => {}
    onGameOver: null           // (winnerSide) => {}
  };

  // ---------- canvases ----------
  let puzzleCv, puzzleCtx, fieldCv, fieldCtx, dragCv, dragCtx;
  let traySlots = []; // [{canvas, ctx}]
  const cell = () => puzzleCv.width / COLS;

  function makeEmptyGrid(){
    const g = [];
    for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill(null));
    return g;
  }

  // ---------- piece helpers ----------
  // normalize cells to a 0,0-based bounding box so all placement math can
  // ignore whatever raw offsets the SHAPES table happens to use.
  function normalizeCells(cells){
    const minX = Math.min(...cells.map(c => c[0]));
    const minY = Math.min(...cells.map(c => c[1]));
    return cells.map(([x, y]) => [x - minX, y - minY]);
  }

  function pieceBBox(cells){
    const w = Math.max(...cells.map(c => c[0])) + 1;
    const h = Math.max(...cells.map(c => c[1])) + 1;
    return { w, h };
  }

  function randomPiece(){
    const key = SHAPE_KEYS[Math.floor(Math.random() * SHAPE_KEYS.length)];
    const cells = normalizeCells(SHAPES[key].map(c => c.slice()));
    const types = assignCellTypes(cells.length);
    const { w, h } = pieceBBox(cells);
    return { key, cells, types, w, h };
  }

  function collidesAt(piece, tx, ty){
    for (const [cx, cy] of piece.cells) {
      const gx = tx + cx, gy = ty + cy;
      if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return true;
      if (grid[gy][gx]) return true;
    }
    return false;
  }

  function hasAnyPlacement(piece){
    if (!piece) return false;
    for (let ty = 0; ty <= ROWS - piece.h; ty++) {
      for (let tx = 0; tx <= COLS - piece.w; tx++) {
        if (!collidesAt(piece, tx, ty)) return true;
      }
    }
    return false;
  }

  // if none of the 3 pieces currently in the tray fit anywhere on the
  // board, soft-reset the grid instead of permanently jamming the player.
  function ensureTrayPlayable(){
    if (tray.some(p => hasAnyPlacement(p))) return;
    grid = makeEmptyGrid();
  }

  function refillSlot(i){
    tray[i] = randomPiece();
    drawTraySlot(i);
  }

  function initTray(){
    for (let i = 0; i < 3; i++) tray[i] = randomPiece();
    drawAllTraySlots();
  }

  function placePieceAt(piece, tx, ty){
    piece.cells.forEach(([cx, cy], i) => {
      grid[ty + cy][tx + cx] = piece.types[i];
    });
    clearFullRows();
  }

  function clearFullRows(){
    for (let r = ROWS - 1; r >= 0; r--) {
      if (grid[r].every(c => c)) {
        const rowTypes = grid[r].filter(t => t && t !== BLANK);
        grid.splice(r, 1);
        grid.unshift(new Array(COLS).fill(null));
        rowsCleared++;
        const rowsClearedEl = document.getElementById('rowsCleared');
        if (rowsClearedEl) rowsClearedEl.textContent = rowsCleared;
        triggerSummonEffect();
        if (hooks.onLocalRowCleared) hooks.onLocalRowCleared(rowTypes, rowsCleared);
        r++; // re-check same index after shift
      }
    }
  }

  function triggerSummonEffect(){
    const wrap = document.getElementById('battlefieldWrap');
    if (!wrap) return;
    const flash = document.createElement('div');
    flash.className = 'summon-flash';
    wrap.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove());
  }

  // ---------- puzzle rendering ----------
  function drawGrid(){
    const c = cell();
    puzzleCtx.clearRect(0, 0, puzzleCv.width, puzzleCv.height);
    puzzleCtx.strokeStyle = '#1b2531';
    puzzleCtx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
      puzzleCtx.beginPath(); puzzleCtx.moveTo(x*c, 0); puzzleCtx.lineTo(x*c, ROWS*c); puzzleCtx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      puzzleCtx.beginPath(); puzzleCtx.moveTo(0, y*c); puzzleCtx.lineTo(COLS*c, y*c); puzzleCtx.stroke();
    }
    for (let r = 0; r < ROWS; r++)
      for (let cIdx = 0; cIdx < COLS; cIdx++)
        if (grid[r][cIdx]) drawCell(puzzleCtx, cIdx, r, grid[r][cIdx], c);

    // drag placement preview — green if the held piece would fit at this
    // spot, red if not; recomputed every frame from dragState.
    if (dragState) {
      const { piece, tx, ty, valid } = dragState;
      piece.cells.forEach(([cx, cy]) => {
        drawDragPreviewCell(puzzleCtx, tx + cx, ty + cy, c, valid);
      });
    }

    if (paused) {
      puzzleCtx.fillStyle = 'rgba(6,8,11,.75)';
      puzzleCtx.fillRect(0, 0, puzzleCv.width, puzzleCv.height);
      puzzleCtx.fillStyle = '#d9a63e';
      puzzleCtx.font = '16px "Chakra Petch", sans-serif';
      puzzleCtx.textAlign = 'center';
      puzzleCtx.fillText('TẠM DỪNG', puzzleCv.width/2, puzzleCv.height/2);
    }
  }

  function drawDragPreviewCell(ctx, gx, gy, c, valid){
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return;
    const pad = 1.5;
    const x = gx*c + pad, y = gy*c + pad, w = c - pad*2, h = c - pad*2;
    ctx.save();
    ctx.fillStyle = valid ? 'rgba(78,224,138,.35)' : 'rgba(229,72,77,.35)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = valid ? '#4ee08a' : '#e5484d';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // ô khối/lưới luôn nền TRẮNG — loại lính (nếu có) vẽ như glyph nhỏ bên
  // trong, ô BLANK là ô trắng trống hoàn toàn (không có nhân vật).
  function drawCell(ctx, gx, gy, type, c){
    const pad = 1.5;
    const x = gx*c + pad, y = gy*c + pad, w = c - pad*2, h = c - pad*2;

    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#9aa5b0';
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;

    if (type && type !== BLANK && UNIT_DEFS[type]) {
      drawUnitIcon(ctx, x + w/2, y + h/2, Math.min(w, h), type);
    }
  }

  function drawUnitIcon(ctx, cx, cy, size, type){
    const def = UNIT_DEFS[type];
    const s = size * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = def.color;
    ctx.strokeStyle = def.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'swordsman') {
      ctx.beginPath();
      ctx.arc(-s*0.05, -s*0.85, s*0.28, 0, Math.PI*2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.4, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(-s*0.05, -s*0.58);
      ctx.lineTo(-s*0.05, s*0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s*0.05, s*0.35); ctx.lineTo(-s*0.35, s*0.95);
      ctx.moveTo(-s*0.05, s*0.35); ctx.lineTo(s*0.2, s*0.95);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s*0.05, -s*0.35);
      ctx.lineTo(s*0.32, -s*0.18);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.7, size * 0.14);
      ctx.beginPath();
      ctx.moveTo(s*0.3, -s*0.2);
      ctx.lineTo(s*0.98, -s*1.05);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(s*0.15, -s*0.38);
      ctx.lineTo(s*0.48, -s*0.02);
      ctx.stroke();
    } else if (type === 'archer') {
      ctx.beginPath();
      ctx.arc(-s*0.15, -s*0.85, s*0.26, 0, Math.PI*2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.4, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(-s*0.15, -s*0.6);
      ctx.lineTo(-s*0.15, s*0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s*0.15, s*0.35); ctx.lineTo(-s*0.4, s*0.95);
      ctx.moveTo(-s*0.15, s*0.35); ctx.lineTo(s*0.05, s*0.95);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.7, size * 0.13);
      ctx.beginPath();
      ctx.arc(s*0.35, -s*0.15, s*0.62, -Math.PI*0.42, Math.PI*0.42);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(s*0.62, -s*0.65);
      ctx.lineTo(s*0.05, -s*0.15);
      ctx.lineTo(s*0.62, s*0.35);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(s*0.05, -s*0.15);
      ctx.lineTo(s*0.85, -s*0.15);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s*0.85, -s*0.15);
      ctx.lineTo(s*0.55, -s*0.32);
      ctx.lineTo(s*0.55, s*0.02);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'knight') {
      ctx.beginPath();
      ctx.ellipse(0, s*0.05, s*0.62, s*0.32, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s*0.45, -s*0.1);
      ctx.lineTo(s*0.85, -s*0.75);
      ctx.lineTo(s*1.05, -s*0.55);
      ctx.lineTo(s*0.65, s*0.05);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s*0.78, -s*0.62);
      ctx.lineTo(s*0.9, -s*0.95);
      ctx.lineTo(s*0.95, -s*0.6);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = Math.max(1.2, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(-s*0.4, s*0.32);  ctx.lineTo(-s*0.45, s*0.9);
      ctx.moveTo(-s*0.1, s*0.34);  ctx.lineTo(-s*0.15, s*0.9);
      ctx.moveTo(s*0.25, s*0.34);  ctx.lineTo(s*0.3, s*0.9);
      ctx.moveTo(s*0.5, s*0.28);   ctx.lineTo(s*0.55, s*0.85);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-s*0.6, -s*0.05);
      ctx.quadraticCurveTo(-s*0.95, s*0.15, -s*0.75, s*0.55);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, -s*0.35, s*0.22, s*0.28, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s*0.02, -s*0.68, s*0.18, 0, Math.PI*2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.3, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(s*0.2, -s*0.4);
      ctx.lineTo(s*1.15, -s*0.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- tray (3 khối tiếp theo) rendering ----------
  function drawPieceIntoCanvas(canvas, ctx, piece){
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!piece) return;
    const pad = 6;
    const c = Math.min((canvas.width - pad*2) / piece.w, (canvas.height - pad*2) / piece.h);
    const offX = (canvas.width - piece.w*c) / (2*c);
    const offY = (canvas.height - piece.h*c) / (2*c);
    piece.cells.forEach(([cx, cy], i) => {
      drawCell(ctx, offX + cx, offY + cy, piece.types[i], c);
    });
  }

  function drawTraySlot(i){
    const slot = traySlots[i];
    if (!slot) return;
    drawPieceIntoCanvas(slot.canvas, slot.ctx, tray[i]);
  }

  function drawAllTraySlots(){
    for (let i = 0; i < traySlots.length; i++) drawTraySlot(i);
  }

  // ---------- responsive sizing: fit the whole puzzle area on screen,
  // no scrolling. The grid canvas is sized in real CSS pixels to the
  // exact space left over in #puzzleWrap after the piece tray, so the
  // 12x15 grid + 3-piece tray always fit without needing to swipe down.
  function layoutPuzzleArea(){
    const wrap = document.getElementById('puzzleWrap');
    const tray = document.getElementById('pieceTray');
    if (!wrap || !puzzleCv) return;

    const wrapRect = wrap.getBoundingClientRect();
    if (wrapRect.width === 0 || wrapRect.height === 0) return; // not visible yet

    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const gap = parseFloat(cs.rowGap || cs.gap || 0) || 0;
    const trayH = tray ? tray.getBoundingClientRect().height : 0;

    const availW = Math.max(60, wrapRect.width - padX);
    const availH = Math.max(60, wrapRect.height - padY - gap - trayH);

    const cellSize = Math.max(8, Math.floor(Math.min(availW / COLS, availH / ROWS)));
    const cssW = cellSize * COLS;
    const cssH = cellSize * ROWS;

    puzzleCv.style.width  = cssW + 'px';
    puzzleCv.style.height = cssH + 'px';
    puzzleCv.width  = cssW;
    puzzleCv.height = cssH;

    drawGrid();
  }

  // ---------- drag & drop controls ----------
  function setupDragControls(){
    traySlots.forEach((slot, i) => {
      slot.canvas.addEventListener('pointerdown', (e) => onDragStart(e, i));
    });
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  function onDragStart(e, slotIndex){
    if (paused || gameOver || !started) return;
    const piece = tray[slotIndex];
    if (!piece) return;
    e.preventDefault();

    const rect = puzzleCv.getBoundingClientRect();
    const cellPx = rect.width / COLS;

    dragState = {
      slot: slotIndex,
      piece,
      pointerId: e.pointerId,
      cellPx,
      tx: 0, ty: 0,
      valid: false
    };

    // hide the piece from its tray slot while it's being carried
    traySlots[slotIndex].ctx.clearRect(0, 0, traySlots[slotIndex].canvas.width, traySlots[slotIndex].canvas.height);

    // size + draw the floating "ghost" that follows the finger
    dragCv.width = piece.w * cellPx;
    dragCv.height = piece.h * cellPx;
    dragCv.style.width = dragCv.width + 'px';
    dragCv.style.height = dragCv.height + 'px';
    piece.cells.forEach(([cx, cy], i) => drawCell(dragCtx, cx, cy, piece.types[i], cellPx));
    dragCv.classList.remove('hidden');

    updateDragPosition(e.clientX, e.clientY);
  }

  function updateDragPosition(clientX, clientY){
    if (!dragState) return;
    const c = dragState.cellPx;
    const { piece } = dragState;

    // Block-Blast style anchor point: a fixed, cell-sized gap above the
    // fingertip. This point represents where the BOTTOM-CENTER of the
    // piece should land — not the piece's own center — so the shape
    // visibly sits just above the finger instead of floating away from it.
    const liftPx = c * DRAG_LIFT_CELLS;
    const anchorX = clientX;
    const anchorY = clientY - liftPx;

    dragCv.style.left = (anchorX - dragCv.width / 2) + 'px';
    dragCv.style.top  = (anchorY - dragCv.height) + 'px';

    const rect = puzzleCv.getBoundingClientRect();

    // is the anchor point even over/near the grid? if it's way off, treat
    // the drop as a cancel rather than force-snapping to an edge.
    const margin = c * 1.5;
    const overGrid =
      anchorX >= rect.left - margin && anchorX <= rect.right + margin &&
      anchorY >= rect.top  - margin && anchorY <= rect.bottom + margin;

    if (!overGrid) {
      dragState.tx = null;
      dragState.ty = null;
      dragState.valid = false;
      return;
    }

    // anchor = bottom-center of the piece, so its top-left grid cell is
    // (bottom row - piece.h + 1) rows up and (col - w/2) columns left.
    const fracCol = (anchorX - rect.left) / c;
    const bottomRow = (anchorY - rect.top) / c;
    let tx = Math.round(fracCol - piece.w / 2);
    let ty = Math.round(bottomRow) - piece.h;
    tx = Math.max(0, Math.min(COLS - piece.w, tx));
    ty = Math.max(0, Math.min(ROWS - piece.h, ty));

    dragState.tx = tx;
    dragState.ty = ty;
    dragState.valid = !collidesAt(piece, tx, ty);
  }

  function onDragMove(e){
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    updateDragPosition(e.clientX, e.clientY);
  }

  function onDragEnd(e){
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const { slot, piece, tx, ty, valid } = dragState;

    dragCv.classList.add('hidden');

    if (valid && tx !== null) {
      placePieceAt(piece, tx, ty);
      refillSlot(slot);
      ensureTrayPlayable();
      drawAllTraySlots();
    } else {
      // cancelled — piece goes back to its tray slot unchanged
      drawTraySlot(slot);
    }

    dragState = null;
  }

  // ---------- main loop ----------
  let lastT = null;
  function loop(ts){
    if (lastT === null) lastT = ts;
    const dt = Math.min(0.05, (ts - lastT) / 1000);
    lastT = ts;

    if (started && !paused && !gameOver) {
      tickBattle(dt);
    }

    drawGrid();
    renderBattlefield();
    requestAnimationFrame(loop);
  }

  // ---------- battle simulation (solo/host authoritative) ----------
  function spawnUnit(side, type){
    if (gameOver || !UNIT_DEFS[type]) return;
    const def = UNIT_DEFS[type];
    // lính bên máy (side B khi đang chơi với bot) bị nhân sức mạnh theo
    // powerMult của độ khó — máu tính ngay lúc triệu hồi, sát thương/tốc
    // độ/tốc đánh tính động trong effectiveDef() bên dưới.
    const mult = (botEnabled && side === 'B') ? (BOT_DIFFICULTY[botDifficulty].powerMult || 1) : 1;
    const hp = def.hp * mult;
    sim.units.push({
      id: sim.nextId++, side, type,
      x: side === 'A' ? 0 : LANE_LEN,
      hp, maxHp: hp,
      cd: 0,
      spawnTime: performance.now(),
      buffed: true,
      powerMult: mult
    });
  }

  function effectiveDef(u){
    const def = UNIT_DEFS[u.type];
    const powerMult = u.powerMult || 1;
    const buffMult = u.buffed ? SPAWN_BUFF_MULT : 1;
    const mult = powerMult * buffMult;
    return {
      ...def,
      atk: def.atk * mult,
      speed: def.speed * mult,
      range: def.range * buffMult,
      cooldown: def.cooldown / mult
    };
  }

  function tickBattle(dt){
    if (role === 'client' || sim.over) return;

    if (botEnabled) {
      botTimer -= dt;
      if (botTimer <= 0) {
        const cfg = BOT_DIFFICULTY[botDifficulty];
        spawnUnit('B', weightedRandomType(cfg.weights));
        botTimer = cfg.minGap + Math.random() * (cfg.maxGap - cfg.minGap);
      }
    }

    const units = sim.units;

    for (const u of units) {
      if (u.hp <= 0) continue;
      u.buffed = (performance.now() - u.spawnTime) < SPAWN_BUFF_MS;
      const def = effectiveDef(u);
      const dir = u.side === 'A' ? 1 : -1;

      let target = null, bestDist = Infinity;
      for (const o of units) {
        if (o.side === u.side || o.hp <= 0) continue;
        const ahead = u.side === 'A' ? (o.x >= u.x) : (o.x <= u.x);
        if (!ahead) continue;
        const d = Math.abs(o.x - u.x);
        if (d < bestDist) { bestDist = d; target = o; }
      }

      if (target && bestDist <= def.range) {
        u.cd -= dt;
        if (u.cd <= 0) { target.hp -= def.atk; u.cd = def.cooldown; }
        continue;
      }

      const enemyBaseX = u.side === 'A' ? LANE_LEN : 0;
      const distToBase = Math.abs(enemyBaseX - u.x);
      if (distToBase <= def.range) {
        u.cd -= dt;
        if (u.cd <= 0) {
          if (u.side === 'A') sim.baseB -= def.atk; else sim.baseA -= def.atk;
          u.hp -= def.atk;
          u.cd = def.cooldown;
        }
        continue;
      }

      u.x += dir * def.speed * dt;
      u.x = Math.max(0, Math.min(LANE_LEN, u.x));
    }

    sim.units = units.filter(u => u.hp > 0);
    sim.baseA = Math.max(0, sim.baseA);
    sim.baseB = Math.max(0, sim.baseB);

    if (!sim.over && (sim.baseA <= 0 || sim.baseB <= 0)) {
      sim.over = true;
      sim.winner = sim.baseA <= 0 ? 'B' : 'A';
      gameOver = true;
      if (hooks.onGameOver) hooks.onGameOver(sim.winner);
    }
  }

  function getSnapshot(){
    return {
      baseA: sim.baseA, baseB: sim.baseB,
      units: sim.units.map(u => ({ id: u.id, side: u.side, type: u.type, x: u.x, hp: u.hp, maxHp: u.maxHp, buffed: u.buffed, powerMult: u.powerMult })),
      over: sim.over, winner: sim.winner
    };
  }

  function findEngagementTarget(state, u){
    const def = effectiveDef(u);
    let target = null, bestDist = Infinity;
    for (const o of state.units) {
      if (o.side === u.side || o.hp <= 0) continue;
      const ahead = u.side === 'A' ? (o.x >= u.x) : (o.x <= u.x);
      if (!ahead) continue;
      const d = Math.abs(o.x - u.x);
      if (d < bestDist) { bestDist = d; target = o; }
    }
    if (target && bestDist <= def.range) return target.x;
    const baseX = u.side === 'A' ? LANE_LEN : 0;
    if (Math.abs(baseX - u.x) <= def.range) return baseX;
    return null;
  }

  function applyRemoteState(state){
    lastRemoteState = state;
    if (state.over && !gameOver) {
      gameOver = true;
      if (hooks.onGameOver) hooks.onGameOver(state.winner);
    }
  }

  // ---------- battlefield rendering: fake-3D tilted floor ----------
  // The lane is still purely 1D under the hood (units only ever move along
  // logicalX) — what changes here is presentation only. We render onto a
  // trapezoid "floor" that's narrower near the horizon and wider up front,
  // give units a radial-shaded body + a squashed ground shadow, and give
  // the two bases distinct top/front faces — cheap tricks that read as
  // "3D" on a flat canvas without any real depth axis in the sim.
  function floorGeometry(W, H){
    const horizonY = H * 0.24;
    const skew = W * 0.11;
    const laneT = 0.6; // 0 = far/horizon, 1 = near/front — where units stand
    const edgeX = (t, side) => {
      const farX = side ? W - skew : skew;
      const nearX = side ? W : 0;
      return farX + t * (nearX - farX);
    };
    const rowY = (t) => horizonY + t * (H - horizonY);
    const laneY = rowY(laneT);
    const laneLeftX = edgeX(laneT, 0);
    const laneRightX = edgeX(laneT, 1);
    return { horizonY, skew, laneT, edgeX, rowY, laneY, laneLeftX, laneRightX };
  }

  function renderBattlefield(){
    const state = (role === 'client') ? lastRemoteState : getSnapshot();
    fieldCtx.clearRect(0, 0, fieldCv.width, fieldCv.height);
    if (!state) return;

    const W = fieldCv.width, H = fieldCv.height;
    const geo = floorGeometry(W, H);
    const { horizonY, laneY, laneLeftX, laneRightX } = geo;

    drawFloor3D(W, H, geo);

    const flip = mySide === 'B';
    const toScreenX = (logicalX) => {
      const t = logicalX / LANE_LEN;
      const p = flip ? (1 - t) : t;
      return laneLeftX + p * (laneRightX - laneLeftX);
    };

    const myHp = flip ? state.baseB : state.baseA;
    const enemyHp = flip ? state.baseA : state.baseB;
    drawBase(laneLeftX, laneY, myHp, '#d9a63e', -1);
    drawBase(laneRightX, laneY, enemyHp, '#e5484d', 1);

    // units, back-to-front so nearer/overlapping bodies draw on top
    const sortedUnits = state.units.slice().sort((a, b) => a.x - b.x);
    for (const u of sortedUnits) {
      const isMine = (flip ? u.side === 'B' : u.side === 'A');
      const x = toScreenX(u.x);
      const engageLogicalX = findEngagementTarget(state, u);
      const engageX = engageLogicalX === null ? null : toScreenX(engageLogicalX);
      drawUnit(x, laneY, u, isMine, engageX);
    }

    document.getElementById('hpMine').style.width = Math.max(0, myHp/BASE_MAX_HP*100) + '%';
    document.getElementById('hpEnemy').style.width = Math.max(0, enemyHp/BASE_MAX_HP*100) + '%';
    document.getElementById('hpMineNum').textContent = Math.max(0, Math.round(myHp));
    document.getElementById('hpEnemyNum').textContent = Math.max(0, Math.round(enemyHp));

    if (state.over) showGameOver(state.winner, flip);
  }

  // deterministic pseudo-random in [0,1) from an integer seed — lets the
  // ground speckle / cloud layout look organic while staying identical
  // frame to frame (no re-randomizing / flicker)
  function hashFrac(n){
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  // sky above the horizon (gradient + sun + drifting clouds + distant
  // hills) and a perspective floor grid below it (depth lines converging
  // toward the horizon, lane lines converging toward the front) — together
  // these sell a "real" 3D battlefield on what is still a flat canvas.
  function drawFloor3D(W, H, geo){
    const { horizonY, edgeX, rowY, laneT } = geo;

    drawSky(W, H, geo);

    // floor: trapezoid, narrow at the horizon, full width up front
    fieldCtx.save();
    fieldCtx.beginPath();
    fieldCtx.moveTo(edgeX(0,0), rowY(0));
    fieldCtx.lineTo(edgeX(0,1), rowY(0));
    fieldCtx.lineTo(edgeX(1,1), rowY(1));
    fieldCtx.lineTo(edgeX(1,0), rowY(1));
    fieldCtx.closePath();
    fieldCtx.clip();

    // ground: warm sunset-lit dirt near the horizon, cooling into shadow
    // up front — an "atmospheric perspective" cue that reads as distance
    const floor = fieldCtx.createLinearGradient(0, horizonY, 0, H);
    floor.addColorStop(0, '#332a1f');
    floor.addColorStop(0.35, '#1d2117');
    floor.addColorStop(1, '#0a0e0b');
    fieldCtx.fillStyle = floor;
    fieldCtx.fillRect(0, horizonY, W, H - horizonY);

    drawGroundDetails(geo);

    // horizon haze: blends the sky's sunset glow into the ground so the
    // seam between the two doesn't read as a flat, cut-out line
    const haze = fieldCtx.createLinearGradient(0, horizonY, 0, horizonY + (H - horizonY) * 0.4);
    haze.addColorStop(0, 'rgba(224,170,90,0.28)');
    haze.addColorStop(1, 'rgba(224,170,90,0)');
    fieldCtx.fillStyle = haze;
    fieldCtx.fillRect(0, horizonY, W, (H - horizonY) * 0.4);

    // depth lines (horizontal-ish, spaced with easing so they bunch up
    // near the horizon like real perspective)
    fieldCtx.strokeStyle = 'rgba(216,224,232,0.07)';
    fieldCtx.lineWidth = 1;
    for (let i = 1; i <= 6; i++) {
      const t = Math.pow(i / 6, 1.6);
      fieldCtx.beginPath();
      fieldCtx.moveTo(edgeX(t, 0), rowY(t));
      fieldCtx.lineTo(edgeX(t, 1), rowY(t));
      fieldCtx.stroke();
    }
    // lane lines (converging toward the horizon)
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      fieldCtx.beginPath();
      fieldCtx.moveTo(edgeX(0, 0) + frac*(edgeX(0,1)-edgeX(0,0)), rowY(0));
      fieldCtx.lineTo(edgeX(1, 0) + frac*(edgeX(1,1)-edgeX(1,0)), rowY(1));
      fieldCtx.stroke();
    }

    // the walking lane itself, picked out a little brighter than the rest
    // of the floor grid so it still reads as "the path"
    fieldCtx.strokeStyle = 'rgba(217,166,62,0.35)';
    fieldCtx.lineWidth = 2;
    fieldCtx.setLineDash([8,8]);
    fieldCtx.beginPath();
    fieldCtx.moveTo(edgeX(laneT, 0), rowY(laneT));
    fieldCtx.lineTo(edgeX(laneT, 1), rowY(laneT));
    fieldCtx.stroke();
    fieldCtx.setLineDash([]);

    fieldCtx.restore();

    // crisp horizon line on top of everything — a thin, bright edge is
    // what makes the eye believe the sky and ground actually meet
    fieldCtx.strokeStyle = 'rgba(255,214,140,0.4)';
    fieldCtx.lineWidth = 1;
    fieldCtx.beginPath();
    fieldCtx.moveTo(edgeX(0,0), horizonY);
    fieldCtx.lineTo(edgeX(0,1), horizonY);
    fieldCtx.stroke();
  }

  function drawSky(W, H, geo){
    const { horizonY } = geo;

    // dusk gradient: deep indigo at the top down to a warm amber band
    // right at the horizon — reads as "battlefield at sunset"
    const sky = fieldCtx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, '#080b16');
    sky.addColorStop(0.5, '#1c2740');
    sky.addColorStop(0.82, '#6b4a44');
    sky.addColorStop(1, '#c08a48');
    fieldCtx.fillStyle = sky;
    fieldCtx.fillRect(0, 0, W, horizonY);

    const sunX = W * 0.66, sunY = horizonY * 0.58, sunR = Math.max(9, H * 0.075);
    drawClouds(W, horizonY);   // clouds sit behind/around the sun
    drawSun(sunX, sunY, sunR, horizonY);
    drawHills(W, horizonY);    // distant silhouette right on the horizon

    // soft ambient glow pooling on the horizon, ties sky + ground together
    const glow = fieldCtx.createRadialGradient(sunX, horizonY, 0, sunX, horizonY, W * 0.6);
    glow.addColorStop(0, 'rgba(217,166,62,0.28)');
    glow.addColorStop(1, 'rgba(217,166,62,0)');
    fieldCtx.fillStyle = glow;
    fieldCtx.fillRect(0, 0, W, horizonY);
  }

  function drawSun(cx, cy, r, horizonY){
    fieldCtx.save();
    fieldCtx.beginPath();
    fieldCtx.rect(0, 0, cx + r*4, horizonY);
    fieldCtx.clip();

    // outer halo
    const halo = fieldCtx.createRadialGradient(cx, cy, 0, cx, cy, r * 4);
    halo.addColorStop(0, 'rgba(255,214,140,0.35)');
    halo.addColorStop(1, 'rgba(255,214,140,0)');
    fieldCtx.fillStyle = halo;
    fieldCtx.fillRect(cx - r*4, cy - r*4, r*8, r*8);

    // core disc, very slightly squashed like a sun sitting low on the
    // horizon seen through haze
    const core = fieldCtx.createRadialGradient(cx - r*0.2, cy - r*0.25, r*0.1, cx, cy, r);
    core.addColorStop(0, '#fff6de');
    core.addColorStop(0.55, '#ffce78');
    core.addColorStop(1, '#e08a38');
    fieldCtx.fillStyle = core;
    fieldCtx.beginPath();
    fieldCtx.ellipse(cx, cy, r, r * 0.92, 0, 0, Math.PI * 2);
    fieldCtx.fill();
    fieldCtx.restore();
  }

  function drawClouds(W, horizonY){
    const t = performance.now() / 1000;
    // two depth layers: far (small, slow, hazy) and near (bigger, faster,
    // more opaque) — the speed difference alone reads as parallax depth
    const layers = [
      { count: 3, y0: 0.06, y1: 0.30, size: 0.15, speed: 0.005, alpha: 0.22 },
      { count: 2, y0: 0.28, y1: 0.50, size: 0.22, speed: 0.012, alpha: 0.34 },
    ];
    layers.forEach((layer, li) => {
      for (let i = 0; i < layer.count; i++) {
        const seed = li * 11 + i;
        const baseX = hashFrac(seed * 3.7);
        const progress = (((t * layer.speed) + baseX) % 1 + 1) % 1;
        const cx = -W * 0.2 + progress * W * 1.4;
        const cy = horizonY * (layer.y0 + hashFrac(seed * 1.9) * (layer.y1 - layer.y0));
        const r = W * layer.size * (0.7 + hashFrac(seed * 5.3) * 0.6);
        drawCloudPuff(cx, cy, r, layer.alpha);
      }
    });
  }

  function drawCloudPuff(cx, cy, r, alpha){
    fieldCtx.save();
    fieldCtx.globalAlpha = alpha;
    // a few overlapping soft lobes read as an irregular cloud silhouette
    // instead of a single perfect (and obviously fake) circle
    const lobes = [[0,0,1],[r*0.7,r*0.08,0.7],[-r*0.65,r*0.1,0.72],[r*0.22,-r*0.24,0.55]];
    lobes.forEach(([dx, dy, scale]) => {
      const puffR = r * scale * 0.55;
      const grad = fieldCtx.createRadialGradient(cx+dx-puffR*0.3, cy+dy-puffR*0.3, puffR*0.1, cx+dx, cy+dy, puffR);
      grad.addColorStop(0, '#5c5f79');
      grad.addColorStop(1, '#262b3d');
      fieldCtx.fillStyle = grad;
      fieldCtx.beginPath();
      fieldCtx.ellipse(cx + dx, cy + dy, puffR, puffR * 0.62, 0, 0, Math.PI * 2);
      fieldCtx.fill();
    });
    // warm rim on the underside, as if lit from below by the setting sun
    fieldCtx.globalAlpha = alpha * 0.8;
    fieldCtx.fillStyle = 'rgba(230,160,90,0.5)';
    fieldCtx.beginPath();
    fieldCtx.ellipse(cx, cy + r * 0.16, r * 0.85, r * 0.2, 0, 0, Math.PI * 2);
    fieldCtx.fill();
    fieldCtx.restore();
  }

  function drawHills(W, horizonY){
    // two rolling silhouette layers sitting right on the horizon — the
    // far one lighter/hazier, the near one darker, another cheap parallax
    // depth cue that costs almost nothing to draw
    const layers = [
      { amp: horizonY * 0.10, freq: 3.2, color: 'rgba(64,58,88,0.5)' },
      { amp: horizonY * 0.16, freq: 2.1, color: 'rgba(28,26,46,0.75)' },
    ];
    layers.forEach((layer, li) => {
      fieldCtx.beginPath();
      fieldCtx.moveTo(0, horizonY);
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const n = Math.sin(f * Math.PI * layer.freq + li * 1.7) * 0.5
                + Math.sin(f * Math.PI * layer.freq * 2.3 + li) * 0.3;
        fieldCtx.lineTo(f * W, horizonY - layer.amp * (0.5 + 0.5 * n));
      }
      fieldCtx.lineTo(W, horizonY);
      fieldCtx.closePath();
      fieldCtx.fillStyle = layer.color;
      fieldCtx.fill();
    });
  }

  // small grass tufts / stones scattered across the floor, placed in
  // "lane space" (t = depth, frac = across) so the perspective transform
  // does the scaling/converging for us — computed once and cached since
  // their layout never needs to change frame to frame
  function ensureGroundDetails(){
    if (groundDetails) return;
    groundDetails = [];
    for (let i = 0; i < 70; i++) {
      groundDetails.push({
        t: hashFrac(i * 3.1),
        frac: hashFrac(i * 7.7 + 2),
        kind: hashFrac(i * 5.3 + 1) < 0.65 ? 'tuft' : 'rock',
      });
    }
  }

  function drawGroundDetails(geo){
    ensureGroundDetails();
    const { edgeX, rowY } = geo;
    groundDetails.forEach(d => {
      if (d.t < 0.04) return; // keep the strip right at the horizon clean
      const x = edgeX(d.t, 0) + d.frac * (edgeX(d.t, 1) - edgeX(d.t, 0));
      const y = rowY(d.t);
      const scale = 0.4 + d.t * 1.1; // bigger up front, smaller near the horizon
      if (d.kind === 'tuft') {
        fieldCtx.strokeStyle = `rgba(120,140,90,${0.15 + 0.25 * d.t})`;
        fieldCtx.lineWidth = Math.max(0.6, scale * 0.9);
        fieldCtx.beginPath();
        fieldCtx.moveTo(x - scale*2, y);   fieldCtx.lineTo(x - scale*0.5, y - scale*3);
        fieldCtx.moveTo(x, y);             fieldCtx.lineTo(x + scale*0.3, y - scale*3.4);
        fieldCtx.moveTo(x + scale*1.6, y); fieldCtx.lineTo(x + scale*2.2, y - scale*2.6);
        fieldCtx.stroke();
      } else {
        fieldCtx.fillStyle = `rgba(18,20,18,${0.25 + 0.3 * d.t})`;
        fieldCtx.beginPath();
        fieldCtx.ellipse(x, y, scale * 2.2, scale, 0, 0, Math.PI * 2);
        fieldCtx.fill();
      }
    });
  }

  function drawGroundShadow(x, y, radiusX, radiusY, alpha){
    fieldCtx.save();
    fieldCtx.fillStyle = `rgba(0,0,0,${alpha})`;
    fieldCtx.beginPath();
    fieldCtx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI*2);
    fieldCtx.fill();
    fieldCtx.restore();
  }

  function drawBase(x, y, hp, color, facing){
    drawGroundShadow(x, y + 6, 20, 7, 0.35);

    // a simple isometric block: a lighter "top" face and a darker "front"
    // face so the tower reads as a 3D object rather than a flat diamond
    fieldCtx.save();
    fieldCtx.translate(x, y);

    const topPts   = [[-13,-4],[0,-20],[13,-4],[0,10]];
    const frontPts = [[-13,-4],[0,10],[0,26],[-13,12]];
    const sidePts  = [[13,-4],[0,10],[0,26],[13,12]];

    fieldCtx.fillStyle = shadeColor(color, 0.25);
    fieldCtx.beginPath();
    topPts.forEach(([px,py],i) => i ? fieldCtx.lineTo(px,py) : fieldCtx.moveTo(px,py));
    fieldCtx.closePath(); fieldCtx.fill();

    fieldCtx.fillStyle = shadeColor(color, -0.35);
    fieldCtx.beginPath();
    frontPts.forEach(([px,py],i) => i ? fieldCtx.lineTo(px,py) : fieldCtx.moveTo(px,py));
    fieldCtx.closePath(); fieldCtx.fill();

    fieldCtx.fillStyle = shadeColor(color, -0.15);
    fieldCtx.beginPath();
    sidePts.forEach(([px,py],i) => i ? fieldCtx.lineTo(px,py) : fieldCtx.moveTo(px,py));
    fieldCtx.closePath(); fieldCtx.fill();

    fieldCtx.strokeStyle = 'rgba(0,0,0,0.5)';
    fieldCtx.lineWidth = 1;
    [topPts, frontPts, sidePts].forEach(pts => {
      fieldCtx.beginPath();
      pts.forEach(([px,py],i) => i ? fieldCtx.lineTo(px,py) : fieldCtx.moveTo(px,py));
      fieldCtx.closePath(); fieldCtx.stroke();
    });

    // small banner/flag flying off the top peak, angled with facing
    fieldCtx.strokeStyle = color;
    fieldCtx.lineWidth = 2;
    fieldCtx.beginPath();
    fieldCtx.moveTo(0, -20); fieldCtx.lineTo(0, -32);
    fieldCtx.stroke();
    fieldCtx.fillStyle = color;
    fieldCtx.beginPath();
    fieldCtx.moveTo(0, -32);
    fieldCtx.lineTo(facing * 11, -28);
    fieldCtx.lineTo(0, -24);
    fieldCtx.closePath(); fieldCtx.fill();

    fieldCtx.restore();
  }

  // lighten (positive amt) or darken (negative amt) a '#rrggbb' color
  function shadeColor(hex, amt){
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const f = (v) => Math.max(0, Math.min(255, Math.round(v + (amt >= 0 ? (255-v)*amt : v*amt))));
    r = f(r); g = f(g); b = f(b);
    return `rgb(${r},${g},${b})`;
  }

  function drawUnit(x, y, u, isMine, engageX){
    const def = effectiveDef(u);
    const engaged = engageX !== null && engageX !== undefined;
    const localTargetX = engaged ? engageX - x : null;
    const dir = engaged ? (localTargetX >= 0 ? 1 : -1) : (u.side === 'A' ? 1 : -1);

    // a small idle bob so bodies feel like they're standing on the floor
    // rather than pasted flat onto it — the shadow stays put, the body
    // floats a couple px above it, which is what sells the depth.
    const bob = Math.sin(performance.now() / 260 + (u.id || 0)) * 1.4;

    drawGroundShadow(x, y + def.radius*0.55, def.radius*0.9, def.radius*0.32, 0.4);

    fieldCtx.save();
    fieldCtx.translate(x, y + bob);

    const grad = fieldCtx.createRadialGradient(-def.radius*0.35, -def.radius*0.4, def.radius*0.2, 0, 0, def.radius*1.15);
    grad.addColorStop(0, shadeColor(def.color, 0.45));
    grad.addColorStop(0.6, def.color);
    grad.addColorStop(1, shadeColor(def.color, -0.3));
    fieldCtx.fillStyle = grad;
    fieldCtx.globalAlpha = isMine ? 1 : 0.85;
    fieldCtx.beginPath();
    fieldCtx.arc(0, 0, def.radius, 0, Math.PI*2);
    fieldCtx.fill();
    fieldCtx.strokeStyle = isMine ? '#d9a63e' : '#0a0e14';
    fieldCtx.lineWidth = 2;
    fieldCtx.stroke();
    fieldCtx.globalAlpha = 1;

    fieldCtx.save();
    fieldCtx.scale(dir, 1);
    if (u.type === 'swordsman') {
      const swing = engaged ? Math.sin(performance.now() / 90) * 0.5 : 0.08;
      fieldCtx.save();
      fieldCtx.rotate(swing);
      fieldCtx.strokeStyle = '#f2f2f2';
      fieldCtx.lineWidth = 2.5;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius - 2, -2);
      fieldCtx.lineTo(def.radius + 11, -2);
      fieldCtx.stroke();
      fieldCtx.strokeStyle = '#8a5a2a';
      fieldCtx.lineWidth = 3;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius - 4, 2);
      fieldCtx.lineTo(def.radius + 2, 2);
      fieldCtx.stroke();
      fieldCtx.restore();
    } else if (u.type === 'archer') {
      fieldCtx.strokeStyle = '#7a4a20';
      fieldCtx.lineWidth = 2;
      fieldCtx.beginPath();
      fieldCtx.arc(def.radius + 2, 0, 6, -Math.PI*0.4, Math.PI*0.4);
      fieldCtx.stroke();
      fieldCtx.strokeStyle = '#d9c48a';
      fieldCtx.lineWidth = 1;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius + 2, -5.5);
      fieldCtx.lineTo(def.radius + 2, 5.5);
      fieldCtx.stroke();
    } else if (u.type === 'knight') {
      fieldCtx.strokeStyle = '#d9a63e';
      fieldCtx.lineWidth = 3;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius - 2, 0);
      fieldCtx.lineTo(def.radius + 16, 0);
      fieldCtx.stroke();
      fieldCtx.fillStyle = '#d9a63e';
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius + 16, -3);
      fieldCtx.lineTo(def.radius + 22, 0);
      fieldCtx.lineTo(def.radius + 16, 3);
      fieldCtx.closePath();
      fieldCtx.fill();
      fieldCtx.strokeStyle = '#0a0e14';
      fieldCtx.lineWidth = 2;
      fieldCtx.beginPath();
      fieldCtx.moveTo(-def.radius + 3, def.radius - 3);
      fieldCtx.lineTo(-def.radius + 6, def.radius + 5);
      fieldCtx.moveTo(-def.radius - 2, def.radius - 3);
      fieldCtx.lineTo(-def.radius - 5, def.radius + 5);
      fieldCtx.stroke();
    }
    fieldCtx.restore();

    if (u.type === 'archer' && engaged) {
      const period = def.cooldown * 1000;
      const phase = (performance.now() % period) / period;
      const arrowX = localTargetX * phase;
      // small parabolic lob instead of a flat line — a cheap arc reads as
      // "the arrow has real height" rather than sliding along the ground
      const arc = -Math.sin(phase * Math.PI) * 10;
      fieldCtx.save();
      fieldCtx.translate(arrowX, arc);
      fieldCtx.rotate(dir === 1 ? 0 : Math.PI);
      fieldCtx.strokeStyle = '#e8d9a0';
      fieldCtx.lineWidth = 1.5;
      fieldCtx.beginPath();
      fieldCtx.moveTo(-7, 0); fieldCtx.lineTo(4, 0); fieldCtx.stroke();
      fieldCtx.beginPath();
      fieldCtx.moveTo(4, 0); fieldCtx.lineTo(0, -2.5); fieldCtx.lineTo(0, 2.5); fieldCtx.closePath();
      fieldCtx.fillStyle = '#e8d9a0'; fieldCtx.fill();
      fieldCtx.restore();
    }

    if (u.buffed) {
      fieldCtx.save();
      fieldCtx.strokeStyle = 'rgba(217,166,62,0.9)';
      fieldCtx.lineWidth = 2;
      const pulse = def.radius + 4 + Math.sin(performance.now() / 80) * 2;
      fieldCtx.beginPath();
      fieldCtx.arc(0, 0, pulse, 0, Math.PI*2);
      fieldCtx.stroke();
      fieldCtx.restore();
    }

    const w = def.radius*2;
    fieldCtx.fillStyle = '#000'; fieldCtx.fillRect(-w/2, -def.radius-7, w, 3);
    fieldCtx.fillStyle = '#4ee08a'; fieldCtx.fillRect(-w/2, -def.radius-7, w*(u.hp/u.maxHp), 3);
    fieldCtx.restore();
  }

  function showGameOver(winnerSide, flip){
    const banner = document.getElementById('gameOverBanner');
    const iWon = flip ? winnerSide === 'B' : winnerSide === 'A';
    banner.innerHTML = iWon
      ? 'CHIẾN THẮNG<span>Nhà Chính đối phương đã sụp đổ</span>'
      : 'THẤT BẠI<span>Nhà Chính của bạn đã sụp đổ</span>';
    banner.classList.remove('hidden');
  }

  // ---------- controls ----------
  function setupControls(){
    setupDragControls();

    const btnPauseEl = document.getElementById('btnPause');
    if (btnPauseEl) {
      btnPauseEl.addEventListener('click', () => {
        paused = !paused;
        btnPauseEl.textContent = paused ? 'TIẾP TỤC' : 'TẠM DỪNG';
      });
    }
  }

  // ---------- public API ----------
  function init(){
    puzzleCv = document.getElementById('puzzleGrid'); puzzleCtx = puzzleCv.getContext('2d');
    fieldCv = document.getElementById('battlefield'); fieldCtx = fieldCv.getContext('2d');
    dragCv = document.getElementById('dragGhost'); dragCtx = dragCv.getContext('2d');

    traySlots = Array.from(document.querySelectorAll('.tray-slot')).map(canvas => ({
      canvas, ctx: canvas.getContext('2d')
    }));

    initTray();
    setupControls();
    layoutPuzzleArea();

    let resizeRAF = null;
    window.addEventListener('resize', () => {
      if (resizeRAF) return;
      resizeRAF = requestAnimationFrame(() => { resizeRAF = null; layoutPuzzleArea(); });
    });

    requestAnimationFrame(loop);
  }

  function resetState(){
    grid = makeEmptyGrid();
    sim = { baseA: BASE_MAX_HP, baseB: BASE_MAX_HP, units: [], nextId: 1, over: false, winner: null };
    lastRemoteState = null;
    rowsCleared = 0; gameOver = false; paused = false;
    botTimer = BOT_DIFFICULTY[botDifficulty].minGap;
    dragState = null;
    if (dragCv) dragCv.classList.add('hidden');
    const rowsClearedEl2 = document.getElementById('rowsCleared');
    if (rowsClearedEl2) rowsClearedEl2.textContent = 0;
    document.getElementById('gameOverBanner').classList.add('hidden');
    const btnPauseEl2 = document.getElementById('btnPause');
    if (btnPauseEl2) btnPauseEl2.textContent = 'TẠM DỪNG';
    layoutPuzzleArea();
    initTray();
  }

  return {
    init,
    hooks,
    setRole(r, side){ role = r; mySide = side; },
    getMySide(){ return mySide; },
    setBotMode(enabled, difficulty){
      botEnabled = enabled;
      if (difficulty && BOT_DIFFICULTY[difficulty]) botDifficulty = difficulty;
      botTimer = BOT_DIFFICULTY[botDifficulty].minGap;
    },
    spawnUnit,
    onRemoteSpawn(side, type){ spawnUnit(side, type); },
    getSnapshot,
    applyRemoteState,
    prepare(){
      resetState();
      started = false;
    },
    start(){
      resetState();
      started = true;
    }
  };
})();

document.addEventListener('DOMContentLoaded', () => Game.init());
