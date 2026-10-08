(() => {
'use strict';

// ---- World (logical units; canvas is scaled to fit) -------------------
const COLS = 7, CELL = 100, ROWS = 9;            // brick rows 0..ROWS-1
const W = COLS * CELL;
const FLOOR = ROWS * CELL + 60;                   // y of the floor line
const H = FLOOR + 40;
const R = 13;                                     // ball radius
const SPEED = 1500;                               // units / second
const STEP = 1 / 240;                             // fixed physics step
const FIRE_GAP = 0.06;                            // seconds between launched balls
const MIN_SIN = 0.12;                             // min |vy|/speed (avoids endless flat bounces)
const MIN_PULL = 24;                              // px of drag needed to aim
const MAX_STEP_DIST = R * 0.5;                    // sub-step cap so nothing tunnels
const SAVE_KEY = 'balls-bricks-v1';

const $ = id => document.getElementById(id) || document.createElement('div');
const canvas = $('game'), ctx = canvas.getContext('2d');
const elTitle = $('ov-title'), elText = $('ov-text'), elCancel = $('cancel');
const elMode = $('mode'), elRound = $('round'), elBest = $('best'), elBalls = $('balls');
const elSpeed = $('speed'), elRecall = $('recall'), overlay = $('overlay');

// ---- State -----------------------------------------------------------
let state;            // 'aim' | 'shoot' | 'gather' | 'over'
let round, ballCount, launchX, best = 0, hard = false;
let grid;             // grid[row][col] = {type:'brick',hp,flash} | {type:'ball'} | null
let eaten = 0;      // balls dissolved by acid this shot (lost for good)
let balls, toFire, fireTimer, landedX, shotTime, collected;
let particles = [], effects = [], fast = false;
let aim = null;       // {id} while a finger is down
let aimT = { x: W / 2, y: 300 };   // persistent aim point (world coords)
let scale = 1;

const bestKey = () => SAVE_KEY + (hard ? ':best-hard' : ':best');
function loadBest() { try { best = +localStorage.getItem(bestKey()) || 0; } catch (e) { best = 0; } }
// Difficulty settings. Hard: acid from 20 balls, a boss every 2nd round, tougher blocks, more powerups.
const CFG = {
  normal: { acidMin: 80, acidChance: 0.2,  bossEvery: 5, bossFrom: 5, hpMul: 1, powerChance: 0.3 },
  hard:   { acidMin: 20, acidChance: 0.35, bossEvery: 2, bossFrom: 2, hpMul: 2, powerChance: 0.5 }
};
const cfg = () => hard ? CFG.hard : CFG.normal;

// ---- Persistence (mobile browsers kill background tabs) --------------
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      round, ballCount, launchX, hard,
      grid: grid.map(r => r.map(c => c && (c.type === 'brick'
        ? (c.boss ? { t: 'B', hp: c.hp, max: c.max, c0: c.c0 } : { t: 'b', hp: c.hp, a: c.acid ? 1 : 0 })
        : c.type === 'power' ? { t: 'w', k: c.kind } : { t: 'p' })))
    }));
    localStorage.setItem(bestKey(), best);
  } catch (e) {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!s || !Array.isArray(s.grid) || s.grid.length !== ROWS) return false;
    round = s.round; ballCount = s.ballCount; launchX = s.launchX; hard = !!s.hard; loadBest();
    const bosses = {};
    grid = s.grid.map((r, ri) => r.map(c => {
      if (!c) return null;
      if (c.t === 'b') return { type: 'brick', hp: c.hp, flash: 0, acid: !!c.a };
      if (c.t === 'B') return bosses[ri + ':' + c.c0] || (bosses[ri + ':' + c.c0] = { type: 'brick', boss: true, w: 3, c0: c.c0, hp: c.hp, max: c.max, flash: 0 });
      if (c.t === 'w') return { type: 'power', kind: c.k };
      return { type: 'ball' };
    }));
    return true;
  } catch (e) { return false; }
}

function newGame(h) {
  hard = !!h; loadBest();
  round = 1; ballCount = 1; launchX = W / 2;
  grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  spawnRow();
  startAim();
}

function startAim() {
  state = 'aim'; balls = []; particles = []; effects = []; toFire = 0; collected = 0; shotTime = 0;
  overlay.hidden = true; $('cancel').hidden = true; elRecall.hidden = true;
  updateHud(); save();
}

function updateHud() {
  elMode.textContent = hard ? 'Round · HARD' : 'Round'; elMode.classList.toggle('hard', hard);
  elRound.textContent = round; elBest.textContent = best; elBalls.textContent = ballCount;
}

// ---- Level generation -------------------------------------------------
// Boss HP = ball count x 8..17, with a 1-in-20 chance of the full x18.
function bossHp() {
  const mult = Math.random() < 1 / 20 ? 18 : 8 + (Math.random() * 10 | 0);
  const hp = ballCount * mult;
  return hard ? Math.max(hp, round * 20) : hp;   // hard: early bosses can't be trivial
}

const POWERS = ['bomb', 'hline', 'vline'];
const isBossRound = () => round >= cfg().bossFrom && round % cfg().bossEvery === 0;
// Damage dealt by powerups; scales with the round so they stay useful.
const powerDamage = () => Math.max(3, Math.ceil(round * 0.6));

function spawnRow() {
  const row = grid[0];
  const rnd = n => Math.random() * n | 0;
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let free = [...Array(COLS).keys()];
  if (isBossRound()) {                             // wide boss block, 3 cells
    const c0 = rnd(COLS - 2);
    const hp = bossHp();
    const boss = { type: 'brick', boss: true, w: 3, c0, hp, max: hp, flash: 0 };
    for (let c = c0; c < c0 + 3; c++) row[c] = boss;
    free = free.filter(c => c < c0 || c >= c0 + 3);
    shuffle(free);
    row[free.pop()] = { type: 'ball' };
    if (free.length && Math.random() < 0.5) row[free.pop()] = { type: 'power', kind: POWERS[rnd(POWERS.length)] };
    return;
  }
  shuffle(free);
  row[free.pop()] = { type: 'ball' };              // guaranteed +1 ball
  if (round >= 2 && Math.random() < cfg().powerChance) row[free.pop()] = { type: 'power', kind: POWERS[rnd(POWERS.length)] };
  const n = 2 + rnd(3);                            // 2-4 bricks, always leaves gaps
  for (let i = 0; i < n && free.length > 1; i++) {
    const c = free.pop();
    const base = round * cfg().hpMul;
    row[c] = { type: 'brick', hp: Math.random() < 0.12 ? base * 2 : base, flash: 0 };
    if (ballCount > cfg().acidMin && Math.random() < cfg().acidChance) row[c].acid = true;
  }
}

function advanceRound() {
  ballCount = Math.max(1, ballCount + collected - eaten);
  eaten = 0;
  round++;
  if (round - 1 > best) best = round - 1;
  // shift everything down one row; bottom row falling off the grid = game over
  const dead = grid[ROWS - 1].some(c => c && c.type === 'brick');
  grid.pop();
  grid.unshift(Array(COLS).fill(null));
  spawnRow();
  if (dead) return gameOver();
  startAim();
}

function gameOver() {
  state = 'over';
  best = Math.max(best, round - 1);
  try { localStorage.removeItem(SAVE_KEY); localStorage.setItem(bestKey(), best); } catch (e) {}
  updateHud();
  $('ov-text').textContent = 'You survived ' + (round - 1) + ' rounds\nBest: ' + best;
  elTitle.textContent = 'Game over'; $('cancel').hidden = true;
  overlay.hidden = false;
}

// ---- Shooting ---------------------------------------------------------
function fire(dx, dy) {
  const len = Math.hypot(dx, dy);
  const vx = dx / len * SPEED, vy = dy / len * SPEED;
  balls = [];
  for (let i = 0; i < ballCount; i++) balls.push({ x: launchX, y: FLOOR - R, vx, vy, active: false, landed: false, lx: 0 });
  toFire = ballCount; fireTimer = 0; shotTime = 0; landedX = null; collected = 0; eaten = 0;
  state = 'shoot';
  elBalls.textContent = '0/' + ballCount;
}

// Direct aiming: the line runs from the ball through the aim point (the finger). The aim
// point persists after release, so the line stays visible between shots.
function clampAimT() {
  aimT.x = Math.max(0, Math.min(W, aimT.x));
  aimT.y = Math.max(0, Math.min(FLOOR - R, aimT.y));
}
function aimVector() {
  const dx = aimT.x - launchX, dy = (FLOOR - R) - aimT.y;   // dy>0 = upward
  const lim = Math.asin(MIN_SIN * 1.4);
  let a = dy > 0 ? Math.atan2(dy, dx) : (dx >= 0 ? lim : Math.PI - lim);
  a = Math.max(lim, Math.min(Math.PI - lim, a));
  return { dx: Math.cos(a), dy: -Math.sin(a) };
}

// ---- Physics ----------------------------------------------------------
// Moves one ball by dt. `hit(cell,row,col)` is called on brick/pickup contact.
// Shared by the real simulation and the aim preview.
function moveBall(b, dt, onCell) {
  const dist = Math.hypot(b.vx, b.vy) * dt;
  const n = Math.max(1, Math.ceil(dist / MAX_STEP_DIST));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    stepId++;
    b.x += b.vx * h; b.y += b.vy * h;

    if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx); }
    else if (b.x > W - R) { b.x = W - R; b.vx = -Math.abs(b.vx); }
    if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy); }
    if (b.y >= FLOOR - R && b.vy > 0) { b.y = FLOOR - R; return 'floor'; }

    const c0 = Math.max(0, Math.floor((b.x - R) / CELL)), c1 = Math.min(COLS - 1, Math.floor((b.x + R) / CELL));
    const r0 = Math.max(0, Math.floor((b.y - R) / CELL)), r1 = Math.min(ROWS - 1, Math.floor((b.y + R) / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const cell = grid[r][c];
      if (!cell) continue;
      if (cell.type === 'ball' || cell.type === 'power') {
        // pickup: circle of radius ~18 at cell centre
        const px = c * CELL + CELL / 2, py = r * CELL + CELL / 2;
        if (Math.hypot(b.x - px, b.y - py) < R + 18) onCell(cell, r, c, b);
        continue;
      }
      if (cell.boss) {                       // one boss spans 3 cells: collide once per sub-step
        if (cell.stamp === stepId) continue;
        cell.stamp = stepId;
      }
      collideBrick(b, cell, r, c, onCell);
      if (b.dead) return 'dead';
    }
  }
  return null;
}

let stepId = 0;
const PAD = 4; // visual gap around bricks
function collideBrick(b, cell, r, c, onCell) {
  const cs = cell.boss ? cell.c0 : c, cw = cell.boss ? cell.w : 1;
  const x0 = cs * CELL + PAD, x1 = (cs + cw) * CELL - PAD, y0 = r * CELL + PAD, y1 = (r + 1) * CELL - PAD;
  const cx = Math.max(x0, Math.min(b.x, x1)), cy = Math.max(y0, Math.min(b.y, y1));
  let dx = b.x - cx, dy = b.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= R * R) return;
  let nx, ny, pen;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; pen = R - d;
  } else {                       // centre inside the box: push out through the nearest face
    const l = b.x - x0, rr = x1 - b.x, t = b.y - y0, bt = y1 - b.y, m = Math.min(l, rr, t, bt);
    if (m === l) { nx = -1; ny = 0; } else if (m === rr) { nx = 1; ny = 0; }
    else if (m === t) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
    pen = m + R;
  }
  b.x += nx * pen; b.y += ny * pen;
  const dot = b.vx * nx + b.vy * ny;
  if (dot < 0) { b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny; }
  normalise(b);
  onCell(cell, r, c, b);
}

// Keep speed constant and stop the ball getting trapped in near-horizontal travel.
function normalise(b) {
  let s = Math.hypot(b.vx, b.vy) || 1;
  let ux = b.vx / s, uy = b.vy / s;
  if (Math.abs(uy) < MIN_SIN) {
    uy = (uy < 0 || (uy === 0 && Math.random() < .5) ? -1 : 1) * MIN_SIN;
    ux = Math.sign(ux || 1) * Math.sqrt(1 - uy * uy);
  }
  b.vx = ux * SPEED; b.vy = uy * SPEED;
}

function removeCell(r, c) {
  const cell = grid[r][c];
  if (!cell) return;
  if (cell.boss) for (let k = cell.c0; k < cell.c0 + cell.w; k++) grid[r][k] = null;
  else grid[r][c] = null;
}

// Apply n damage to the brick at (r,c); returns true if it was destroyed.
function damage(r, c, n) {
  const cell = grid[r] && grid[r][c];
  if (!cell || cell.type !== 'brick') return false;
  const color = cell.boss ? '#ffd24a' : brickColor(cell.hp);
  cell.hp -= n; cell.flash = 1;
  if (cell.hp > 0) return false;
  const cx = (cell.boss ? cell.c0 + cell.w / 2 : c + .5) * CELL;
  burst(cx, r * CELL + CELL / 2, color, cell.boss ? 40 : 10);
  if (cell.boss) collected += 3;                  // boss reward
  removeCell(r, c);
  return true;
}

function fx(x, y, w, h, color) { effects.push({ x, y, w, h, color, life: .35 }); }

function triggerPower(kind, r, c) {
  const d = powerDamage();
  const cx = c * CELL, cy = r * CELL;
  if (kind === 'bomb') {
    fx(cx - CELL, cy - CELL, 3 * CELL, 3 * CELL, '255,150,60');
    for (let rr = r - 1; rr <= r + 1; rr++) for (let cc = c - 1; cc <= c + 1; cc++)
      if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS) damage(rr, cc, d);
  } else if (kind === 'hline') {
    fx(0, cy, W, CELL, '90,200,255');
    for (let cc = 0; cc < COLS; cc++) damage(r, cc, d);
  } else {
    fx(cx, 0, CELL, ROWS * CELL, '190,120,255');
    for (let rr = 0; rr < ROWS; rr++) damage(rr, c, d);
  }
}

function onRealHit(cell, r, c, b) {
  if (cell.type === 'ball') { grid[r][c] = null; collected++; return; }
  if (cell.type === 'power') { grid[r][c] = null; triggerPower(cell.kind, r, c); return; }
  if (cell.acid) {                                  // acid eats this ball, then the block is normal
    cell.acid = false; cell.flash = 1; b.dead = true; eaten++;
    burst(b.x, b.y, '#8dff3c', 8);
    return;
  }
  damage(r, c, 1);
}
const noop = () => {};

function burst(x, y, color, n = 10) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, s = 150 + Math.random() * 250;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: .5, color });
  }
}

function update(dt) {
  if (state === 'shoot') {
    shotTime += dt;
    fireTimer -= dt;
    while (toFire > 0 && fireTimer <= 0) {
      balls[ballCount - toFire].active = true; toFire--; fireTimer += FIRE_GAP;
      elBalls.textContent = (ballCount - toFire) + '/' + ballCount;
    }
    let alive = 0;
    for (const b of balls) {
      if (!b.active || b.landed) { if (!b.active) alive++; continue; }
      const res = moveBall(b, dt, onRealHit);
      if (res === 'floor') {
        b.landed = true; b.vx = b.vy = 0;
        if (landedX === null) landedX = b.x;
      } else if (res === 'dead') {
        b.landed = true; b.gone = true; b.vx = b.vy = 0;
      } else alive++;
    }
    if (alive === 0 && toFire === 0) { state = 'gather'; gatherT = 0; }
    elRecall.hidden = !(shotTime > 10 && state === 'shoot');
  } else if (state === 'gather') {
    // slide landed balls to the first landing spot, then start the next round
    gatherT += dt;
    let done = true;
    if (landedX === null) landedX = launchX;     // every ball was eaten
    for (const b of balls) {
      if (b.gone) continue;
      const d = landedX - b.x;
      if (Math.abs(d) > 2) { b.x += Math.sign(d) * Math.min(Math.abs(d), 2400 * dt); done = false; }
    }
    if (done || gatherT > 0.6) { launchX = Math.max(R, Math.min(W - R, landedX)); advanceRound(); }
  }
  for (let r = 0; r < ROWS; r++) for (const c of grid[r]) if (c && c.flash > 0) c.flash = Math.max(0, c.flash - dt * 6);
  for (let i = effects.length - 1; i >= 0; i--) if ((effects[i].life -= dt) <= 0) effects.splice(i, 1);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
let gatherT = 0;

function recall() {
  // Teleport remaining balls to the floor so a stuck shot can't soft-lock the game.
  for (const b of balls) if (b.active && !b.landed) { b.y = FLOOR - R; b.landed = true; b.vx = b.vy = 0; if (landedX === null) landedX = b.x; }
  while (toFire > 0) { const b = balls[ballCount - toFire]; b.active = true; b.landed = true; b.x = launchX; b.y = FLOOR - R; toFire--; if (landedX === null) landedX = launchX; }
  elRecall.hidden = true;
}

// ---- Rendering --------------------------------------------------------
function brickColor(hp) {
  const hue = (330 + hp * 9) % 360;
  return 'hsl(' + hue + ' 75% 58%)';
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function draw() {
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#171a2a'; ctx.fillRect(0, 0, W, H);

  // danger zone: bottom brick row
  ctx.fillStyle = 'rgba(255,80,80,.07)'; ctx.fillRect(0, (ROWS - 1) * CELL, W, CELL + 60);
  ctx.strokeStyle = '#3a4070'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, FLOOR); ctx.lineTo(W, FLOOR); ctx.stroke();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '700 38px system-ui,sans-serif';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const cell = grid[r][c]; if (!cell) continue;
    const x = c * CELL, y = r * CELL;
    if (cell.type === 'ball') {
      ctx.strokeStyle = '#7dffb0'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(x + CELL / 2, y + CELL / 2, 17, 0, 6.283); ctx.stroke();
      ctx.fillStyle = '#7dffb0'; ctx.beginPath(); ctx.arc(x + CELL / 2, y + CELL / 2, 7, 0, 6.283); ctx.fill();
    } else if (cell.type === 'power') {
      drawPower(cell.kind, x + CELL / 2, y + CELL / 2);
    } else if (cell.boss) {
      if (c !== cell.c0) continue;              // draw the boss once, from its first cell
      const bx = x + PAD, bw = cell.w * CELL - 2 * PAD, by = y + PAD, bh = CELL - 2 * PAD;
      const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
      g.addColorStop(0, '#7b3fe4'); g.addColorStop(1, '#c04cd8');
      ctx.fillStyle = g; roundRect(bx, by, bw, bh, 16); ctx.fill();
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 4; roundRect(bx + 2, by + 2, bw - 4, bh - 4, 14); ctx.stroke();
      if (cell.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + cell.flash * .6 + ')'; roundRect(bx, by, bw, bh, 16); ctx.fill(); }
      ctx.fillStyle = '#ffd24a'; ctx.font = '700 16px system-ui,sans-serif'; ctx.fillText('BOSS', bx + bw / 2, by + 16);
      ctx.fillStyle = '#fff'; ctx.font = '800 44px system-ui,sans-serif'; ctx.fillText(cell.hp, bx + bw / 2, by + bh / 2 + 8);
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(bx + 14, by + bh - 12, bw - 28, 6);
      ctx.fillStyle = '#ffd24a'; ctx.fillRect(bx + 14, by + bh - 12, (bw - 28) * Math.max(0, cell.hp / cell.max), 6);
      ctx.font = '700 38px system-ui,sans-serif';
    } else {
      ctx.fillStyle = brickColor(cell.hp);
      roundRect(x + PAD, y + PAD, CELL - 2 * PAD, CELL - 2 * PAD, 12); ctx.fill();
      if (cell.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + cell.flash * .6 + ')'; ctx.fill(); }
      if (cell.acid) {
        ctx.fillStyle = 'rgba(110,255,40,.5)'; roundRect(x + PAD, y + PAD, CELL - 2 * PAD, CELL - 2 * PAD, 12); ctx.fill();
        ctx.strokeStyle = '#8dff3c'; ctx.lineWidth = 4; ctx.stroke();
        ctx.fillStyle = 'rgba(220,255,160,.85)';
        const t = performance.now() / 600;
        for (let i = 0; i < 4; i++) {
          const bx = x + 20 + i * 20, by = y + CELL - 14 - ((t + i * .37) % 1) * 56;
          ctx.beginPath(); ctx.arc(bx, by, 3 + i % 2 * 2, 0, 6.283); ctx.fill();
        }
      }
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillText(cell.hp, x + CELL / 2, y + CELL / 2 + 2);
    }
  }

  for (const f of effects) { ctx.fillStyle = 'rgba(' + f.color + ',' + (f.life / .35 * .5) + ')'; ctx.fillRect(f.x, f.y, f.w, f.h); }

  // aim preview
  if (state === 'aim') drawPreview(aimVector());

  // balls
  ctx.fillStyle = '#fff';
  if (state === 'aim') {
    ball(launchX, FLOOR - R);
    ctx.fillStyle = '#aab'; ctx.font = '700 22px system-ui,sans-serif';
    ctx.fillText('×' + ballCount, Math.min(W - 30, Math.max(30, launchX)), FLOOR + 24);
  } else {
    for (const b of balls) if ((b.active || b.landed) && !b.gone) { ctx.fillStyle = '#fff'; ball(b.x, b.y); }
    if (state === 'shoot' && toFire > 0) { ctx.fillStyle = '#fff'; ball(launchX, FLOOR - R); }
  }

  for (const p of particles) { ctx.globalAlpha = Math.max(0, p.life * 2); ctx.fillStyle = p.color; ctx.fillRect(p.x - 3, p.y - 3, 6, 6); }
  ctx.globalAlpha = 1;
}
const POWER_STYLE = { bomb: ['#ff9a3c', '✸'], hline: ['#5ac8ff', '↔'], vline: ['#be78ff', '↕'] };
function drawPower(kind, x, y) {
  const [color, glyph] = POWER_STYLE[kind];
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 26, 0, 6.283); ctx.fill();
  ctx.fillStyle = '#12141f'; ctx.font = '700 34px system-ui,sans-serif'; ctx.fillText(glyph, x, y + 2);
  ctx.font = '700 38px system-ui,sans-serif';
}
function ball(x, y) { ctx.beginPath(); ctx.arc(x, y, R, 0, 6.283); ctx.fill(); }

function drawPreview(v) {
  const g = { x: launchX, y: FLOOR - R, vx: v.dx * SPEED, vy: v.dy * SPEED };
  let travelled = 0, hitAt = -1, hitX = 0, hitY = 0;
  const pts = [[g.x, g.y]], rebound = [];
  for (let i = 0; i < 2000 && travelled < 2400; i++) {
    const px = g.x, py = g.y;
    stopFlag = false;
    const res = moveBall(g, 1 / 120, noopStop);
    travelled += Math.hypot(g.x - px, g.y - py);
    if (stopFlag && hitAt < 0) { hitAt = travelled; hitX = g.x; hitY = g.y; rebound.push([g.x, g.y]); }
    (hitAt < 0 ? pts : rebound).push([g.x, g.y]);
    if (res === 'floor') break;
    if (hitAt >= 0 && travelled - hitAt > 400) break;  // rebound is only a hint
  }
  stopFlag = false;
  const line = (arr, color, w) => {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); arr.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.stroke();
  };
  line(pts, 'rgba(255,255,255,.85)', 4);
  if (hitAt >= 0) {
    line(rebound, 'rgba(255,210,74,.5)', 3);
    ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(hitX, hitY, R + 4, 0, 6.283); ctx.stroke();
  }
}
let stopFlag = false;
function noopStop(cell) { if (cell.type === 'brick') stopFlag = true; }   // flag the first brick contact

// ---- Layout -----------------------------------------------------------
let dpr = 1;
function resize() {
  const stage = $('stage');
  const aw = stage.clientWidth, ah = stage.clientHeight;
  scale = Math.min(aw / W, ah / H);
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.style.width = W * scale + 'px'; canvas.style.height = H * scale + 'px';
  canvas.width = Math.round(W * scale * dpr); canvas.height = Math.round(H * scale * dpr);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));

// ---- Input ------------------------------------------------------------
// Listen on the whole page so touches in the letterbox or next to the canvas still aim.
const stageEl = $('stage');
function setAimFromPointer(e) {
  const rect = canvas.getBoundingClientRect();
  aimT.x = (e.clientX - rect.left) / scale;
  aimT.y = (e.clientY - rect.top) / scale;
  clampAimT();
}
stageEl.addEventListener('pointerdown', e => {
  if (state !== 'aim' || aim) return;
  aim = { id: e.pointerId };
  try { stageEl.setPointerCapture(e.pointerId); } catch (err) {}
  setAimFromPointer(e);
  e.preventDefault();
});
stageEl.addEventListener('pointermove', e => {
  if (!aim || e.pointerId !== aim.id) return;
  setAimFromPointer(e);
  e.preventDefault();
});
function release(e, cancel) {
  if (!aim || e.pointerId !== aim.id) return;
  aim = null;
  if (!cancel && state === 'aim') { setAimFromPointer(e); const v = aimVector(); fire(v.dx, v.dy); }
}
stageEl.addEventListener('pointerup', e => release(e, false));
stageEl.addEventListener('pointercancel', e => release(e, true));
stageEl.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

elSpeed.addEventListener('click', () => { fast = !fast; elSpeed.textContent = fast ? '3×' : '1×'; elSpeed.classList.toggle('on', fast); });
elRecall.addEventListener('click', recall);
$('reset').addEventListener('click', () => {
  if (state === 'over') return;
  elTitle.textContent = 'New game?'; elText.textContent = 'Your current run will be lost.';
  elCancel.hidden = false; overlay.hidden = false;
});
elCancel.addEventListener('click', () => { overlay.hidden = true; });
$('play-normal').addEventListener('click', () => newGame(false));
$('play-hard').addEventListener('click', () => newGame(true));

// ---- Main loop --------------------------------------------------------
let last = 0, acc = 0;
function frame(t) {
  const dt = Math.min(0.1, (t - last) / 1000 || 0); last = t;
  acc += dt * (fast ? 3 : 1);
  let n = 0;
  while (acc >= STEP && n++ < 2000) { update(STEP); acc -= STEP; }
  if (n >= 2000) acc = 0;
  draw();
  requestAnimationFrame(frame);
}

resize();
if (!load()) { loadBest(); newGame(false); } else startAim();
updateHud();
requestAnimationFrame(frame);
})();
