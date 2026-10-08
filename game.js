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

const $ = id => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
const elRound = $('round'), elBest = $('best'), elBalls = $('balls');
const elSpeed = $('speed'), elRecall = $('recall'), overlay = $('overlay');

// ---- State -----------------------------------------------------------
let state;            // 'aim' | 'shoot' | 'gather' | 'over'
let round, ballCount, launchX, best = 0;
let grid;             // grid[row][col] = {type:'brick',hp,flash} | {type:'ball'} | null
let balls, toFire, fireTimer, landedX, shotTime, collected;
let particles = [], fast = false;
let aim = null;       // {x, y, id, t0x, t0y} while a finger is down
let aimT = { x: W / 2, y: 300 };   // persistent aim point (world coords)
let scale = 1;

try { best = +localStorage.getItem(SAVE_KEY + ':best') || 0; } catch (e) {}

// ---- Persistence (mobile browsers kill background tabs) --------------
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      round, ballCount, launchX,
      grid: grid.map(r => r.map(c => c && (c.type === 'brick' ? { t: 'b', hp: c.hp } : { t: 'p' })))
    }));
    localStorage.setItem(SAVE_KEY + ':best', best);
  } catch (e) {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!s || !Array.isArray(s.grid) || s.grid.length !== ROWS) return false;
    round = s.round; ballCount = s.ballCount; launchX = s.launchX;
    grid = s.grid.map(r => r.map(c => c && (c.t === 'b' ? { type: 'brick', hp: c.hp, flash: 0 } : { type: 'ball' })));
    return true;
  } catch (e) { return false; }
}

function newGame() {
  round = 1; ballCount = 1; launchX = W / 2;
  grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  spawnRow();
  startAim();
}

function startAim() {
  state = 'aim'; balls = []; toFire = 0; collected = 0; shotTime = 0;
  overlay.hidden = true; elRecall.hidden = true;
  updateHud(); save();
}

function updateHud() {
  elRound.textContent = round; elBest.textContent = best; elBalls.textContent = ballCount;
}

// ---- Level generation -------------------------------------------------
function spawnRow() {
  const row = grid[0];
  const free = [...Array(COLS).keys()];
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  shuffle(free);
  const pickup = free.pop();                      // guaranteed +1 ball
  row[pickup] = { type: 'ball' };
  const n = 2 + (Math.random() * 3 | 0);          // 2-4 bricks, always leaves gaps
  for (let i = 0; i < n && free.length > 1; i++) {
    const c = free.pop();
    row[c] = { type: 'brick', hp: Math.random() < 0.12 ? round * 2 : round, flash: 0 };
  }
}

function advanceRound() {
  ballCount += collected;
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
  try { localStorage.removeItem(SAVE_KEY); localStorage.setItem(SAVE_KEY + ':best', best); } catch (e) {}
  updateHud();
  $('ov-text').textContent = 'You survived ' + (round - 1) + ' rounds\nBest: ' + best;
  overlay.hidden = false;
}

// ---- Shooting ---------------------------------------------------------
function fire(dx, dy) {
  const len = Math.hypot(dx, dy);
  const vx = dx / len * SPEED, vy = dy / len * SPEED;
  balls = [];
  for (let i = 0; i < ballCount; i++) balls.push({ x: launchX, y: FLOOR - R, vx, vy, active: false, landed: false, lx: 0 });
  toFire = ballCount; fireTimer = 0; shotTime = 0; landedX = null; collected = 0;
  state = 'shoot';
  elBalls.textContent = '0/' + ballCount;
}

// Relative aiming: the aim point (aimT, world coords) persists between shots and is nudged by
// finger movement, so it never jumps and the finger doesn't have to cover the target.
function clampAimT() {
  aimT.x = Math.max(0, Math.min(W, aimT.x));
  aimT.y = Math.max(40, Math.min(FLOOR - 160, aimT.y));
}
function aimVector() {
  const dx = aimT.x - launchX, dy = (FLOOR - R) - aimT.y;   // dy>0 = upward
  let a = Math.atan2(dy, dx);
  const lim = Math.asin(MIN_SIN * 1.4);
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
      if (cell.type === 'ball') {
        // pickup: circle of radius ~18 at cell centre
        const px = c * CELL + CELL / 2, py = r * CELL + CELL / 2;
        if (Math.hypot(b.x - px, b.y - py) < R + 18) onCell(cell, r, c);
        continue;
      }
      collideBrick(b, cell, r, c, onCell);
    }
  }
  return null;
}

const PAD = 4; // visual gap around bricks
function collideBrick(b, cell, r, c, onCell) {
  const x0 = c * CELL + PAD, x1 = (c + 1) * CELL - PAD, y0 = r * CELL + PAD, y1 = (r + 1) * CELL - PAD;
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
  onCell(cell, r, c);
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

function onRealHit(cell, r, c) {
  if (cell.type === 'ball') { grid[r][c] = null; collected++; return; }
  const color = brickColor(cell.hp);
  cell.hp--; cell.flash = 1;
  if (cell.hp <= 0) { burst(c * CELL + CELL / 2, r * CELL + CELL / 2, color); grid[r][c] = null; }
}
const noop = () => {};

function burst(x, y, color) {
  for (let i = 0; i < 10; i++) {
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
      if (moveBall(b, dt, onRealHit) === 'floor') {
        b.landed = true; b.vx = b.vy = 0;
        if (landedX === null) landedX = b.x;
      } else alive++;
    }
    if (alive === 0 && toFire === 0) { state = 'gather'; gatherT = 0; }
    elRecall.hidden = !(shotTime > 10 && state === 'shoot');
  } else if (state === 'gather') {
    // slide landed balls to the first landing spot, then start the next round
    gatherT += dt;
    let done = true;
    for (const b of balls) {
      const d = landedX - b.x;
      if (Math.abs(d) > 2) { b.x += Math.sign(d) * Math.min(Math.abs(d), 2400 * dt); done = false; }
    }
    if (done || gatherT > 0.6) { launchX = Math.max(R, Math.min(W - R, landedX)); advanceRound(); }
  }
  for (let r = 0; r < ROWS; r++) for (const c of grid[r]) if (c && c.flash > 0) c.flash = Math.max(0, c.flash - dt * 6);
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
    } else {
      ctx.fillStyle = brickColor(cell.hp);
      roundRect(x + PAD, y + PAD, CELL - 2 * PAD, CELL - 2 * PAD, 12); ctx.fill();
      if (cell.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + cell.flash * .6 + ')'; ctx.fill(); }
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillText(cell.hp, x + CELL / 2, y + CELL / 2 + 2);
    }
  }

  // aim preview
  if (state === 'aim') drawPreview(aimVector());

  // balls
  ctx.fillStyle = '#fff';
  if (state === 'aim') {
    ball(launchX, FLOOR - R);
    ctx.fillStyle = '#aab'; ctx.font = '700 22px system-ui,sans-serif';
    ctx.fillText('×' + ballCount, Math.min(W - 30, Math.max(30, launchX)), FLOOR + 24);
  } else {
    for (const b of balls) if (b.active || b.landed) { ctx.fillStyle = '#fff'; ball(b.x, b.y); }
    if (state === 'shoot' && toFire > 0) { ctx.fillStyle = '#fff'; ball(launchX, FLOOR - R); }
  }

  for (const p of particles) { ctx.globalAlpha = Math.max(0, p.life * 2); ctx.fillStyle = p.color; ctx.fillRect(p.x - 3, p.y - 3, 6, 6); }
  ctx.globalAlpha = 1;
}
function ball(x, y) { ctx.beginPath(); ctx.arc(x, y, R, 0, 6.283); ctx.fill(); }

function drawPreview(v) {
  const g = { x: launchX, y: FLOOR - R, vx: v.dx * SPEED, vy: v.dy * SPEED };
  let travelled = 0, nextDot = 0, hitAt = -1;
  ctx.lineWidth = 3;
  for (let i = 0; i < 2000 && travelled < 2200; i++) {
    const px = g.x, py = g.y;
    stopFlag = false;
    const res = moveBall(g, 1 / 120, noopStop);
    travelled += Math.hypot(g.x - px, g.y - py);
    if (stopFlag && hitAt < 0) {                       // first brick: mark impact, keep drawing the rebound
      hitAt = travelled;
      ctx.strokeStyle = '#ffd24a'; ctx.beginPath(); ctx.arc(g.x, g.y, R + 4, 0, 6.283); ctx.stroke();
    }
    if (res === 'floor') break;
    if (hitAt >= 0 && travelled - hitAt > 350) break;  // rebound is only a hint
    if (travelled >= nextDot) {
      ctx.fillStyle = hitAt < 0 ? 'rgba(255,255,255,.9)' : 'rgba(255,210,74,.55)';
      ctx.beginPath(); ctx.arc(g.x, g.y, hitAt < 0 ? 5 : 4, 0, 6.283); ctx.fill();
      nextDot += 34;
    }
  }
  stopFlag = false;
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
stageEl.addEventListener('pointerdown', e => {
  if (state !== 'aim' || aim) return;
  aim = { x: e.clientX, y: e.clientY, id: e.pointerId, t0x: aimT.x, t0y: aimT.y };
  try { stageEl.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
});
stageEl.addEventListener('pointermove', e => {
  if (!aim || e.pointerId !== aim.id) return;
  aimT.x = aim.t0x + (e.clientX - aim.x) / scale;
  aimT.y = aim.t0y + (e.clientY - aim.y) / scale;
  clampAimT();
  e.preventDefault();
});
function release(e, cancel) {
  if (!aim || e.pointerId !== aim.id) return;
  aim = null;
  if (!cancel && state === 'aim') { const v = aimVector(); fire(v.dx, v.dy); }
}
stageEl.addEventListener('pointerup', e => release(e, false));
stageEl.addEventListener('pointercancel', e => release(e, true));
stageEl.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

elSpeed.addEventListener('click', () => { fast = !fast; elSpeed.textContent = fast ? '3×' : '1×'; elSpeed.classList.toggle('on', fast); });
elRecall.addEventListener('click', recall);
$('restart').addEventListener('click', newGame);

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
if (!load()) newGame(); else startAim();
updateHud();
requestAnimationFrame(frame);
})();
