import {
  Game, GameError, FRUIT_EMOJI, RACK_MAX, IDLE_SKIP_MS, waitingOn,
} from './engine/game.js';
// Moves that leave your turn where it is. Everything that puts letters on
// the board — placing, swapping — is a play, and is not among them.
const NON_TURN_MOVES = new Set([
  'choose', 'proposeEnd', 'voteEnd', 'kick', 'admin', 'restart', 'goal', 'mode', 'skip', 'away',
  'newDay',
]);
import { buildWordList, takeCpuTurn } from './cpu.js';
import { Dictionary } from './engine/dictionary.js';
import { Board, WORLD, wrapCoord, DIRS } from './engine/board.js';
import { premiumAt } from './engine/premium.js';
import { feasibleDirection } from './placement.js';
import { drawFruit } from './fruit.js';
import { FLOURISH_MS, flourishFor, flourishAt } from './flourish.js';
import { LETTER_VALUES, BLANK } from './engine/tiles.js';
import { Online, NetError, account, recent } from './net.js';
import { notify } from './notify.js';
import parlour from './themes/parlour.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
const BASE_TITLE = document.title;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const status = (msg, cls = '') => {
  $('status').textContent = msg;
  $('status').className = cls;
};

// The word list is 2.7MB and boot does not wait for it. The board, the
// seats and the live state are all usable the moment the page is — only
// validating a word needs the list, and no human assembles a word in the
// second it takes to arrive. Until then previews say so rather than lying.
const dictionary = new Dictionary();
dictionary.ready = false;
status('unpacking the word list…');
fetch('./data/words.txt')
  .then((r) => r.text())
  .then((text) => {
    dictionary.addText(text);
    dictionary.ready = true;
    status('');
    refresh();
    runCpuTurns(); // a robot may have been sitting on its turn, wordless
  })
  .catch(() => status('the word list failed to load — refresh the page', 'error'));

// ---------------------------------------------------------------- game state
let game = new Game({ dictionary });
let session = null; // Online session when playing over the internet
let seq = 0; // last state sequence seen from the server
let currentPlayer = null;
let placement = null; // { sx, sy, dir, entries: [{x,y,letter,typed,existing,fromBlank,redefine}] }
let swapping = null; // { picks: [{x,y,letter,fromBlank}], at: {x,y}|null }
let selected = null; // { x, y } for the actions panel
let kbCursor = null; // keyboard cursor cell, moved with the arrow keys
let cpuWordList = null; // lazy-built candidate words for CPU players
let pickingBlank = null; // choosing which letter a blank stands for
let exchanging = null; // { picks: number[] }: rack indices marked for exchange
let lastDir = 'h'; // the direction the player last chose, for stable defaults

const online = () => session !== null;

const savedName = (() => {
  try {
    return localStorage.getItem('wordser:name') ?? '';
  } catch {
    return '';
  }
})();
/** Bring the panel back to the top — new sections appear above the fold. */
function showPanelTop() {
  $('panel').scrollTo({ top: 0, behavior: 'smooth' });
}

function rememberName(name) {
  try {
    localStorage.setItem('wordser:name', name);
  } catch {}
}

// ------------------------------------------------------------------ glints
// A newcomer can't tell which controls do anything. Each one that matters
// carries a slow sweep of light until they use it once, then that glint is
// gone for good — the hint retires itself instead of nagging.
// Keyed per player: a shared hot-seat device shouldn't spend player two's
// hints on player one.
const glintKey = () => {
  const me = game?.players?.[currentPlayer]?.name ?? savedName ?? '';
  return `wordser:used:${me.trim().toLowerCase()}`;
};
let usedFor = null;
let used = new Set();
function loadUsed() {
  const key = glintKey();
  if (key === usedFor) return used;
  usedFor = key;
  try {
    used = new Set(JSON.parse(localStorage.getItem(key) ?? '[]'));
  } catch {
    used = new Set();
  }
  return used;
}

/** Record that the player has now done this, retiring its glint. */
function markUsed(...actions) {
  loadUsed();
  let fresh = false;
  for (const a of actions) if (!used.has(a)) (used.add(a), (fresh = true));
  if (!fresh) return;
  try {
    localStorage.setItem(usedFor, JSON.stringify([...used]));
  } catch {
    // Private browsing: the glints simply come back next visit.
  }
}

// One at a time: two sweeps in a 330px column read as decoration, one
// reads as a pointer. Order is which hint helps most when several apply.
const GLINT_ORDER = ['play', 'cpu', 'propose', 'exchange', 'account'];
let glintQueue = [];

/** Glint `el` while `action` is still unfamiliar. */
function glint(el, action) {
  if (el && !loadUsed().has(action)) glintQueue.push({ el, action });
  return el;
}

/** Light the single most useful unfamiliar control of this render. */
function applyGlints() {
  // Persistent nodes keep the class across renders; clear before re-picking.
  for (const el of document.querySelectorAll('.glint')) el.classList.remove('glint');
  const best = glintQueue.sort(
    (a, b) => GLINT_ORDER.indexOf(a.action) - GLINT_ORDER.indexOf(b.action),
  )[0];
  glintQueue = [];
  if (!best) return;
  // Re-adding the class restarts the burst, so each turn gets one nudge.
  best.el.classList.add('glint');
}

// ---------------------------------------------------------------- rendering
// cam.x/cam.y are the world-pixel coordinates of the screen's top-left
// corner; cam.cell is the hex size (centre to corner) in pixels.
const cam = { x: -400, y: -300, cell: 46 };

const PREMIUM_TEXT = { TW: '3×W', DW: '2×W', TL: '3×L', DL: '2×L' };

// ------------------------------------------------------------------- theme
const theme = parlour;
const T = () => theme.canvas;
for (const [k, v] of Object.entries(theme.css ?? {})) {
  document.documentElement.style.setProperty(k, v);
}

/** A per-cell stable hash for texture jitter (grain, speckle). */
const cellHash = (x, y) => {
  let h = (Math.imul(wrapCoord(x) + 1, 73856093) ^ Math.imul(wrapCoord(y) + 1, 19349663)) >>> 0;
  return () => {
    h = (Math.imul(h, 1597334677) + 12345) >>> 0;
    return h / 4294967296;
  };
};

const DIR_GLYPH = { h: '→', v: '↓' };
const NEXT_DIR = { h: 'v', v: 'h' };

/** Screen-space centre of cell (x, y) on the octagon lattice. */
function hexCenter(x, y) {
  return [x * cam.cell + cam.cell / 2 - cam.x, y * cam.cell + cam.cell / 2 - cam.y];
}

/** A rounded square of half-width a centred at (cx, cy). */
function hexPath(cx, cy, a) {
  ctx.beginPath();
  ctx.roundRect(cx - a, cy - a, a * 2, a * 2, a * 0.22);
}

let camCentered = false;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!camCentered && canvas.clientWidth > 0) {
    // Open with the ★ start cell centred, whatever the screen size.
    camCentered = true;
    cam.x = cam.cell / 2 - canvas.clientWidth / 2;
    cam.y = cam.cell / 2 - canvas.clientHeight / 2;
  }
  render();
}
window.addEventListener('resize', resize);

function cellAt(px, py) {
  return {
    x: Math.floor((px + cam.x) / cam.cell),
    y: Math.floor((py + cam.y) / cam.cell),
  };
}

/** Iterate every cell that could be visible, with a margin. */
function* visibleHexes() {
  const s = cam.cell;
  const x0 = Math.floor(cam.x / s) - 1;
  const x1 = Math.ceil((cam.x + canvas.clientWidth) / s) + 1;
  const y0 = Math.floor(cam.y / s) - 1;
  const y1 = Math.ceil((cam.y + canvas.clientHeight) / s) + 1;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) yield [x, y];
  }
}

/**
 * The halo sprite: a ring of light with a hole in the middle, so it lands on
 * the board around a tile and never on the letter. Cached per colour — a
 * radial gradient per cell per frame is the sort of thing that shows up on a
 * phone.
 */
const halos = new Map();
function wordHalo(colour) {
  const found = halos.get(colour);
  if (found) return found;
  const S = 128;
  const h = S / 2;
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = S;
  const g = sprite.getContext('2d');
  const tint = (a) => colour.replace(/rgba?\(([^)]+?)(,\s*[\d.]+)?\)/, `rgba($1,${a})`);
  const ramp = g.createRadialGradient(h, h, 0, h, h, h);
  ramp.addColorStop(0.0, tint(0));
  ramp.addColorStop(0.4, tint(0)); // the tile's own ground stays clear
  ramp.addColorStop(0.52, tint(0.5));
  ramp.addColorStop(0.7, tint(0.22));
  ramp.addColorStop(1.0, tint(0));
  g.fillStyle = ramp;
  g.fillRect(0, 0, S, S);
  halos.set(colour, sprite);
  return sprite;
}

// ------------------------------------------------------------ cell sprites
//
// The board is thousands of cells redrawn every frame, and drawing one the
// long way — a rounded path, a gradient, three grain strokes, two runs of
// text — costs the frame budget several times over on a big board. So every
// distinct look is drawn exactly once per zoom level onto its own little
// canvas, and a frame is drawImage per cell, which the GPU treats as a
// stamp. Grain and speckle come in four jittered variants so neighbouring
// tiles still refuse to match, picked per cell by position.
//
// The cache is keyed by the rounded cell size (a pinch redraws scaled from
// the nearest cached size, then crisply once the size settles), the device
// pixel ratio, and the theme.
const sprites = { cell: new Map(), tile: new Map(), size: 0, dpr: 0 };
const SPRITE_VARIANTS = 4;
const TILE_PAD = 0.7; // tile sprites are 1.4 cells square: room for the shadow

function ensureSprites() {
  const size = Math.max(8, Math.round(cam.cell));
  const dpr = window.devicePixelRatio || 1;
  if (sprites.size === size && sprites.dpr === dpr) return;
  sprites.cell.clear();
  sprites.tile.clear();
  sprites.size = size;
  sprites.dpr = dpr;
}

function makeSprite(cells) {
  const px = Math.ceil(cells * sprites.size * sprites.dpr);
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d');
  g.scale(sprites.dpr, sprites.dpr);
  return [cv, g];
}

const spritePath = (g, cx, cy, a) => {
  g.beginPath();
  g.roundRect(cx - a, cy - a, a * 2, a * 2, a * 0.22);
};

/** The board behind everything: plain felt, seam, star ground, premiums. */
function cellSprite(kind, variant) {
  const key = `${kind}:${variant}`;
  const hit = sprites.cell.get(key);
  if (hit) return hit;
  const c = sprites.size;
  const [cv, g] = makeSprite(1);
  const mid = c / 2;
  spritePath(g, mid, mid, c * 0.47);
  // A trailing '!' is a premium drawn without its label — the ★ cell is a
  // DW square, but the star glyph stands where the label would.
  const bare = kind.endsWith('!');
  const face = bare ? kind.slice(0, -1) : kind;
  const isPremium = face in PREMIUM_TEXT;
  g.fillStyle = isPremium
    ? T().premium[face]
    : face === 'start'
      ? T().startFill
      : face === 'seam'
        ? T().seamFill
        : T().cellFill;
  g.fill();
  if (T().cellStroke) {
    g.strokeStyle = T().cellStroke;
    g.lineWidth = 1;
    g.stroke();
  }
  if (T().speckle && !isPremium) {
    const rnd = cellHash(variant * 131 + 7, variant * 17 + 3);
    g.fillStyle = T().speckle;
    for (let i = 0; i < 3; i++) {
      g.fillRect(mid - c * 0.35 + rnd() * c * 0.7, mid - c * 0.35 + rnd() * c * 0.7, 1.5, 1.5);
    }
  }
  if (isPremium && c >= 26 && !bare) {
    g.fillStyle = T().premiumLabel;
    g.font = `${Math.floor(c * 0.24)}px ${T().letterFont ?? 'system-ui'}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(PREMIUM_TEXT[face], mid, mid);
  }
  sprites.cell.set(key, cv);
  return cv;
}

/** A finished tile: shadow, face, grain, letter and value, ready to stamp. */
function tileSprite(letter, { blank = false, pending = false, redefine = false }, variant) {
  const key = `${letter}:${+blank}${+pending}${+redefine}:${variant}`;
  const hit = sprites.tile.get(key);
  if (hit) return hit;
  const c = sprites.size;
  const t = T().tile;
  const [cv, g] = makeSprite(TILE_PAD * 2);
  const mid = TILE_PAD * c;
  const face = pending ? t.pendingFace : blank ? t.blankFace : t.face;
  g.beginPath();
  g.roundRect(mid - c * 0.4, mid - c * 0.36, c * 0.82, c * 0.86, c * 0.1);
  g.fillStyle = 'rgba(0,0,0,0.34)';
  g.fill();
  spritePath(g, mid, mid, c * 0.42);
  if (t.style === 'bevel') {
    const grad = g.createLinearGradient(mid, mid - c / 2, mid, mid + c / 2);
    grad.addColorStop(0, (pending ? t.pendingFaceLight : t.faceLight) ?? face);
    grad.addColorStop(1, (pending ? t.pendingFaceDark : t.faceDark) ?? face);
    g.fillStyle = grad;
    g.fill();
    if (t.edgeDark) {
      g.strokeStyle = t.edgeDark;
      g.lineWidth = Math.max(1.5, c * 0.045);
      g.stroke();
    }
    if (t.edgeLight) {
      spritePath(g, mid, mid - c * 0.03, c * 0.37);
      g.strokeStyle = t.edgeLight;
      g.lineWidth = 1;
      g.stroke();
    }
    spritePath(g, mid, mid, c * 0.42);
  } else {
    g.fillStyle = face;
    g.fill();
  }
  if (t.grain && !pending && !blank) {
    const rnd = cellHash(variant * 977 + 11, variant * 41 + 5);
    g.save();
    g.clip();
    g.strokeStyle = t.grain;
    g.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const gy = mid - c * 0.35 + rnd() * c * 0.7;
      g.beginPath();
      g.moveTo(mid - c / 2, gy);
      g.bezierCurveTo(mid - c * 0.17, gy + rnd() * c * 0.12 - c * 0.06, mid + c * 0.17, gy - rnd() * c * 0.12 + c * 0.06, mid + c / 2, gy);
      g.stroke();
    }
    g.restore();
    spritePath(g, mid, mid, c * 0.42);
  }
  if (redefine) {
    g.strokeStyle = T().redefine;
    g.lineWidth = 2;
    g.stroke();
  }
  g.fillStyle = t.text;
  g.font = `700 ${Math.floor(c * 0.48)}px ${T().letterFont ?? 'system-ui'}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter.toUpperCase(), mid, mid - c * 0.02);
  const v = blank ? 0 : LETTER_VALUES[letter] ?? 0;
  g.font = `${Math.floor(c * 0.19)}px ${T().letterFont ?? 'system-ui'}`;
  g.fillText(String(v), mid + c * 0.24, mid + c * 0.3);
  sprites.tile.set(key, cv);
  return cv;
}

// Pointer events arrive faster than frames are worth painting — a mouse can
// report at 1000Hz — so panning and pinching ask for a frame instead of
// painting one, and at most one runs per animation frame.
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// Today's island, worked out once per change rather than once per frame.
// A placement always adds a cell, a new day moves the anchor, and nothing
// else can alter which letters are joined to which.
let islandMemo = { sig: null, keys: new Set() };
function islandKeys() {
  const root = game.islandCell ?? game.startCell;
  const sig = `${game.day}:${game.board.cells.size}:${root.x},${root.y}`;
  if (islandMemo.sig !== sig) islandMemo = { sig, keys: game.island() };
  return islandMemo.keys;
}

function render() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const c = cam.cell;
  ensureSprites();

  const drawTile = (x, y, letter, opts = {}) => {
    const [cx, cy] = hexCenter(x, y);
    const move = flourish(x, y);
    if (move) {
      // Transform about the tile's own centre so the letter rides with it.
      ctx.save();
      ctx.translate(cx + move.dx, cy + move.dy);
      ctx.rotate(move.rot);
      ctx.scale(move.scale, move.scale);
      ctx.translate(-cx, -cy);
    }
    const variant = (wrapCoord(x) * 7 + wrapCoord(y) * 13) % SPRITE_VARIANTS;
    const pad = TILE_PAD * c;
    ctx.drawImage(tileSprite(letter, opts, variant), cx - pad, cy - pad, pad * 2, pad * 2);
    if (move) ctx.restore();
  };

  const lm = lastWordKeys();
  const island = islandKeys(); // once per frame, not once per cell
  const lit = []; // centres of the last word's cells, haloed after the loop

  for (const [x, y] of visibleHexes()) {
    const [cx, cy] = hexCenter(x, y);
    const p = premiumAt(x, y);
    const isStart = wrapCoord(x) === game.startCell.x && wrapCoord(y) === game.startCell.y;
    const kind = isStart
      ? p ? `${p}!` : 'start'
      : p ?? (wrapCoord(x) === 0 || wrapCoord(y) === 0 ? 'seam' : 'plain');
    const variant = (wrapCoord(x) * 7 + wrapCoord(y) * 13) % SPRITE_VARIANTS;
    ctx.drawImage(cellSprite(kind, variant), cx - c / 2, cy - c / 2, c, c);

    const tile = game.board.get(x, y);
    if (tile) {
      // Letters on an older island are out of bounds until somebody bridges
      // out to them, and the board says so by letting them fade into it.
      const off = !island.has(Board.key(x, y));
      if (off) ctx.globalAlpha = 0.42;
      drawTile(x, y, Board.effective(tile), { blank: !!tile.isBlank });
      if (off) ctx.globalAlpha = 1;
    } else {
      const fruit = game.fruits.get(Board.key(x, y));
      if (fruit) {
        // Fruit yield while you are spelling: your pending letters and the
        // cursor own the stage until you commit.
        const key = Board.key(x, y);
        const up = anticAt(key);
        if (up) {
          ctx.save();
          ctx.translate(cx + up.dx * c, cy + up.dy * c);
          ctx.rotate(up.rot);
          ctx.scale(up.sx, up.sy);
          ctx.translate(-cx, -cy);
        }
        drawFruit(ctx, fruit, cx, cy, c * 0.32, {
          spawn: spawnPhase(key),
          alpha: placement ? 0.62 : 1,
          t: performance.now() / 1000,
          seed: (wrapCoord(x) * 7 + wrapCoord(y) * 13) % 17, // its own rhythm
        });
        if (up) ctx.restore();
      } else if (isStart) {
        ctx.fillStyle = T().star;
        ctx.font = `${Math.floor(c * 0.55)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', cx, cy + c * 0.03);
      }
    }

    // Highlight the most recent move so opponent/CPU plays are easy to spot.
    if (lm?.has(Board.key(x, y))) {
      lit.push([cx, cy]);
      hexPath(cx, cy, c * 0.47);
      ctx.strokeStyle = T().lastMove;
      ctx.lineWidth = Math.max(2, c * 0.06);
      ctx.stroke();
      hexPath(cx, cy, c * 0.42);
      ctx.strokeStyle = 'rgba(255,214,160,0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // The last word always wears a halo: light spilling onto the board around
  // it, never over the letters. One pass at the end so the glows of adjacent
  // cells add into a single aura along the whole word rather than being
  // painted over by the next cell's background.
  if (lit.length) {
    const sprite = wordHalo(T().lastMove);
    const R = c * 1.15;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55;
    for (const [cx, cy] of lit) ctx.drawImage(sprite, cx - R, cy - R, R * 2, R * 2);
    ctx.restore();
  }

  if (placement) {
    for (const e of placement.entries) {
      if (e.redefine) drawTile(e.x, e.y, e.redefine, { blank: true, redefine: true });
      else if (!e.existing) {
        drawTile(e.x, e.y, e.letter, { pending: true, blank: e.fromBlank });
      }
    }
    const cur = nextCell();
    const [cx, cy] = hexCenter(cur.x, cur.y);
    hexPath(cx, cy, c * 0.46);
    ctx.strokeStyle = T().cursor;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = T().cursor;
    ctx.font = `700 ${Math.floor(c * 0.42)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(DIR_GLYPH[placement.dir], cx, cy);
  } else if (selected) {
    const [cx, cy] = hexCenter(selected.x, selected.y);
    hexPath(cx, cy, c * 0.46);
    ctx.strokeStyle = T().selected;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Letters promised to a swap, shown where they will land.
  if (swapping) {
    for (const sw of swapping.picks) {
      drawTile(sw.x, sw.y, sw.letter, { pending: true, blank: sw.fromBlank });
    }
    const at = swapping.at;
    if (at) {
      const [ax, ay] = hexCenter(at.x, at.y);
      hexPath(ax, ay, c * 0.46);
      ctx.strokeStyle = T().cursor;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // A tile carried over the board: show the cell it would land on.
  if (dropCell) {
    const [cx, cy] = hexCenter(dropCell.x, dropCell.y);
    hexPath(cx, cy, c * 0.47);
    ctx.strokeStyle = game.board.get(dropCell.x, dropCell.y) ? T().lastMove : T().cursor;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  if (kbCursor && !placement) {
    const [cx, cy] = hexCenter(kbCursor.x, kbCursor.y);
    hexPath(cx, cy, c * 0.46);
    ctx.strokeStyle = T().cursor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Where the cursor is sitting: the next letter goes here. */
function nextCell() {
  return { x: placement.cx, y: placement.cy };
}

/** True if this cell already holds one of the letters being placed. */
const pendingAt = (x, y) => placement?.entries.find((e) => e.x === x && e.y === y);

/**
 * Where a letter actually lands from the cursor: the cursor's own cell,
 * stepping past only your own pending letters. Whatever is sitting there
 * is dealt with when the letter arrives — reused if it already says the
 * same thing, redefined if it is a wildcard, written over otherwise.
 */
function landingCell() {
  const [dx, dy] = DIRS[placement.dir];
  let { x, y } = nextCell();
  for (let guard = 0; guard < 64; guard++) {
    if (!pendingAt(x, y)) break;
    x += dx;
    y += dy;
  }
  return { x, y };
}

/** Put the cursor on a cell, moving nothing else. */
function moveCursor(x, y) {
  placement.cx = x;
  placement.cy = y;
  ensureVisible(x, y);
}

// ------------------------------------------------------------------- panels

// The players list is rebuilt from nothing, so it must only be rebuilt when
// it would actually differ: a list that redraws under the pointer eats the
// click, and one that redraws under the keyboard eats the focus. The idle
// clocks tick every twenty seconds, which is exactly often enough for both.
let playersDrawn = null;
function renderPlayers() {
  const box = $('players');
  if (!game.players.length) {
    if (playersDrawn !== 'empty') {
      box.innerHTML = '<div class="muted">No players yet.</div>';
      playersDrawn = 'empty';
    }
    return;
  }
  const me = online() ? session.playerId : currentPlayer;
  const sig = JSON.stringify([
    online(), me, currentPlayer, game.mode, game.turnId, Boolean(game.over), game.adminId,
    game.players.map((p) => [
      p.id, p.name, p.score, p.stars, p.played, p.total, p.isCpu, Boolean(p.away),
      game.isTheirTurn(p.id), idleNote(p)?.text ?? '',
    ]),
  ]);
  if (sig === playersDrawn) return;
  playersDrawn = sig;
  box.innerHTML = '';
  // Online the admin's tools are the admin's; round one screen they belong
  // to whoever is holding it, like every other table setting.
  const iAmAdmin = online() ? game.isAdmin(me) : true;
  for (const p of game.players) {
    const div = document.createElement('div');
    div.className = 'player';
    if (p.id === currentPlayer) div.classList.add('current');
    // Every seat says where it stands: one is up, the rest are waiting.
    const theirTurn = game.isTheirTurn(p.id);
    div.classList.add(theirTurn ? 'to-play' : 'waiting');
    if (p.away) div.classList.add('is-away');
    const you = online() && p.id === session.playerId ? ' <small>(you)</small>' : '';
    const crown = game.isAdmin(p.id) ? ' <span title="game admin">👑</span>' : '';
    const idle = idleNote(p);
    // Where they stand goes on a second line under the name: a name, a tag,
    // a clock, stars, a score and two buttons will not fit across 330px.
    const meta = p.away
      ? '💤 busy — turns pass themselves'
      : theirTurn
        ? idle ? `⏳ ${esc(idle.text)} on this turn` : 'to play'
        : `waiting${idle ? ` · ${esc(idle.text)}` : ''}`;
    const avg = p.played ? Math.round(p.total / p.played) : null;
    const record = [
      `${p.stars} day${p.stars === 1 ? '' : 's'} won`,
      avg == null ? 'no days finished yet' : `${avg} a day on average over ${p.played}`,
    ].join(' · ');
    // Round one screen the name is how you take the seat, so it is a real
    // button — reachable by tab, and never the whole row, which now carries
    // buttons of its own.
    const seat = online() ? 'span' : 'button';
    div.innerHTML = `
      <${seat} class="who"${online() ? '' : ' type="button"'}
        title="${esc(p.name)} — ${esc(record)}${idle ? `. ${esc(idle.why)}` : ''}">
        <span class="name">${esc(p.name)}${crown}${you}</span>
        <span class="meta${theirTurn ? ' now' : ''}">${meta}</span>
      </${seat}>
      ${p.stars ? `<span class="stars">★${p.stars > 1 ? p.stars : ''}</span>` : ''}
      <span class="score">${p.score}</span>`;
    if (!online()) {
      const take = () => {
        currentPlayer = p.id;
        cancelModes();
        refresh();
      };
      div.querySelector('.who').onclick = take;
      div.onclick = (e) => {
        if (e.target.closest('button')) return; // a control, not the seat
        take();
      };
    }
    // The skip belongs to whoever holds the turn — including the admin's own
    // seat, in a hot-seat game where they are driving for everybody.
    if (iAmAdmin) {
      const tools = adminTools(p, me);
      if (tools.childElementCount) div.appendChild(tools);
    }
    box.appendChild(div);
  }
}

/**
 * How long a seat has been quiet, for whoever is running the table. The one
 * holding the turn is measured from when it arrived — that is the number
 * that decides whether they are holding things up — and everybody else from
 * their last move. Robots and a table of one have nothing to answer for.
 */
function idleNote(p) {
  const me = online() ? session.playerId : currentPlayer;
  if (!(online() ? game.isAdmin(me) : true)) return null;
  if (game.players.length < 2 || p.isCpu || game.over) return null;
  const theirTurn = game.mode === 'turns' && game.turnId === p.id;
  const since = theirTurn ? (game.turnStartedAt ?? p.lastActedAt) : p.lastActedAt;
  if (!since) return null;
  const ms = Date.now() - since;
  if (ms < 60_000) return null; // a minute is not idling
  const text = agoText(ms);
  return {
    text,
    why: theirTurn
      ? `${p.name} has had the turn for ${text} — ${agoText(Math.max(0, IDLE_SKIP_MS - ms))} before it passes automatically`
      : `${p.name} last played ${text} ago`,
  };
}

/** A duration in the roundest words that still say something. */
function agoText(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The admin's per-player controls: hand over the crown, or remove a seat. */
function adminTools(p, me) {
  const tools = document.createElement('span');
  tools.className = 'admin-tools';
  // Only the seat holding the turn can be skipped, and only in a rotation:
  // in a free-for-all nobody is in anybody's way.
  if (game.mode === 'turns' && game.turnId === p.id && !game.over) {
    const skip = document.createElement('button');
    skip.className = 'mini';
    skip.textContent = '⏭';
    skip.title = `skip ${p.name}'s turn`;
    skip.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Skip ${p.name}'s turn? Play moves on to the next seat.`)) return;
      doMove({ type: 'skip', targetId: p.id }, (r) =>
        r.dayEnded ? `${r.skipped} was skipped — a new day begins! ★` : `${r.skipped} was skipped ⏭`,
      );
    };
    tools.appendChild(skip);
  }
  if (p.id === me) return tools; // nothing else applies to your own seat
  // A seat that has gone quiet for a day can have its turns passed for it,
  // so four people aren't held up by one. Never the admin's to keep: the
  // player takes them back with a tick, or simply by playing.
  if (!p.isCpu && game.players.length > 1 && game.mode === 'turns' && !game.over) {
    const busy = document.createElement('button');
    busy.className = 'mini' + (p.away ? ' on' : '');
    busy.textContent = '💤';
    busy.setAttribute('aria-pressed', String(Boolean(p.away)));
    busy.title = p.away
      ? `${p.name}'s turns are passing themselves — put them back in the game`
      : `pass ${p.name}'s turns until they come back`;
    busy.onclick = (e) => {
      e.stopPropagation();
      if (!p.away && !confirm(
        `Pass ${p.name}'s turns until they come back? They can take them back whenever they like.`,
      )) return;
      doMove({ type: 'away', targetId: p.id, away: !p.away, playerId: game.adminId }, (r) =>
        r.away
          ? `${p.name}'s turns will pass themselves 💤`
          : `${p.name} is back in the game 👋`,
      );
    };
    tools.appendChild(busy);
  }
  if (!p.isCpu) {
    const crown = document.createElement('button');
    crown.className = 'mini';
    crown.textContent = '👑';
    crown.title = `make ${p.name} the admin`;
    crown.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Hand admin to ${p.name}? You won't be able to take it back yourself.`)) return;
      doMove({ type: 'admin', toId: p.id }, () => `${p.name} is the admin now 👑`);
    };
    tools.appendChild(crown);
  }
  const kick = document.createElement('button');
  kick.className = 'mini';
  kick.textContent = '✕';
  kick.title = `remove ${p.name} from the game`;
  kick.onclick = (e) => {
    e.stopPropagation();
    if (!confirm(`Remove ${p.name} from the game? Their letters go back in the bag.`)) return;
    doMove({ type: 'kick', targetId: p.id }, (r) =>
      r.dayEnded ? `${r.removed} was removed — a new day begins! ★` : `${r.removed} was removed`,
    );
  };
  tools.appendChild(kick);
  return tools;
}

function renderRack() {
  const box = $('rack');
  box.innerHTML = '';
  const p = game.players[currentPlayer];
  if (!p) {
    box.innerHTML = '<div class="muted">Add a player to get a rack.</div>';
    $('rack-hint').textContent = '';
    return;
  }
  $('rack-hint').textContent = exchanging
    ? '— tap up to 7 to swap back into the bag'
    : (online() ? '' : `— ${p.name} `) + `· ${game.bag.pool.length} in today's bag`;
  // Which rack tiles the pending move actually spends, so their slots can
  // stand empty while the letters are out on the board.
  let pendingUse = [];
  if (placement) {
    pendingUse = placement.entries.filter((e) => !e.existing).map((e) => (e.fromBlank ? BLANK : e.letter));
  }
  // Letters promised to a pending swap have left the tray too.
  if (swapping) {
    pendingUse = swapping.picks.map((s) => (s.fromBlank ? BLANK : s.letter));
  }
  // The tray is twelve fixed slots, not a packed row: every letter has an
  // address the player chose, and the gaps between them are the point —
  // laying C _ T out with a hole in it is how you see the play.
  const layout = layoutFor(p);
  // Which slot holds which rack index, so taps still name a real tile.
  const claimed = new Set();
  const rackIndexAt = new Map();
  layout.forEach((l, at) => {
    if (l === null) return;
    const i = p.rack.findIndex((r, j) => r === l && !claimed.has(j));
    if (i !== -1) {
      claimed.add(i);
      rackIndexAt.set(at, i);
    }
  });
  // A letter the pending word has spent leaves its slot empty rather than
  // closing the tray up: you can see where it went.
  const spending = [...pendingUse];
  layout.forEach((l, at) => {
    let show = l;
    if (show !== null) {
      const i = spending.indexOf(show);
      if (i !== -1) {
        spending.splice(i, 1);
        show = null;
      }
    }
    // Nothing renders that the player isn't actually holding: a tile only
    // appears when a real, unclaimed letter in the rack answers for it.
    const idx = rackIndexAt.get(at);
    if (show === null || idx === undefined) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      box.appendChild(slot);
      return;
    }
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'tile' + (show === BLANK ? ' blank' : '');
    if (exchanging?.picks.includes(idx)) t.classList.add('selected');
    t.innerHTML = show === BLANK ? '★<sub>0</sub>' : `${show}<sub>${LETTER_VALUES[show]}</sub>`;
    t.dataset.letter = show;
    t.onclick = () => rackTap(show, idx);
    box.appendChild(t);
  });
  $('shuffle').hidden = !p;
}

// Where each player has arranged their letters. Kept out of the game itself:
// the engine's rack is a bag of letters, and how they are laid out in front
// of you is nobody else's business — least of all the server's.
const rackLayouts = new Map();

/**
 * This player's tray, reconciled against the rack they actually hold.
 * Letters that have left keep their slot open; letters that have arrived
 * take the first free one. Everything else stays exactly where it was put.
 */
function layoutFor(p) {
  const pool = [...p.rack];
  const prev = rackLayouts.get(p.id) ?? [];
  const next = [];
  for (let i = 0; i < RACK_MAX; i++) {
    const l = prev[i] ?? null;
    const at = l === null ? -1 : pool.indexOf(l);
    if (at === -1) {
      next.push(null);
      continue;
    }
    pool.splice(at, 1);
    next.push(l);
  }
  for (let i = 0; i < RACK_MAX && pool.length; i++) {
    if (next[i] === null) next[i] = pool.shift();
  }
  rackLayouts.set(p.id, next);
  return next;
}

function rackTap(letter, index) {
  if (suppressRackTap) return;
  if (exchanging) {
    const at = exchanging.picks.indexOf(index);
    if (at !== -1) exchanging.picks.splice(at, 1);
    else if (exchanging.picks.length < 7) exchanging.picks.push(index);
    refresh();
    return;
  }
  if (swapping) {
    status('drag this onto a letter on the board, or tap the letter to choose', '');
    return;
  }
  if (placement) {
    if (letter === BLANK) {
      pickingBlank = 'placement';
      refresh();
    } else {
      typeLetter(letter);
    }
    return;
  }
  if (selected && requirePlayer()) {
    // Start a new word from the selected tile: the cursor opens on it, and
    // spelling consumes it in place.
    placement = { cx: selected.x, cy: selected.y, dir: 'h', entries: [] };
    selected = null;
    if (letter === BLANK) {
      pickingBlank = 'placement';
      refresh();
    } else {
      typeLetter(letter);
    }
    return;
  }
  status('tap an empty cell first to start a word', '');
}

/** A tappable a–z tile grid, used for blanks and for swapping letters. */
function letterGrid(box, { available = null, onPick }) {
  const grid = document.createElement('div');
  grid.className = 'letter-grid';
  for (const l of 'abcdefghijklmnopqrstuvwxyz') {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'tile small';
    t.textContent = l;
    if (available && !available.has(l)) t.disabled = true;
    t.onclick = () => onPick(l);
    grid.appendChild(t);
  }
  box.appendChild(grid);
}

function renderActions() {
  const box = $('cell-actions');
  if (game.over) {
    box.innerHTML = '<span class="muted">The game is finished — the final table is above.</span>';
    return;
  }

  if (pickingBlank) {
    box.innerHTML = '<b>Blank tile:</b> play it as which letter? <button id="cancel-pick" class="mini">✕</button>';
    $('cancel-pick').onclick = () => {
      pickingBlank = null;
      refresh();
    };
    letterGrid(box, {
      onPick: (l) => {
        const mode = pickingBlank;
        pickingBlank = null;
        if (placement) typeLetter(l, { preferBlank: true });
      },
    });
    return;
  }

  const chooser = online()
    ? game.players[session.playerId]
    : game.players[currentPlayer]?.pendingChoice
      ? game.players[currentPlayer]
      : null;
  if (chooser?.pendingChoice) {
    box.innerHTML = `<b>${FRUIT_EMOJI.cherry} Cherry${online() ? '' : ` for ${esc(chooser.name)}`}:</b> keep one letter:
      <div id="cherry-picker" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"></div>`;
    const picker = box.querySelector('#cherry-picker');
    chooser.pendingChoice.forEach((l, index) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'tile' + (l === BLANK ? ' blank' : '');
      t.innerHTML = l === BLANK ? '★<sub>0</sub>' : `${l}<sub>${LETTER_VALUES[l]}</sub>`;
      t.onclick = () =>
        doMove(
          { type: 'choose', playerId: chooser.id, index },
          (r) =>
            r.letter
              ? `kept "${r.letter.toUpperCase()}" from the cherry ${FRUIT_EMOJI.cherry}`
              : 'your rack is full — the cherry went back in the bag',
        );
      picker.appendChild(t);
    });
    return;
  }
  if (exchanging) {
    const n = exchanging.picks.length;
    box.innerHTML = `<b>⇄ Exchange:</b> tap rack tiles to swap ${n ? `(${n} picked)` : ''}
      <div class="place-controls">
        <button id="ex-cancel" title="cancel (Esc)">✕</button>
        <button id="ex-go" class="primary" ${n ? '' : 'disabled'}>✓ swap ${n || ''}</button>
      </div>`;
    $('ex-cancel').onclick = () => {
      exchanging = null;
      refresh();
    };
    $('ex-go').onclick = () => {
      const p = game.players[currentPlayer];
      if (!p) return;
      const letters = exchanging.picks.map((i) => p.rack[i]).filter(Boolean);
      doMove(
        { type: 'exchange', letters },
        (r) => `exchanged ${r.exchanged} letter${r.exchanged === 1 ? '' : 's'} for ${r.drawn} fresh`,
      );
    };
    return;
  }
  if (swapping) {
    const p = game.players[currentPlayer];
    if (swapping.at) {
      // Picking the letter to put on one particular cell.
      const old = game.board.get(swapping.at.x, swapping.at.y);
      const was = old ? Board.effective(old).toUpperCase() : '?';
      const available = new Set();
      if (p) {
        const spent = swapping.picks.map((s) => (s.fromBlank ? BLANK : s.letter));
        const left = [...p.rack];
        for (const l of spent) {
          const i = left.indexOf(l);
          if (i !== -1) left.splice(i, 1);
        }
        const hasBlank = left.includes(BLANK);
        for (const l of 'abcdefghijklmnopqrstuvwxyz') {
          if (hasBlank || left.includes(l)) available.add(l);
        }
      }
      box.innerHTML = `<b>Swap the “${esc(was)}”</b> for which letter?
        <button id="cancel-pick-swap" class="mini">✕</button>`;
      $('cancel-pick-swap').onclick = () => {
        swapping = { ...swapping, at: null };
        refresh();
      };
      letterGrid(box, {
        available,
        onPick: (l) => {
          const rest = [...swapping.picks];
          const held = p ? [...p.rack] : [];
          for (const s of rest) {
            const i = held.indexOf(s.fromBlank ? BLANK : s.letter);
            if (i !== -1) held.splice(i, 1);
          }
          rest.push({ ...swapping.at, letter: l, fromBlank: !held.includes(l) });
          swapping = { picks: rest, at: null };
          refresh();
        },
      });
      return;
    }
    // The same letters settle two ways, so both are priced side by side and
    // the choice is made at the last moment: keep what you prise off, or
    // keep the points.
    const asSwap = previewOverwrite('swap');
    const asStack = previewOverwrite('stack');
    const list = swapping.picks
      .map((s) => {
        const old = game.board.get(s.x, s.y);
        return `${old ? Board.effective(old).toUpperCase() : '?'}→${s.letter.toUpperCase()}`;
      })
      .join(' · ');
    const n = swapping.picks.length;
    const note = !n
      ? '<span class="muted">tap a letter on the board, or drag one of yours onto it</span>'
      : asSwap?.ok || asStack?.ok
        ? `<span class="preview-ok">${(asStack?.words ?? asSwap?.words ?? []).map((w) => w.toUpperCase()).join(' & ')}</span>`
        : `<span class="preview-bad">${esc(asSwap?.message ?? asStack?.message ?? 'not a legal move')}</span>`;
    box.innerHTML = `<b>Writing over:</b> ${list || '…'} · ${note}
      <div class="muted" style="margin-top:2px">⇄ <b>swap</b> keeps the ${n === 1 ? 'letter' : 'letters'} you prise off and scores nothing · ▦ <b>stack</b> scores the words and the letters go to the bag</div>
      <div class="place-controls">
        <button id="swap-cancel">✕<span class="lbl">cancel</span></button>
        <button id="swap-undo" ${n ? '' : 'disabled'}>⌫<span class="lbl">undo</span></button>
        <button id="swap-go" ${asSwap?.ok ? '' : 'disabled'}>⇄<span class="lbl">${asSwap?.ok ? `swap ${n}` : 'swap'}</span></button>
        <button id="stack-go" class="${asStack?.points ? 'primary' : ''}" ${asStack?.ok ? '' : 'disabled'}>▦<span class="lbl">${asStack?.ok ? `stack ${asStack.points}` : 'stack'}</span></button>
      </div>`;
    $('swap-cancel').onclick = () => {
      swapping = null;
      refresh();
    };
    $('swap-undo').onclick = () => {
      swapping = { picks: swapping.picks.slice(0, -1), at: null };
      refresh();
    };
    $('swap-go').onclick = () => commitOverwrite('swap');
    $('stack-go').onclick = () => commitOverwrite('stack');
    if (asStack?.points) glint($('stack-go'), 'play');
    return;
  }
  if (placement) {
    const preview = previewMove();
    const word = preview?.words?.length
      ? preview.words[0].toUpperCase()
      : pendingReading();
    const note = !preview
      ? ''
      : preview.ok
        ? ` · <span class="preview-ok">${preview.points} pts${preview.fruit ? ' 🍒' : ''}</span>`
        : ` · <span class="preview-bad">${esc(preview.message)}</span>`;
    const started = placement.entries.length > 0;
    const overs = placement.entries.filter((e) => e.over).length;
    const wrote = overs
      ? ` · <span class="muted">over ${overs} letter${overs === 1 ? '' : 's'}</span>`
      : '';
    const heading =
      `<b>Placing:</b> ${word || `<span class="muted">tap rack tiles or type — ✓ plays it</span>`}${wrote}`;
    // Cancel sits at the far end from play: they are 6px apart on a phone.
    box.innerHTML = `${heading}${note}
      <div class="place-controls">
        <button id="pc-cancel" title="cancel (Esc)">✕<span class="lbl">cancel</span></button>
        <button id="pc-dir" title="cycle direction (Space)">${DIR_GLYPH[placement.dir]}<span class="lbl">dir</span></button>
        <button id="pc-undo" title="undo letter (Backspace)">⌫<span class="lbl">undo</span></button>
        <button id="pc-play" class="${preview?.ok || !started ? 'primary' : ''}" ${started && !preview?.ok ? 'disabled' : ''} title="play word (Enter)">✓<span class="lbl">${preview?.ok ? `play ${preview.points}` : 'play'}</span></button>
      </div>`;
    $('pc-dir').onclick = flipDirection;
    // The commit gesture, lit exactly when pressing it is the right move.
    if (preview?.ok) glint($('pc-play'), 'play');
    $('pc-undo').onclick = () => {
      const gone = placement.entries.pop();
      if (gone) moveCursor(gone.x, gone.y);
      refresh();
    };
    $('pc-cancel').onclick = () => {
      placement = null;
      refresh();
    };
    $('pc-play').onclick = commitPlacement;
    return;
  }
  if (!selected || !game.board.get(selected.x, selected.y)) {
    box.innerHTML =
      '<span class="muted">Tap an empty cell to spell a word. Drag one of your tiles onto a letter already down to swap or stack it.</span>';
    const me = game.players[currentPlayer];
    if (me) {
      const ex = document.createElement('button');
      ex.id = 'exchange-btn';
      ex.style.cssText = 'display:block;width:100%;margin-top:6px';
      ex.textContent = '⇄ Exchange letters instead of playing';
      // A rescue, never an opener: only once the rack has no vowels.
      if (!me.rack.some((l) => 'aeiou'.includes(l))) glint(ex, 'exchange');
      ex.onclick = () => {
        markUsed('exchange');
        cancelModes();
        selected = null;
        exchanging = { picks: [] };
        refresh();
      };
      box.appendChild(ex);
      const bagEmpty = game.bag.pool.length === 0;
      if (bagEmpty && !game.dayEndVote) {
        const propose = document.createElement('button');
        propose.id = 'propose-btn';
        propose.style.cssText = 'display:block;width:100%;margin-top:6px';
        propose.textContent = '🌙 Propose ending the day (2:00 to respond)';
        glint(propose, 'propose');
        propose.onclick = () =>
          markUsed('propose') ||
          doMove({ type: 'proposeEnd' }, (r) =>
            r.dayEnded ? 'the day ends — a new one begins! ★' : 'proposal sent — 2 minutes for others to respond',
          );
        box.appendChild(propose);
      }
      const pass = document.createElement('button');
      pass.id = 'pass-btn';
      pass.style.cssText = 'display:block;width:100%;margin-top:6px';
      pass.textContent = bagEmpty
        ? '⏭ Pass — the bag is empty; if everyone passes, the day ends'
        : '⏭ Pass turn';
      pass.onclick = () =>
        markUsed('pass') ||
        doMove({ type: 'pass' }, (r) =>
          r.dayEnded ? 'everyone passed — a new day begins! ★' : 'passed',
        );
      box.appendChild(pass);

      // Giving up is always available, and always asks twice.
      const quit = document.createElement('button');
      quit.id = 'forfeit-btn';
      quit.textContent = '🏳️ Forfeit — leave the game';
      quit.onclick = () => {
        const alone = game.players.length === 2;
        if (!confirm(
          alone
            ? 'Forfeit? Your letters go back in the bag and the other player wins.'
            : 'Forfeit? Your letters go back in the bag and your seat closes.',
        )) return;
        doMove({ type: 'forfeit' }, (r) => `${r.forfeited} forfeited 🏳️`);
      };
      box.appendChild(quit);
    }
    return;
  }
  box.innerHTML = '<div class="word-btns"></div>';
  const btns = box.querySelector('.word-btns');
  const mkBtn = (label, fn, hint) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    btns.appendChild(b);
    if (hint) glint(b, hint);
    return b;
  };
  for (const dir of Object.keys(DIRS)) {
    mkBtn(`Spell a word from here ${DIR_GLYPH[dir]}`, () => {
      if (!requirePlayer()) return;
      placement = { cx: selected.x, cy: selected.y, dir, entries: [] };
      selected = null;
      refresh();
    });
  }
  mkBtn('Write over this letter ⇄ ▦', () => {
    if (!requirePlayer()) return;
    markUsed('swap');
    swapping = { picks: [], at: { x: selected.x, y: selected.y } };
    selected = null;
    refresh();
  });
  mkBtn('✕ Never mind', () => {
    selected = null;
    refresh();
  });
}

/** The last five days, newest first: who played, who won, what they got. */
function renderLeaders() {
  const box = $('leader-table');
  const days = game.days ?? [];
  $('leader-section').hidden = days.length === 0;
  if (!days.length) return;
  box.innerHTML = [...days]
    .reverse()
    .map((d) => {
      const line = [...d.scores]
        .sort((a, b) => b.score - a.score)
        .map((sc) => `<span class="${sc.won ? 'won' : ''}">${esc(sc.name)}${sc.won ? ' ★' : ''} <span class="pts">${sc.score}</span></span>`)
        .join(' · ');
      return `<div class="day"><span class="n">day ${d.day}</span><span class="who">${line}</span></div>`;
    })
    .join('');
}

function renderLog() {
  $('log').innerHTML = game.log.slice(-14).reverse().map((l) => `<div>${esc(l)}</div>`).join('');
}

// Fold the setup chrome away the moment play actually starts — but only
// once, so a player who opens it back up keeps it open.
let setupFolded = false;
function foldSetupWhenPlaying() {
  const details = $('setup-details');
  const underway = game.players.length > 0 && (game.lastMove !== null || game.lastPlayerId !== null);
  document.body.classList.toggle('playing', underway); // trims the chrome too
  if (underway && !setupFolded) {
    setupFolded = true;
    details.open = false;
  } else if (!underway && setupFolded) {
    setupFolded = false; // a brand-new game: setup matters again
    details.open = true;
  }
}

/**
 * The ⚙ menu: what this table plays by. The admin's switches are the
 * admin's, "I'm busy" is nobody's but your own, and gliding the camera is a
 * preference of this browser's rather than of the game's — but they are all
 * answers to "how does this table work", so they live in one place.
 */
function renderTableRules() {
  $('fly-camera').checked = flyEnabled;
  const me = online() ? session.playerId : currentPlayer;
  // Online these belong to the admin; round one screen, whoever is holding
  // it speaks for the table.
  const runsTable = !online() || game.isAdmin(me);
  $('mode-row').hidden = !(game.players.length > 1 && runsTable);
  $('goal-row').hidden = !runsTable;
  const meP = game.players[me];
  $('away-row').hidden = !(meP && !meP.isCpu && game.players.length > 1 && game.mode === 'turns');
  $('away-me').checked = Boolean(meP?.away);
  const goalBox = $('goal-words');
  if (document.activeElement !== goalBox) goalBox.value = game.goal ?? '';
  $('restart-game').hidden = !(runsTable && (!game.board.isEmpty() || game.over));
  $('mode-turns').checked = game.mode === 'turns';
  // It used to hide itself mid-move, back when it sat in the open panel one
  // stray tap from a reset. Behind a menu you had to open, that is just a
  // button that isn't there when you go looking for it.
  $('end-day').hidden = online() || !game.players.length || Boolean(game.over);
}

function renderOnline() {
  const stat = $('online-status');
  $('setup-section').hidden = online() || pendingJoinId !== null;
  $('join-controls').hidden = !(pendingJoinId !== null && !online());
  $('online-controls').hidden = online() || pendingJoinId !== null;
  $('online-name').hidden = online();
  $('cpu-section').hidden = pendingJoinId !== null;
  renderTableRules();
  const me = online() ? session.playerId : currentPlayer;
  // Only when it is the answer: alone at the table, having already played.
  const stuck = game.players.length === 1 && game.lastPlayerId === currentPlayer;
  if (!$('cpu-section').hidden && stuck) glint($('add-cpu'), 'cpu');
  // Playing with other people and nobody knows who you are: an account is
  // what carries this game to your phone and tells you when it's your go.
  if (online() && !account.get() && game.players.length > 1) glint($('account-btn'), 'account');
  $('share').hidden = !online();
  document.body.classList.toggle(
    'no-game',
    !online() && pendingJoinId === null && game.players.length === 0,
  );
  if (online()) {
    const me = game.players[session.playerId];
    stat.textContent = `Online as ${me ? me.name : '…'} — share the link so friends can join.`;
    $('setup-summary').textContent = 'Invite, players & setup';
    $('share-link').value = shareLink();
  } else if (pendingJoinId !== null) {
    stat.textContent = 'You have been invited to an online game. Enter a name below, then join.';
  } else {
    stat.textContent = 'Hot-seat mode: everyone shares this screen.';
  }
}

/**
 * Say whose turn it is, in words. Hot-seat quietly hands the seat on after
 * every move and nobody passes the device unless they are told to.
 */
function renderTurn() {
  const el = $('turn-banner');
  const me = online() ? session.playerId : currentPlayer;
  if (!game.players.length || me == null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  // Marked busy? Then the one thing the banner is for is getting back —
  // the switch itself lives in the setup fold, which is closed mid-game.
  if (game.players[me]?.away) {
    el.className = 'waiting';
    el.innerHTML = "You're marked busy — your turns are passing themselves. ";
    const back = document.createElement('button');
    back.className = 'mini';
    back.id = 'banner-back';
    back.textContent = "I'm back 👋";
    back.onclick = () => {
      $('away-me').checked = false;
      $('away-me').dispatchEvent(new Event('change'));
    };
    el.appendChild(back);
    return;
  }
  const blocked = game.lastPlayerId === me;
  if (online()) {
    const waitingFor = game.players.find((p) => p.id !== game.lastPlayerId);
    el.className = blocked ? 'waiting' : 'yours';
    el.innerHTML = blocked
      ? `Waiting for ${esc(waitingFor?.name ?? 'the others')}…`
      : '<b>Your turn</b>';
    return;
  }
  if (blocked && game.players.length === 1) {
    el.className = 'waiting';
    el.innerHTML = 'You have played — add a friend to carry on, or ';
    const add = document.createElement('button');
    add.className = 'mini';
    add.id = 'banner-cpu';
    add.textContent = 'add a CPU 🤖';
    add.onclick = () => $('add-cpu').click();
    el.appendChild(add);
    glint(add, 'cpu');
    return;
  }
  el.className = blocked ? 'waiting' : '';
  el.innerHTML = blocked
    ? `${esc(game.players[me].name)} has played — tap another player to hand over`
    : `<b>${esc(game.players[me].name)}</b> to play${game.players.length > 1 ? ' — pass the device' : ''}`;
}

/**
 * The plaque on the board: whose go it is, large, where everyone in the
 * room is already looking. It only animates when the answer changes, so it
 * doesn't twitch on every three-second poll.
 */
let namePlated = null;
function renderNameplate() {
  const el = $('nameplate');
  const me = online() ? session.playerId : currentPlayer;
  if (!game.players.length) {
    el.hidden = true;
    namePlated = null;
    return;
  }
  const up = waitingOn(game);
  const mine = up != null && up.id === me;
  const who = up ? up.name : 'Free-for-all';
  const says = up
    ? mine
      ? 'your turn'
      : 'to play'
    : "anyone's go";
  el.hidden = false;
  el.classList.toggle('mine', mine);
  if (namePlated !== `${who}|${says}`) {
    namePlated = `${who}|${says}`;
    el.querySelector('.who').textContent = who;
    el.querySelector('.says').textContent = says;
    el.classList.remove('fresh');
    void el.offsetWidth; // restart the entrance
    el.classList.add('fresh');
  }
}

/** How far through a game with a finish line. */
function renderGoal() {
  const chip = $('goal-chip');
  const left = game.wordsLeft;
  chip.hidden = game.goal === null || Boolean(game.over);
  if (chip.hidden) return;
  chip.classList.toggle('last', left <= 3);
  chip.innerHTML = left === 1
    ? '<b>the last word</b>'
    : `word <b>${game.wordsPlayed + 1}</b> of ${game.goal}`;
}

/**
 * The end of a game: the final table, in full, and the two ways on. A new
 * day banks these scores and plays on over the same board; a new game wipes
 * it. Both are the admin's to call — everyone else is told who to wait for.
 */
function renderGameOver() {
  const el = $('game-over');
  el.hidden = !game.over;
  if (!game.over) return;
  const { winners, best, why } = game.over;
  const table = [...game.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => {
      const won = winners.includes(p.name);
      const stars = p.stars ? ` <span class="stars">★${p.stars}</span>` : '';
      return `<div class="final-row${won ? ' won' : ''}">
        <span class="place">${won ? '🏆' : `${i + 1}.`}</span>
        <span class="who">${esc(p.name)}${stars}</span>
        <span class="pts">${p.score}</span>
      </div>`;
    })
    .join('');
  const me = online() ? session.playerId : currentPlayer;
  const admin = game.players[game.adminId];
  const controls = !online() || (me != null && game.isAdmin(me))
    ? `<div class="place-controls">
         <button id="over-day">★<span class="lbl">new day</span></button>
         <button id="over-new" class="primary">↺<span class="lbl">new game</span></button>
       </div>
       <div class="muted" style="margin-top:4px">a new day keeps the board and banks these scores · a new game starts from nothing</div>`
    : `<div class="muted" style="margin-top:6px">waiting for ${esc(admin?.name ?? 'the admin')} to start the next one 👑</div>`;
  el.innerHTML = `<div class="trophy">🏆 ${
    winners.length
      ? `${winners.map(esc).join(' & ')} ${winners.length > 1 ? 'share it' : 'wins'} on ${best}`
      : 'game over'
  }</div>
    <div class="final">${why ?? ''}</div>
    <div class="final-table">${table || '<div class="final">nobody left at the table</div>'}</div>
    ${controls}`;
  const day = $('over-day');
  if (day) {
    day.onclick = () =>
      doMove({ type: 'newDay', playerId: game.adminId }, (r) =>
        r.winners.length
          ? `day won by ${r.winners.join(' & ')} ★ — day ${r.day} begins`
          : `day ${r.day} begins`,
      );
  }
  const again = $('over-new');
  if (again) again.onclick = askRestart;
}

function renderDayVote() {
  const el = $('day-vote');
  const v = game.dayEndVote;
  if (!v || !game.players.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const me = online() ? session.playerId : currentPlayer;
  const secs = Math.max(0, Math.ceil((v.expiresAt - Date.now()) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const names = v.agreed.map((id) => game.players[id]?.name ?? '?').join(', ');
  const iAgreed = me != null && v.agreed.includes(me);
  el.innerHTML = `🌙 <b>${esc(game.players[v.proposer]?.name ?? '?')}</b> proposes ending the day · ⏳ ${clock}
    <div class="muted" style="margin:2px 0">agreed: ${esc(names)}</div>
    <div class="place-controls">
      <button id="vote-no">❌ Keep playing</button>
      ${iAgreed ? '' : '<button id="vote-yes" class="primary">✅ Agree</button>'}
    </div>`;
  $('vote-no').onclick = () =>
    doMove({ type: 'voteEnd', agree: false }, () => 'the day continues — play on');
  const yes = $('vote-yes');
  if (yes) {
    yes.onclick = () =>
      doMove({ type: 'voteEnd', agree: true }, (r) =>
        r.dayEnded ? 'everyone agrees — a new day begins! ★' : 'agreed — waiting for the others',
      );
  }
}

function refresh() {
  if (game.over) noteFinish();
  else finishShown = false; // a restart puts the game back in play
  renderNameplate();
  renderGoal();
  renderGameOver();
  renderTurn();
  renderDayVote();
  renderPlayers();
  renderLeaders();
  renderRack();
  renderActions();
  renderLog();
  renderOnline();
  noteFruit();
  foldSetupWhenPlaying();
  applyGlints();
  document.body.classList.toggle('mode-exchange', Boolean(exchanging));
  document.body.classList.toggle('mode-swap', Boolean(swapping));
  canvas.classList.toggle('placing', !!placement);
  render();
}

/** On a fresh board, put the placement cursor on the ★ so typing just works. */
function autoStartPlacement() {
  if (placement || !game.board.isEmpty()) return;
  if (currentPlayer == null || !game.players[currentPlayer] || game.players[currentPlayer].isCpu) return;
  placement = { cx: game.startCell.x, cy: game.startCell.y, dir: 'h', entries: [] };
  kbCursor = { ...game.startCell };
  ensureVisible(game.startCell.x, game.startCell.y);
}

function cancelModes() {
  placement = null;
  swapping = null;
  pickingBlank = null;
  exchanging = null;
}

function requirePlayer() {
  if (currentPlayer == null || !game.players[currentPlayer]) {
    status(online() ? 'still syncing…' : 'add and select a player first', 'error');
    return false;
  }
  return true;
}

// -------------------------------------------------------- moves (both modes)
let seatedNames = null; // who was at the table last time we looked

/** Call out anyone who has arrived since the previous sync. */
function announceArrivals() {
  const names = game.players.map((p) => p.name);
  const mine = game.players[online() ? session.playerId : currentPlayer]?.name;
  if (seatedNames) {
    const fresh = names.filter((n) => !seatedNames.has(n) && n !== mine);
    if (fresh.length) {
      status(`${fresh.join(' & ')} joined the game 👋`, 'good');
      offerRestart(fresh);
    }
  }
  seatedNames = new Set(names);
}

/**
 * Somebody new has sat down at a game already in progress. Only the admin
 * is asked, and only when there is a game to abandon: starting over so the
 * newcomer isn't a hundred points behind is their call, and theirs alone.
 */
let restartOffered = false;
function offerRestart(arrivals) {
  if (restartOffered) return; // asked once; the button in setup is always there
  restartOffered = true;
  // Online, this is the admin's call. Hot-seat, everyone is round the same
  // screen and whoever is holding it can answer for the table.
  const me = online() ? session.playerId : currentPlayer;
  if (online() && !game.isAdmin(me)) return;
  if (game.board.isEmpty()) return;
  const box = $('cell-actions');
  const who = arrivals.join(' & ');
  box.innerHTML = `<b>${esc(who)} just arrived</b> — mid-game.
    <div class="muted" style="margin-top:2px">Start again from nothing so everyone is level? The opener is drawn out of the hat unless you name one.</div>
    <div id="restart-who" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"></div>
    <div class="place-controls">
      <button id="restart-no">✕<span class="lbl">carry on</span></button>
    </div>`;
  const row = $('restart-who');
  const anyone = document.createElement('button');
  anyone.className = 'mini';
  anyone.textContent = '🎲 Anyone starts';
  anyone.onclick = () => doRestart(null);
  row.appendChild(anyone);
  for (const p of game.players) {
    if (p.isCpu) continue;
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = `↺ ${p.name} starts`;
    b.onclick = () => doRestart(p.id);
    row.appendChild(b);
  }
  $('restart-no').onclick = () => {
    status('carrying on where you were', '');
    refresh();
  };
}

function doRestart(firstId) {
  const who = firstId == null
    ? 'somebody drawn out of the hat leads off'
    : `${game.players[firstId]?.name ?? 'someone'} leads off`;
  if (!confirm(`Start the whole game again? The board, the scores and the record all go, and ${who}.`)) {
    return;
  }
  // Round one screen whoever is holding it speaks for the table, so the
  // move goes out under the admin's name. Online the server ignores this
  // and uses the session's own seat, as it should.
  doMove(
    { type: 'restart', firstId, playerId: game.adminId },
    (r) => `a fresh game — ${game.players[r.first].name} leads off ✦`,
  ).then((r) => {
    // Round one screen the device has to follow the draw, or whoever
    // pressed the button is left holding a seat that cannot move.
    if (r && !online()) {
      currentPlayer = r.first;
      refresh();
    }
  });
}

function adoptView(d) {
  // A removal shifts every seat below it: the server tells me my new id.
  if (d.you != null && d.you !== session.playerId) {
    session.playerId = d.you;
    session.save();
  }
  const changed = d.seq !== seq;
  seq = d.seq;
  game = Game.fromJSON(d.game, { dictionary });
  currentPlayer = session.playerId;
  // A move landed: fly to it, and announce anyone else's.
  if (changed && game.lastMove) {
    showLastMove();
    if (game.lastMove.playerId !== session.playerId && !placement && game.log.length) {
      status(game.log[game.log.length - 1], '');
    }
  }
  if (changed && game.lastMove && game.lastMove.playerId !== session.playerId) {
    // The move came from elsewhere; the log line carries what it scored.
    const line = game.log[game.log.length - 1] ?? '';
    const scored = /\(\+(\d+)\)\s*$/.exec(line);
    if (scored) startFlourish(game.lastMove.keys, Number(scored[1]));
  }
  if (changed) announceArrivals();
  noteNewDay();
  noteTurnHere();
  rememberThisGame();
  refresh();
}

// A new day moves the ★ to clean ground, which is no use to anybody who
// can't see it: every player is taken there once, whatever their camera
// preference, and told the day has turned.
let dayShown = null;
function noteNewDay() {
  const stamp = `${game.day}:${game.dayOpenedAt ?? ''}`;
  if (dayShown === null) {
    dayShown = stamp; // the first look at a game is not a new day
    return;
  }
  if (dayShown === stamp) return;
  dayShown = stamp;
  cancelModes();
  flyToCells([Board.key(game.startCell.x, game.startCell.y)], { force: true });
  status(`day ${game.day} — the ★ has moved to open ground`, 'good');
}

// The end of a finite game, said once however the news arrives — your own
// last word, or a poll that brings somebody else's.
let finishShown = false;
function noteFinish() {
  if (!game.over || finishShown) return;
  finishShown = true;
  cancelModes();
  const { winners, best } = game.over;
  status(
    winners.length
      ? `game over — ${winners.join(' & ')} ${winners.length > 1 ? 'share it' : 'wins'} on ${best} 🏆`
      : 'game over',
    'good',
  );
  if (winners.length) celebrateFinish();
}

/**
 * Somebody has won: the board throws a party over it. Plain DOM confetti,
 * bounded and self-removing, so the canvas render loop never sees it.
 */
const CONFETTI = ['🏆', '🎉', '⭐', '🎊', '✨', '🥳'];
function celebrateFinish() {
  if (reducedMotion?.matches) return;
  const stage = $('stage');
  if (!stage) return;
  for (let i = 0; i < 30; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti';
    bit.textContent = CONFETTI[i % CONFETTI.length];
    bit.style.left = `${Math.random() * 96}%`;
    bit.style.fontSize = `${14 + Math.random() * 20}px`;
    bit.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 90}px`);
    bit.style.setProperty('--spin', `${(Math.random() * 2 - 1) * 540}deg`);
    bit.style.animationDelay = `${Math.random() * 800}ms`;
    stage.appendChild(bit);
    setTimeout(() => bit.remove(), 4500);
  }
}

/** Keep this table in the device's own list, so the games menu knows it. */
function rememberThisGame() {
  if (!online()) return;
  const me = game.players[session.playerId];
  recent.remember({
    id: session.id,
    day: game.day,
    players: game.players.map((p) => p.name),
    score: me?.score ?? 0,
    stars: me?.stars ?? 0,
    yourTurn: game.isTheirTurn(session.playerId) && game.players.length > 1,
    waitingFor: waitingOn(game)?.name ?? null,
  });
  renderGames();
}

async function doMove(move, describe) {
  if (online()) {
    try {
      const d = await session.move(move);
      cancelModes();
      selected = null;
      adoptView(d);
      if (typeof d.result?.points === 'number') startFlourish(game.lastMove?.keys, d.result.points);
      status(describe(d.result), 'good');
    } catch (err) {
      if (err instanceof NetError && err.status === 403) noteRemoved();
      else {
        showError(err);
        if (err instanceof NetError && (err.status === 409 || err.status === 404)) sync(true);
      }
    }
    return null;
  }
  try {
    const r = game.apply({ playerId: currentPlayer, ...move });
    if (r?.map) currentPlayer = r.map[currentPlayer]; // a removal renumbered the seats
    if (typeof r?.points === 'number') {
      startFlourish(game.lastMove?.keys, r.emptied ? Math.max(r.points, 50) : r.points);
    }
    if (r?.emptied) celebrateSweep();
    if (r?.finished) noteFinish();
    cancelModes();
    selected = null;
    status(describe(r), 'good');
    if (!NON_TURN_MOVES.has(move.type) && game.players.length > 1) {
      // Hand the seat to the next human; CPU seats play themselves.
      for (let i = 1; i <= game.players.length; i++) {
        const next = (currentPlayer + i) % game.players.length;
        if (!game.players[next].isCpu) {
          currentPlayer = next;
          break;
        }
      }
      setTimeout(runCpuTurns, 650);
    }
    // A skip isn't a turn taken, but it does hand the turn on: round one
    // screen the device should follow it, and a robot should answer it.
    if (move.type === 'skip' && !online() && game.turnId != null) {
      currentPlayer = game.turnId;
      setTimeout(runCpuTurns, 650);
    }
    // Marking yourself busy also hands the turn on, but the device stays
    // with you — you have just flicked a switch and may want it back.
    if (move.type === 'away' && !online()) setTimeout(runCpuTurns, 650);
    showLastMove();
    refresh();
    return r;
  } catch (err) {
    showError(err);
    return null;
  }
}

/** The move the current placement would submit, or null if incomplete. */
function currentMove() {
  if (!placement) return null;
  const tiles = placement.entries
    .filter((e) => !e.existing)
    .map((e) => ({ x: e.x, y: e.y, letter: e.letter, fromBlank: e.fromBlank }));
  if (!tiles.length) return null;
  const redefinitions = placement.entries
    .filter((e) => e.redefine)
    .map((e) => ({ x: e.x, y: e.y, as: e.redefine }));
  return { type: 'place', tiles, redefinitions };
}

/**
 * What the pending letters say, read along the line rather than in the
 * order they were put down — you can place them in any order now, and the
 * panel should show the word, not your keystrokes.
 */
function pendingReading() {
  if (!placement?.entries.length) return '';
  const [dx, dy] = DIRS[placement.dir];
  const along = (e) => (dx ? e.x : e.y);
  const across = (e) => (dx ? e.y : e.x);
  const line = [...placement.entries].sort((a, b) => along(a) - along(b));
  const rows = new Set(line.map(across));
  if (rows.size > 1) return line.map((e) => (e.redefine ?? e.letter).toUpperCase()).join(' ');
  // Fill the gaps with what is on the board, and a · where there is nothing.
  const out = [];
  for (let i = along(line[0]); i <= along(line[line.length - 1]); i++) {
    const x = dx ? i : line[0].x;
    const y = dx ? line[0].y : i;
    const mine = placement.entries.find((e) => e.x === x && e.y === y);
    const board = game.board.get(x, y);
    out.push(mine ? (mine.redefine ?? mine.letter).toUpperCase() : board ? Board.effective(board).toUpperCase() : '·');
  }
  return out.join('');
}

// The previews below clone the whole game and replay the pending move on
// the copy, which is honest but not free — and refresh() asks for them far
// more often than they change: every poll, every pan mid-placement, every
// panel redraw. So each is memoized against a signature of the only things
// that can change its answer: the pending move itself and the game it
// would land on (any applied move grows the log or moves lastPlayerId).
// A small map, not one slot: the write-over panel prices the same picks as
// a swap and as a stack in the same breath, and they must not evict each
// other.
const previewMemo = new Map();
function memoPreview(kind, pendingSig, compute) {
  const sig = `${kind}|${currentPlayer}|${seq}|${game.log.length}|${game.lastPlayerId}|${pendingSig}`;
  if (!previewMemo.has(sig)) {
    if (previewMemo.size > 8) previewMemo.clear();
    previewMemo.set(sig, compute());
  }
  return previewMemo.get(sig);
}

/** Dry-run the pending move on a throwaway copy for live score feedback. */
function previewMove() {
  const move = currentMove();
  if (move == null || currentPlayer == null) return null;
  if (!dictionary.ready) return { ok: false, message: 'unpacking the word list…' };
  return memoPreview('place', JSON.stringify(move), () => {
    try {
      const clone = Game.fromJSON(game.toJSON(), { dictionary });
      const r = clone.apply({ playerId: currentPlayer, ...move });
      return { ok: true, points: r.points, words: r.words, fruit: r.fruits?.length > 0 };
    } catch (err) {
      if (err instanceof GameError) return { ok: false, message: err.message };
      console.error(err);
      return null;
    }
  });
}

/**
 * Dry-run the pending picks as one move or the other, so the panel can
 * price both while they build. The two are equally legal — they differ only
 * in what you walk away with.
 */
function previewOverwrite(kind) {
  if (currentPlayer == null || !swapping?.picks.length) return null;
  if (!dictionary.ready) return { ok: false, message: 'unpacking the word list…' };
  return memoPreview(kind, JSON.stringify(swapping.picks), () => {
    try {
      const clone = Game.fromJSON(game.toJSON(), { dictionary });
      const r = kind === 'swap'
        ? clone.swap({ playerId: currentPlayer, swaps: swapping.picks })
        : clone.stack({ playerId: currentPlayer, stacks: swapping.picks });
      return { ok: true, points: r.points, words: r.words };
    } catch (err) {
      if (err instanceof GameError) return { ok: false, message: err.message };
      console.error(err);
      return null;
    }
  });
}

const gotName = (l) => (l === BLANK ? 'wildcard' : l.toUpperCase());

function commitOverwrite(kind) {
  if (!swapping?.picks.length) return;
  markUsed('swap');
  if (kind === 'swap') {
    doMove(
      { type: 'swap', swaps: swapping.picks },
      (r) =>
        `swapped ${r.took.length} letter${r.took.length === 1 ? '' : 's'} into ` +
        `${r.words.map((w) => w.toUpperCase()).join(' & ')} — took ${r.took.map(gotName).join(', ')}`,
    );
    return;
  }
  doMove(
    { type: 'stack', stacks: swapping.picks },
    (r) =>
      `stacked ${r.words.map((w) => w.toUpperCase()).join(' & ')} for ${r.points}` +
      `${r.repeats?.length ? ` (${r.repeats.map((w) => w.toUpperCase()).join(', ')} already scored today)` : ''}` +
      ` — ${r.gave.map(gotName).join(', ')} went to the bag${fruitNote(r)}`,
  );
}

function commitPlacement() {
  const move = currentMove();
  if (!move) {
    status(
      'add at least one new letter',
      'error',
    );
    return;
  }
  if (placement) lastDir = placement.dir; // a played direction
  markUsed('play');
  doMove(
    move,
    (r) =>
      `played ${r.words.map((w) => w.toUpperCase()).join(', ')} for ${r.points} points` +
      `${r.emptied ? ' — the whole tray, doubled!' : ''}${fruitNote(r)}`,
  );
}

function fruitNote(r) {
  return r.fruits?.length ? ` — ate ${r.fruits.map((f) => FRUIT_EMOJI[f]).join(' ')}` : '';
}

function runCpuTurns() {
  if (online()) return;
  // A robot can't weigh words it doesn't have yet; it gets its turn on the
  // next nudge after the list lands (every move retries the robots).
  if (!dictionary.ready) return;
  cpuWordList ??= buildWordList(dictionary);
  let acted = false;
  let lastPoints = null;
  for (const p of game.players) {
    if (!p.isCpu) continue;
    if (!game.isTheirTurn(p.id)) continue;
    const r = takeCpuTurn(game, p.id, cpuWordList);
    if (r) {
      acted = true;
      if (typeof r.points === 'number') lastPoints = r.points;
      status(
        r.passed
          ? `${p.name} passed${r.dayEnded ? ' — everyone passed, a new day begins! ★' : ''}`
          : r.exchanged
            ? `${p.name} exchanged ${r.exchanged} letters`
            : `${p.name} played ${r.words.map((w) => w.toUpperCase()).join(', ')} for ${r.points} points${fruitNote(r)}`,
        '',
      );
    }
  }
  if (acted) {
    showLastMove();
    if (lastPoints != null) startFlourish(game.lastMove?.keys, lastPoints);
    refresh();
  }
}

function showError(err) {
  if (err instanceof GameError || err instanceof NetError) status(err.message, 'error');
  else {
    console.error(err);
    status(String(err.message ?? err), 'error');
  }
}

// ------------------------------------------------------------- online setup
const params = new URLSearchParams(location.search);
let pendingJoinId = params.get('g');

function shareLink() {
  return `${location.origin}${location.pathname}?g=${session.id}`;
}

let polling = false;
let removed = false; // this seat was taken out of the game; stop polling

/** A token only stops working when the admin removes that seat. */
function noteRemoved() {
  removed = true;
  status('you are no longer in this game — the admin removed your seat', 'error');
  refresh();
}
async function sync(force = false) {
  if (!online() || polling || removed) return;
  polling = true;
  try {
    const d = await session.state(force ? undefined : seq);
    if (!d.unchanged) adoptView(d);
  } catch (err) {
    if (err instanceof NetError && err.status === 403) {
      noteRemoved();
    } else if (err instanceof NetError && err.status === 404) {
      status('this game has expired', 'error');
    }
  } finally {
    polling = false;
  }
}
setInterval(() => sync(), 3000);

// Tick the day-end countdown; when it expires, the engine (or server on the
// next poll) resolves it.
setInterval(() => {
  if (!game.dayEndVote) return;
  if (Date.now() >= game.dayEndVote.expiresAt) {
    if (online()) sync(true);
    else if (game.tickClock()) {
      status('nobody objected — a new day begins! ★', 'good');
      refresh();
      return;
    }
  }
  renderDayVote();
}, 1000);

// The idle clocks are only interesting because they grow; a slow tick keeps
// them honest between moves without redrawing the panel every second.
setInterval(() => {
  if (game.players.length > 1 && !game.over) renderPlayers();
}, 20_000);

function askName() {
  // Signed in? Then you have already said who you are.
  const typed = ($('online-name').value || $('player-name').value).trim() || account.get()?.name;
  if (!typed) {
    status('enter your name first', 'error');
    $('online-name').focus();
    return null;
  }
  rememberName(typed);
  return typed;
}

async function goOnline(result) {
  session = result.session;
  pendingJoinId = null;
  history.replaceState(null, '', shareLink());
  adoptView(result.view);
  autoStartPlacement();
  refresh();
  showPanelTop();
  status('online game ready — share the link!', 'good');
  renderAccount();
}

$('create-online').addEventListener('click', async () => {
  const name = askName();
  if (!name) return;
  try {
    await goOnline(await Online.create(name));
  } catch (err) {
    if (err instanceof NetError && err.status === 501) {
      status('online play is not set up on this deployment yet', 'error');
    } else showError(err);
  }
});

$('join-online').addEventListener('click', async () => {
  const name = askName();
  if (!name) return;
  try {
    await goOnline(await Online.join(pendingJoinId, name));
  } catch (err) {
    showError(err);
    // Most likely the name is taken — leave it selected for a quick retype.
    $('online-name').select();
  }
});

// The world is 448 cells wide; you can pan until nothing is familiar.
$('recentre').addEventListener('click', () => {
  cancelFlight();
  flyToCells(game.lastMove?.keys ?? [Board.key(game.startCell.x, game.startCell.y)], { force: true });
});
const zoomBy = (k) => {
  cancelFlight();
  const mx = canvas.clientWidth / 2;
  const my = canvas.clientHeight / 2;
  const s2 = Math.min(80, Math.max(20, cam.cell * k));
  const ratio = s2 / cam.cell;
  cam.x = (cam.x + mx) * ratio - mx;
  cam.y = (cam.y + my) * ratio - my;
  cam.cell = s2;
  requestRender();
};
$('zoom-in').addEventListener('click', () => zoomBy(1.2));
$('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));

$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('share-link').value);
    status('link copied — send it to your friends', 'good');
  } catch {
    $('share-link').select();
    status('copy the selected link', '');
  }
});

// Resume a saved online session for this game id.
if (pendingJoinId) {
  const saved = Online.saved(pendingJoinId);
  if (saved) {
    session = saved;
    pendingJoinId = null;
    sync(true);
  } else if (account.token()) {
    // Signed in and already at this table? Sit back down rather than
    // asking a returning player to join their own game.
    try {
      await goOnline(await Online.adopt(pendingJoinId));
    } catch {
      // Not a game of yours: the join form is the right answer after all.
    }
  }
}

// -------------------------------------------------------------------- input
const pointers = new Map();
let drag = null;
let pinch = null;

canvas.addEventListener('pointerdown', (e) => {
  cancelFlight(); // touching the board takes the camera back
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { px: e.clientX, py: e.clientY, moved: false };
    pinch = null;
  } else if (pointers.size === 2) {
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cell: cam.cell };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const rect = canvas.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - rect.left;
    const my = (a.y + b.y) / 2 - rect.top;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const s2 = Math.min(80, Math.max(20, (pinch.cell * dist) / pinch.dist));
    const k = s2 / cam.cell;
    cam.x = (cam.x + mx) * k - mx;
    cam.y = (cam.y + my) * k - my;
    cam.cell = s2;
    requestRender();
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.px;
  const dy = e.clientY - drag.py;
  if (Math.abs(dx) + Math.abs(dy) > 10) drag.moved = true;
  if (drag.moved) {
    cam.x -= dx;
    cam.y -= dy;
    drag.px = e.clientX;
    drag.py = e.clientY;
    requestRender();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!drag) return;
  const wasTap = !drag.moved;
  drag = null;
  if (!wasTap || pointers.size > 0) return;
  const rect = canvas.getBoundingClientRect();
  tapCell(cellAt(e.clientX - rect.left, e.clientY - rect.top));
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  drag = null;
});

function tapCell({ x, y }) {
  kbCursor = { x, y };
  // Mid-swap, a tap on the board is another letter to trade — or a change
  // of mind about one already chosen.
  if (swapping) {
    const already = swapping.picks.findIndex((s) => s.x === x && s.y === y);
    if (already !== -1) {
      swapping = { picks: swapping.picks.filter((_, i) => i !== already), at: null };
    } else if (game.board.get(x, y)) {
      swapping = { ...swapping, at: { x, y } };
    } else {
      status('swaps are for letters already on the board', '');
    }
    refresh();
    return;
  }
  // Mid-word, the board is a canvas: tap one of your own pending letters to
  // take it back, or any other cell to move the cursor there. Letters
  // already placed stay exactly where they were put.
  if (placement) {
    const mine = pendingAt(x, y);
    if (mine) {
      placement.entries = placement.entries.filter((e) => e !== mine);
      moveCursor(x, y);
      refresh();
      return;
    }
    if (!game.board.get(x, y) || placement.entries.length) {
      moveCursor(x, y);
      refresh();
      return;
    }
  }
  cancelModes();
  if (game.board.get(x, y)) {
    selected = { x, y };
  } else {
    selected = null;
    if (requirePlayer()) placement = startPlacement(x, y);
  }
  refresh();
}

/** Start spelling on an empty cell, guessing the direction from the board. */
function startPlacement(x, y) {
  const rack = game.players[currentPlayer]?.rack ?? [];
  const dir = feasibleDirection(game.board, x, y, { rack, dictionary, lastDir });
  return { cx: x, cy: y, dir, entries: [] };
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    cancelFlight();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const s2 = Math.min(80, Math.max(20, cam.cell * (e.deltaY > 0 ? 0.9 : 1.1)));
    const k = s2 / cam.cell;
    cam.x = (cam.x + px) * k - px;
    cam.y = (cam.y + py) * k - py;
    cam.cell = s2;
    requestRender();
  },
  { passive: false },
);

const ARROWS = {
  arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1],
};

// ------------------------------------------------------------ word flourish
// A word that lands does something about it, the bigger the score the more.
// Like the arrival sparkle, it runs on a loop that stops the moment the
// movement is over.
let flourishing = null; // { keys: Map<key, index>, kind, at }
let flourishLoop = null;

/** Set a word dancing. Called when a move lands, with what it scored. */
function startFlourish(keys, points) {
  if (reducedMotion?.matches || !keys?.length) return;
  const ordered = new Map();
  [...keys].sort().forEach((k, i) => ordered.set(k, i));
  flourishing = { keys: ordered, kind: flourishFor(points), at: performance.now() };
  if (flourishLoop !== null) return;
  const step = () => {
    if (!flourishing || performance.now() - flourishing.at > FLOURISH_MS) {
      flourishing = null;
      flourishLoop = null;
      render();
      return;
    }
    render();
    flourishLoop = requestAnimationFrame(step);
  };
  flourishLoop = requestAnimationFrame(step);
}

/** The transform for the tile at (x, y), or null if it is sitting still. */
function flourish(x, y) {
  if (!flourishing) return null;
  const i = flourishing.keys.get(Board.key(x, y));
  if (i === undefined) return null;
  const u = (performance.now() - flourishing.at) / FLOURISH_MS;
  if (u >= 1) return null;
  return flourishAt(flourishing.kind, u, i, cam.cell);
}

// ------------------------------------------------------------ fruit arrival
// A fruit appearing is a moment worth pointing at, so each one gets a brief
// flourish. The loop runs only while something is arriving — the board is
// otherwise redrawn on interaction alone, and a permanent frame loop is a
// poor trade for a turn-based game.
const SPAWN_MS = 700;
const spawnedAt = new Map(); // fruit key -> when we first saw it
let spawnLoop = null;

/** How far through its arrival a fruit is, or null once it has settled. */
function spawnPhase(key) {
  const at = spawnedAt.get(key);
  if (at === undefined) return null;
  const u = (performance.now() - at) / SPAWN_MS;
  return u >= 1 ? null : u;
}

/** Note new fruit since the last look, and start the flourish if any. */
function noteFruit() {
  const now = performance.now();
  let arriving = false;
  for (const key of game.fruits.keys()) {
    if (!spawnedAt.has(key)) {
      // Don't flourish the whole opening scatter, only later arrivals.
      spawnedAt.set(key, seenBoardOnce ? now : now - SPAWN_MS);
    }
    if (now - spawnedAt.get(key) < SPAWN_MS) arriving = true;
  }
  for (const key of [...spawnedAt.keys()]) {
    if (!game.fruits.has(key)) spawnedAt.delete(key);
  }
  seenBoardOnce = true;
  if (arriving && spawnLoop === null && !reducedMotion?.matches) {
    const step = () => {
      render();
      const busy = [...game.fruits.keys()].some((k) => spawnPhase(k) !== null);
      spawnLoop = busy ? requestAnimationFrame(step) : null;
    };
    spawnLoop = requestAnimationFrame(step);
  }
}
let seenBoardOnce = false;

// -------------------------------------------------------------- fruit antics
// Fruit that never move are scenery. Fruit that all bob together are a
// screensaver. So one at a time, every few seconds, a single fruit does one
// cheeky thing — a shimmy, a hop, a roll, a squash — and then sits still
// again. The frame loop runs for the second or so it takes and stops.
const ANTIC_MS = 820;
const ANTIC_KINDS = ['shimmy', 'hop', 'roll', 'squash', 'peek'];
const ANTIC_GAP = [1800, 5200]; // ms between one fruit's turn and the next
let antic = null; // { key, kind, at }
let anticLoop = null;
let anticTimer = null;

const anticRand = (a, b) => a + Math.random() * (b - a);

/** Is any wrapped copy of world column/row `v` inside the visible span? */
const spanHas = (v, a, b) => a + (((v - a) % WORLD) + WORLD) % WORLD <= b;

/** Fruit currently on screen — the only ones worth animating. */
function fruitsInView() {
  const s = cam.cell;
  const x0 = Math.floor(cam.x / s) - 1;
  const x1 = Math.ceil((cam.x + canvas.clientWidth) / s) + 1;
  const y0 = Math.floor(cam.y / s) - 1;
  const y1 = Math.ceil((cam.y + canvas.clientHeight) / s) + 1;
  return [...game.fruits.keys()].filter((k) => {
    const [fx, fy] = k.split(',').map(Number);
    return spanHas(fx, x0, x1) && spanHas(fy, y0, y1);
  });
}

function scheduleAntic() {
  clearTimeout(anticTimer);
  if (reducedMotion?.matches) return;
  anticTimer = setTimeout(() => {
    const candidates = document.hidden ? [] : fruitsInView();
    if (candidates.length) {
      antic = {
        key: candidates[Math.floor(Math.random() * candidates.length)],
        kind: ANTIC_KINDS[Math.floor(Math.random() * ANTIC_KINDS.length)],
        at: performance.now(),
      };
      if (anticLoop === null) {
        const step = () => {
          render();
          if (antic && performance.now() - antic.at < ANTIC_MS) {
            anticLoop = requestAnimationFrame(step);
          } else {
            antic = null;
            anticLoop = null;
            render();
          }
        };
        anticLoop = requestAnimationFrame(step);
      }
    }
    scheduleAntic();
  }, anticRand(...ANTIC_GAP));
}

/** What this fruit is up to right now, if anything. */
function anticAt(key) {
  if (!antic || antic.key !== key) return null;
  const u = (performance.now() - antic.at) / ANTIC_MS;
  if (u >= 1) return null;
  // Everything fades in and out, so nothing starts or stops with a jolt.
  const ease = Math.sin(Math.PI * Math.min(1, u * 1.02)) ** 0.7;
  const TAU = Math.PI * 2;
  switch (antic.kind) {
    case 'shimmy':
      return { dx: Math.sin(u * TAU * 4) * 0.22 * ease, dy: 0, rot: 0, sx: 1, sy: 1 };
    case 'hop': {
      const n = Math.abs(Math.sin(u * Math.PI * 2.5));
      return { dx: 0, dy: -n * 0.42 * ease, rot: Math.sin(u * TAU * 2) * 0.12 * ease, sx: 1, sy: 1 };
    }
    case 'roll':
      return { dx: Math.sin(u * TAU) * 0.3 * ease, dy: 0, rot: Math.sin(u * TAU) * 0.9 * ease, sx: 1, sy: 1 };
    case 'squash': {
      const s = Math.sin(u * Math.PI * 3) * 0.2 * ease;
      return { dx: 0, dy: s * 0.4, rot: 0, sx: 1 + s, sy: 1 - s };
    }
    default: { // peek: a quick lean out and back, like it heard its name
      const n = Math.sin(u * Math.PI) * ease;
      return { dx: n * 0.34, dy: -n * 0.1, rot: n * 0.4, sx: 1, sy: 1 };
    }
  }
}

/**
 * Laying out the whole tray in one word is the best thing that can happen
 * to you in an afternoon, so the board says so: a burst of light off the
 * word, and a line that stays up.
 */
function celebrateSweep() {
  status('the whole tray, in one word — doubled! 🎉', 'good');
  if (reducedMotion?.matches) return;
  const el = $('nameplate');
  el.classList.remove('sweep');
  void el.offsetWidth;
  el.classList.add('sweep');
  setTimeout(() => el.classList.remove('sweep'), 1600);
}

// ------------------------------------------------------------ camera flight
const FLY_MS = 500;
// Chasing the camera around is disorienting, so it stays put unless asked.
// ⌖ always works, whatever this is set to.
let flyEnabled = (() => {
  try {
    return localStorage.getItem('wordser:fly') === '1';
  } catch {
    return false;
  }
})();
function setFly(on) {
  flyEnabled = on;
  try {
    localStorage.setItem('wordser:fly', on ? '1' : '0');
  } catch {}
  if (!on) cancelFlight();
}
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let flight = null; // { fromX, fromY, toX, toY, t0 }

/** Stop any camera flight — the moment you touch the view, it's yours. */
function cancelFlight() {
  flight = null;
}

/**
 * The world wraps, so a cell has a copy every WORLD cells in each
 * direction. Pick the one nearest the point we're looking at, so the
 * camera takes the short way round the seam instead of crossing the world.
 */
function nearestCopy(v, to, span) {
  let best = v;
  for (const k of [-1, 0, 1]) {
    const c = v + k * span;
    if (Math.abs(c - to) < Math.abs(best - to)) best = c;
  }
  return best;
}

/**
 * Glide the camera until the cells of the move just played sit in the
 * middle of the view. Already comfortably on screen? Then stay put —
 * nothing is more annoying than the board sliding under your own move.
 */
function flyToCells(keys, { force = false } = {}) {
  if (!keys?.length || !canvas.clientWidth) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const span = WORLD * cam.cell;
  const viewX = cam.x + w / 2;
  const viewY = cam.y + h / 2;

  // Unwrap the word around its first cell, then centre its bounding box.
  const [x0, y0] = keys[0].split(',').map(Number);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const k of keys) {
    const [x, y] = k.split(',').map(Number);
    const px = nearestCopy(x * cam.cell + cam.cell / 2, x0 * cam.cell + cam.cell / 2, span);
    const py = nearestCopy(y * cam.cell + cam.cell / 2, y0 * cam.cell + cam.cell / 2, span);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const cx = nearestCopy((minX + maxX) / 2, viewX, span);
  const cy = nearestCopy((minY + maxY) / 2, viewY, span);
  const halfW = (maxX - minX) / 2;
  const halfH = (maxY - minY) / 2;

  // Comfortably visible = the whole word, plus a cell of breathing room.
  const m = cam.cell;
  const onScreen =
    cx - halfW - m > cam.x && cx + halfW + m < cam.x + w &&
    cy - halfH - m > cam.y && cy + halfH + m < cam.y + h;
  if (onScreen && !force) return;

  const toX = cx - w / 2;
  const toY = cy - h / 2;
  if (reducedMotion?.matches) {
    cam.x = toX;
    cam.y = toY;
    render();
    return;
  }
  flight = { fromX: cam.x, fromY: cam.y, toX, toY, t0: performance.now() };
  requestAnimationFrame(stepFlight);
}

function stepFlight(now) {
  if (!flight) return;
  const t = Math.min(1, (now - flight.t0) / FLY_MS);
  const e = 1 - (1 - t) ** 3; // ease out: quick away, gentle arrival
  cam.x = flight.fromX + (flight.toX - flight.fromX) * e;
  cam.y = flight.fromY + (flight.toY - flight.fromY) * e;
  render();
  if (t < 1) requestAnimationFrame(stepFlight);
  else flight = null;
}

// The whole of the last word played or altered, not just the cells that
// changed — you want to see what the move said, and it stays lit while you
// compose your reply.
let lastWordCache = { move: null, keys: null };
function lastWordKeys() {
  const move = game.lastMove;
  if (!move?.keys?.length) return null;
  if (lastWordCache.move === move) return lastWordCache.keys;
  const keys = new Set();
  for (const k of move.keys) {
    const [x, y] = k.split(',').map(Number);
    keys.add(Board.key(x, y));
    for (const dir of Object.keys(DIRS)) {
      const w = game.board.wordThrough(x, y, dir);
      if (w && w.cells.length >= 2) {
        for (const c of w.cells) keys.add(Board.key(c.x, c.y));
      }
    }
  }
  lastWordCache = { move, keys };
  return keys;
}

/** Fly to whatever was played last, wherever it came from. */
function showLastMove() {
  if (placement || swapping || exchanging) return; // mid-move: don't move the view
  if (!flyEnabled) return; // off by default: the board stays where you put it
  flyToCells(game.lastMove?.keys);
}

/** Pan the camera the minimum needed to keep hex (x, y) comfortably visible. */
function ensureVisible(x, y) {
  cancelFlight();
  const [cx, cy] = hexCenter(x, y);
  const m = cam.cell * 2;
  if (cx < m) cam.x += cx - m;
  if (cx > canvas.clientWidth - m) cam.x += cx - (canvas.clientWidth - m);
  if (cy < m) cam.y += cy - m;
  if (cy > canvas.clientHeight - m) cam.y += cy - (canvas.clientHeight - m);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();
  const arrow = ARROWS[key];

  if (pickingBlank && e.key === 'Escape') {
    pickingBlank = null;
    refresh();
    return;
  }

  if (exchanging && e.key === 'Escape') {
    exchanging = null;
    refresh();
    return;
  }

  if (swapping) {
    if (e.key === 'Escape') {
      swapping = null;
      pickingBlank = null;
      refresh();
    } else if (/^[a-z]$/.test(key) && swapping.at) {
      // Typing names the letter for the cell you just tapped.
      const p = game.players[currentPlayer];
      const held = p ? [...p.rack] : [];
      for (const sw of swapping.picks) {
        const i = held.indexOf(sw.fromBlank ? BLANK : sw.letter);
        if (i !== -1) held.splice(i, 1);
      }
      swapping = {
        picks: [...swapping.picks, { ...swapping.at, letter: key, fromBlank: !held.includes(key) }],
        at: null,
      };
      refresh();
    } else if (e.key === 'Enter') {
      commitSwap();
    } else if (e.key === 'Backspace' && swapping.picks.length) {
      swapping = { picks: swapping.picks.slice(0, -1), at: null };
      refresh();
    }
    return;
  }

  // Nothing in progress but a tile is selected: Escape clears the menu.
  if (selected && e.key === 'Escape') {
    selected = null;
    refresh();
    return;
  }

  if (placement) {
    if (arrow) {
      // Move the cursor; the letters already down stay put.
      e.preventDefault();
      moveCursor(placement.cx + arrow[0], placement.cy + arrow[1]);
      refresh();
    } else if (e.key === 'Escape') {
      placement = null;
      refresh();
    } else if (e.key === 'Enter') {
      commitPlacement();
    } else if (e.key === 'Backspace') {
      const gone = placement.entries.pop();
      if (gone) moveCursor(gone.x, gone.y);
      refresh();
    } else if (e.key === ' ') {
      e.preventDefault();
      flipDirection();
    } else if (/^[a-z]$/.test(key)) {
      typeLetter(key);
      const cur = nextCell();
      ensureVisible(cur.x, cur.y);
      render();
    }
    return;
  }

  // No placement: the arrow keys drive a board cursor and the view follows.
  if (arrow) {
    e.preventDefault();
    if (!kbCursor) {
      kbCursor = cellAt(canvas.clientWidth / 2, canvas.clientHeight / 2);
    } else {
      kbCursor.x += arrow[0];
      kbCursor.y += arrow[1];
    }
    ensureVisible(kbCursor.x, kbCursor.y);
    render();
  } else if (e.key === 'Enter' && kbCursor) {
    if (game.board.get(kbCursor.x, kbCursor.y)) {
      selected = { ...kbCursor };
      refresh();
    }
  } else if (/^[a-z]$/.test(key) && kbCursor) {
    // Works on occupied cells too: spelling consumes the tiles it crosses,
    // so you can build a word straight off an existing letter.
    if (requirePlayer()) {
      selected = null;
      placement = game.board.get(kbCursor.x, kbCursor.y)
        ? { sx: kbCursor.x, sy: kbCursor.y, dir: lastDir, entries: [] }
        : startPlacement(kbCursor.x, kbCursor.y);
      typeLetter(key);
    }
  } else if (key === '+' || key === '=' || key === '-') {
    cancelFlight();
    const mx = canvas.clientWidth / 2;
    const my = canvas.clientHeight / 2;
    const s2 = Math.min(80, Math.max(20, cam.cell * (key === '-' ? 0.9 : 1.1)));
    const k = s2 / cam.cell;
    cam.x = (cam.x + mx) * k - mx;
    cam.y = (cam.y + my) * k - my;
    cam.cell = s2;
    requestRender();
  }
});

function flipDirection() {
  if (!placement) return;
  lastDir = NEXT_DIR[placement.dir]; // an explicit choice, worth remembering
  placement.dir = lastDir;
  refresh();
}

/**
 * Spell the next letter of the word being placed. A letter already on the
 * board that says the same thing is reused and costs nothing; a wildcard is
 * redefined; anything else is written over, which spends a tile and posts
 * the old letter back to the bag. HU_A_ turns MEN into HUMAN.
 */
function typeLetter(letter, { preferBlank = false, silent = false, at = null } = {}) {
  const p = game.players[currentPlayer];
  if (!p) return false;
  const cell = at ?? landingCell();
  const sitting = game.board.get(cell.x, cell.y);
  const clearCell = () => {
    placement.entries = placement.entries.filter((e) => !(e.x === cell.x && e.y === cell.y));
  };

  if (sitting && !sitting.isBlank && Board.effective(sitting) === letter) {
    // Already down, and already right: the word takes it as it stands.
    clearCell();
    placement.entries.push({ ...cell, letter, typed: letter, existing: true });
  } else if (sitting?.isBlank && !pendingAt(cell.x, cell.y)) {
    // A wildcard can simply be told to stand for this letter.
    clearCell();
    placement.entries.push({ ...cell, letter, typed: letter, existing: true, redefine: letter });
  } else {
    // What is left in hand, once the letters already out on the board are
    // taken off it.
    const avail = [...p.rack];
    for (const e of placement.entries) {
      if (e.existing) continue;
      const i = avail.indexOf(e.fromBlank ? BLANK : e.letter);
      if (i !== -1) avail.splice(i, 1);
    }
    // Dropping onto a cell you have already used replaces what was there.
    const already = pendingAt(cell.x, cell.y);
    if (already && !already.existing) avail.push(already.fromBlank ? BLANK : already.letter);
    // Writing over somebody's letter: the old one is noted for the panel.
    const over = sitting ? Board.effective(sitting) : null;

    let entry = null;
    if (!preferBlank && avail.includes(letter)) {
      entry = { ...cell, letter, typed: letter, existing: false, over };
    } else if (avail.includes(BLANK)) {
      entry = { ...cell, letter, typed: letter, existing: false, fromBlank: true, over };
    } else if (avail.includes(letter)) {
      entry = { ...cell, letter, typed: letter, existing: false, over };
    } else {
      if (!silent) status(`no "${letter.toUpperCase()}" (or blank) left in your rack`, 'error');
      return false;
    }
    if (already) placement.entries = placement.entries.filter((e) => e !== already);
    placement.entries.push(entry);
  }

  // The cursor walks on along the line, so typing a word still just works.
  const [dx, dy] = DIRS[placement.dir];
  placement.cx = cell.x + dx;
  placement.cy = cell.y + dy;
  if (!silent) {
    status('');
    ensureVisible(placement.cx, placement.cy);
    refresh();
  }
  return true;
}

// ------------------------------------------------------------------ chrome
$('add-player-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (online()) return;
  const name = $('player-name').value.trim();
  if (!name) return;
  if (game.nameTaken(name)) {
    status(`${name} is already playing — pick another name`, 'error');
    $('player-name').select();
    return;
  }
  rememberName(name);
  const wasPlaying = !game.board.isEmpty();
  const p = game.addPlayer(name);
  seatedNames = null; // local seats announce themselves below
  $('player-name').value = '';
  if (currentPlayer == null) currentPlayer = p.id;
  autoStartPlacement();
  status(`${p.name} joined the game 👋 — dealt ${p.rack.length} tiles`, 'good');
  refresh();
  if (wasPlaying) offerRestart([p.name]);
  showPanelTop();
});

$('add-cpu').addEventListener('click', async () => {
  markUsed('cpu');
  if (online()) {
    try {
      const d = await session.addCpu();
      adoptView(d);
      status('a CPU player joined 🤖', 'good');
    } catch (err) {
      showError(err);
    }
    return;
  }
  const p = game.addCpu();
  if (currentPlayer == null) currentPlayer = p.id;
  status(`${p.name} joined the game 👋 — it plays whenever it may`, 'good');
  if (game.players.length > 1) setTimeout(runCpuTurns, 400);
  refresh();
  showPanelTop();
});

// ------------------------------------------------------------ dragging tiles
//
// A tile lifts off the tray under a floating ghost, which is free of the
// panel's scroll box and can therefore be carried anywhere: onto another
// slot (the two trade places — slots are addresses, they don't shuffle
// along), or onto the board, where it starts or continues a word.
let rackDrag = null;
let suppressRackTap = false;
let dropCell = null; // board cell the carried tile would land on
const rackBox = $('rack');
const RACK_SLIDE_MS = 160;
const stillMotion = () => reducedMotion?.matches;

/** Where every tile currently sits, so it can be animated from there. */
const rackRects = () => [...rackBox.children].map((el) => el.getBoundingClientRect());

/**
 * Slide tiles from where they were to where they are now (FLIP): show the
 * old position, then let the browser ease each one home.
 */
function slideRack(before, { skip = null, sourceOf = (i) => i } = {}) {
  if (stillMotion()) return;
  [...rackBox.children].forEach((el, i) => {
    const from = before[sourceOf(i)];
    if (!from || el === skip) return;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = `transform ${RACK_SLIDE_MS}ms ease`;
      el.style.transform = '';
    });
  });
}

/**
 * Which slot the pointer is over, or null once it has left the tray. The
 * nearest slot wins so the 6px gutters between them aren't dead ground.
 */
function slotUnder(x, y) {
  const box = rackBox.getBoundingClientRect();
  const pad = 8;
  if (x < box.left - pad || x > box.right + pad) return null;
  if (y < box.top - pad || y > box.bottom + pad) return null;
  let best = null;
  let bestD = Infinity;
  [...rackBox.children].forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The board cell under the pointer, or null when it isn't over the board. */
function boardCellUnder(x, y) {
  const r = canvas.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  return cellAt(x - r.left, y - r.top);
}

/** Two slots trade contents. Nothing else in the tray moves. */
function swapInLayout(p, a, b) {
  const layout = rackLayouts.get(p.id);
  if (!layout || a === b) return;
  [layout[a], layout[b]] = [layout[b], layout[a]];
}

/**
 * A tile landing on a letter already down. It joins the pile you are
 * writing over this turn, which commits as either a swap or a stack — the
 * panel prices both. Dropping on a cell you have already picked replaces
 * that pick rather than refusing it.
 */
function pickOverwrite(letter, cell) {
  const picks = swapping?.picks ?? [];
  const at = picks.findIndex((s) => s.x === cell.x && s.y === cell.y);
  const rest = at === -1 ? picks : picks.filter((_, i) => i !== at);
  if (letter === BLANK) {
    // A wildcard needs telling what it stands for, so the grid asks first.
    swapping = { picks: rest, at: { x: cell.x, y: cell.y } };
    refresh();
    return;
  }
  const sitting = game.board.get(cell.x, cell.y);
  if (sitting && Board.effective(sitting) === letter) {
    status(`there is already a ${letter.toUpperCase()} there`, 'error');
    return;
  }
  markUsed('swap');
  placement = null; // one move at a time
  swapping = { picks: [...rest, { x: cell.x, y: cell.y, letter, fromBlank: false }], at: null };
  refresh();
}

/**
 * Land a dragged letter on the board: it begins a word there, or carries on
 * the one being spelled when dropped on the cell the arrow is pointing at.
 */
function dropOnBoard(letter, cell) {
  if (!requirePlayer()) return;
  const sitting = game.board.get(cell.x, cell.y);
  // Mid-word, a tile dropped on a letter joins the word and writes over it.
  // With no word on the go it starts a swap or a stack instead — the same
  // gesture, read by what you were already doing.
  if (sitting && !placement) {
    pickOverwrite(letter, cell);
    return;
  }
  if (swapping?.picks.length) {
    status('drop it on a letter already down — that is what a swap writes over', 'error');
    return;
  }
  if (!placement) {
    placement = startPlacement(cell.x, cell.y);
    kbCursor = { x: cell.x, y: cell.y };
  }
  if (letter === BLANK) {
    // A wildcard needs telling what it stands for; park the cursor on the
    // cell it was dropped on so the letter lands there.
    moveCursor(cell.x, cell.y);
    pickingBlank = 'placement';
    refresh();
    return;
  }
  typeLetter(letter, { at: cell });
}

rackBox.addEventListener('pointerdown', (e) => {
  // Arranging your letters mid-word is the whole point of the tray, so a
  // placement is no reason to lock it — nor is a half-built swap, which is
  // built by dragging letters onto the board in the first place. Exchanging
  // is: there a tap means "pick this one", and a half-drag would pick the
  // wrong tile.
  if (exchanging) return;
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const r = tile.getBoundingClientRect();
  rackDrag = {
    tile,
    idx: [...rackBox.children].indexOf(tile),
    letter: tile.dataset.letter,
    grabX: e.clientX - r.left,
    grabY: e.clientY - r.top,
    w: r.width,
    h: r.height,
    pid: e.pointerId,
    x0: e.clientX,
    y0: e.clientY,
    moved: false,
    ghost: null,
    slot: null,
  };
});

rackBox.addEventListener('pointermove', (e) => {
  if (!rackDrag || e.pointerId !== rackDrag.pid) return;
  const d = rackDrag;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 10) {
    d.moved = true;
    d.tile.setPointerCapture(e.pointerId);
    d.tile.classList.add('lifted');
    rackBox.classList.add('arranging'); // light the empty slots as targets
    const ghost = d.tile.cloneNode(true);
    ghost.className = 'tile ghost' + (d.letter === BLANK ? ' blank' : '');
    ghost.style.width = `${d.w}px`;
    ghost.style.height = `${d.h}px`;
    document.body.appendChild(ghost);
    d.ghost = ghost;
  }
  if (!d.moved) return;

  d.ghost.style.transform =
    `translate(${e.clientX - d.grabX}px, ${e.clientY - d.grabY}px)`;

  const slot = slotUnder(e.clientX, e.clientY);
  if (slot !== d.slot) {
    for (const el of rackBox.children) el.classList.remove('target');
    if (slot !== null) rackBox.children[slot]?.classList.add('target');
    d.slot = slot;
  }
  const cell = slot === null ? boardCellUnder(e.clientX, e.clientY) : null;
  const changed = (cell?.x ?? null) !== (dropCell?.x ?? null) || (cell?.y ?? null) !== (dropCell?.y ?? null);
  dropCell = cell;
  if (changed) requestRender();
});

function endRackDrag(e) {
  if (!rackDrag || e.pointerId !== rackDrag.pid) return;
  const d = rackDrag;
  rackDrag = null;
  const landing = dropCell;
  dropCell = null;
  d.tile.classList.remove('lifted');
  rackBox.classList.remove('arranging');
  for (const el of rackBox.children) el.classList.remove('target');
  d.ghost?.remove();
  if (!d.moved) return; // a plain tap: let the click handler spell it

  suppressRackTap = true;
  setTimeout(() => (suppressRackTap = false), 0);

  const p = game.players[currentPlayer];
  if (landing) {
    dropOnBoard(d.letter, landing);
    render();
    return;
  }
  if (p && d.slot !== null && d.slot !== d.idx) {
    const before = rackRects();
    swapInLayout(p, d.idx, d.slot);
    renderRack();
    // Both tiles slide to their new homes; every other slot stays put.
    slideRack(before, { sourceOf: (i) => (i === d.idx ? d.slot : i === d.slot ? d.idx : i) });
  }
}
rackBox.addEventListener('pointerup', endRackDrag);
rackBox.addEventListener('pointercancel', endRackDrag);

// -------------------------------------------------------------- the menubar
//
// Three things sit above the game rather than inside it: the table's rules,
// the games you are in, and your account. They are all the same thing — a
// button in the masthead that opens one labelled panel — so they are built,
// opened, closed and keyboarded identically, and only one is ever open.

const MENUS = { table: 'table-menu', account: 'account-menu', games: 'games-menu' };
let openMenu = null;

function showMenu(which) {
  const from = openMenu;
  openMenu = which;
  $('menu-layer').hidden = which === null;
  for (const [name, id] of Object.entries(MENUS)) {
    $(id).hidden = name !== which;
    $(`${name}-btn`).setAttribute('aria-expanded', String(name === which));
  }
  if (which === 'games') refreshGames();
  if (which === 'account') renderAccount();
  if (which === 'table') renderTableRules();
  if (which) {
    // Opening moves the keyboard onto the panel itself, so its name is read
    // out and Tab walks its contents in order rather than starting halfway
    // through them. Closing hands the keyboard back to the button that
    // opened it, so Tab never lands in dead space.
    $(MENUS[which]).focus({ preventScroll: true });
  } else if (from) {
    $(`${from}-btn`)?.focus({ preventScroll: true });
  }
}

const toggleMenu = (which) => showMenu(openMenu === which ? null : which);

/** A table you can only be told about if the game knows who you are. */
const waitingOnYou = (g) => Boolean(g.yourTurn) && (g.players?.length ?? 0) > 1;

$('table-btn').addEventListener('click', () => toggleMenu('table'));
$('account-btn').addEventListener('click', () => {
  markUsed('account');
  toggleMenu('account');
});
$('games-btn').addEventListener('click', () => toggleMenu('games'));
for (const btn of document.querySelectorAll('.menu-close')) {
  btn.addEventListener('click', () => showMenu(null));
}

// Click away or press Esc to close, the way every other menu behaves.
document.addEventListener('pointerdown', (e) => {
  if (!openMenu) return;
  if ($('menu-layer').contains(e.target) || $('menubar').contains(e.target)) return;
  showMenu(null);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) showMenu(null);
}, true);

// ------------------------------------------------------------------ account
function renderAccount() {
  const who = account.get();
  $('account-out').hidden = Boolean(who);
  $('account-in').hidden = !who;
  $('account-btn-name').textContent = who ? who.name : 'Sign in';
  if (!who) return;
  const mine = knownGames();
  const stars = mine.reduce((n, g) => n + (g.stars ?? 0), 0);
  const turns = mine.filter(waitingOnYou).length;
  $('account-who').innerHTML = `<b>${esc(who.name)}</b>
    <div class="muted">${mine.length} game${mine.length === 1 ? '' : 's'}${
      turns ? ` · ${turns} waiting on you` : ''
    }${stars ? ` · <span class="stars">${'★'.repeat(Math.min(stars, 5))}</span> ${stars}` : ''}</div>`;
  renderNotifyToggle();
}

const withAccount = async (fn, verb) => {
  const name = $('account-name').value.trim();
  const pass = $('account-pass').value;
  if (!name || !pass) {
    status('a name and a passphrase, please', 'error');
    return;
  }
  try {
    await fn(name, pass);
    $('account-pass').value = '';
    status(`${verb} as ${account.get().name}`, 'good');
    renderAccount();
    await refreshGames();
  } catch (err) {
    showError(err);
  }
};

$('sign-in').addEventListener('click', () => withAccount((n, p) => account.signIn(n, p), 'signed in'));
$('sign-up').addEventListener('click', () => withAccount((n, p) => account.signUp(n, p), 'account made — signed in'));
$('sign-out').addEventListener('click', async () => {
  await account.signOut();
  accountGames = [];
  status('signed out — this device keeps the games it already joined', '');
  renderAccount();
  renderGames();
});

$('pass-save').addEventListener('click', async () => {
  const current = $('pass-old').value;
  const next = $('pass-new').value;
  if (!current || !next) {
    status('both passphrases, please', 'error');
    return;
  }
  try {
    await account.changePassphrase(current, next);
    $('pass-old').value = $('pass-new').value = '';
    $('passphrase-details').open = false;
    status('passphrase changed — you stay signed in here', 'good');
  } catch (err) {
    showError(err);
  }
});

// -------------------------------------------------------------- games menu
let accountGames = [];
let gamesPending = false;

/** Your games as best we know them: the account's list, else this device's. */
function knownGames() {
  if (account.get() && accountGames.length) return accountGames;
  return recent.list();
}

async function refreshGames() {
  renderGames(); // whatever we already know, on screen at once
  if (!account.get() || gamesPending) return;
  gamesPending = true;
  try {
    const { games } = await account.myGames();
    accountGames = games;
    for (const g of games) recent.remember(gameCard(g));
    renderGames();
    renderAccount();
    noteTurnsElsewhere(games);
  } catch {
    if (!recent.list().length) {
      $('my-games').innerHTML = '<div class="muted">Could not reach your games.</div>';
    }
  } finally {
    gamesPending = false;
  }
}

const gameCard = (g) => ({
  id: g.id, day: g.day, players: g.players, score: g.score,
  stars: g.stars ?? 0, yourTurn: g.yourTurn, waitingFor: g.waitingFor ?? null,
});

function renderGames() {
  const box = $('my-games');
  const games = knownGames();
  const here = online() ? session.id : null;
  box.innerHTML = '';
  if (!games.length) {
    box.innerHTML = account.get()
      ? '<div class="muted">No games yet — start one below and it will show up here.</div>'
      : '<div class="muted">No online games on this device yet. Sign in and your games follow you anywhere.</div>';
  }
  for (const g of games) {
    const b = document.createElement('button');
    if (waitingOnYou(g)) b.classList.add('your-turn');
    if (g.id === here) b.classList.add('here');
    const who = (g.players?.length ?? 0) < 2
      ? 'just you so far — share the link'
      : g.yourTurn
        ? 'your turn'
        : g.waitingFor
          ? `waiting for ${g.waitingFor}`
          : 'in play';
    b.innerHTML = `${waitingOnYou(g) ? '● ' : ''}${esc(g.players.join(', '))}
      <div class="when">day ${g.day} · ${g.score} points · ${esc(who)}${
        g.id === here ? ' · you are here' : ''
      }</div>`;
    b.onclick = () => {
      showMenu(null);
      if (g.id === here) return;
      location.search = `?g=${encodeURIComponent(g.id)}`;
    };
    box.appendChild(b);
  }
  if (!account.get() && games.length) {
    const note = document.createElement('div');
    note.className = 'muted';
    note.style.fontSize = '11.5px';
    note.textContent = 'On this device only — sign in to carry them to your phone.';
    box.appendChild(note);
  }
  const waiting = games.filter(waitingOnYou).length;
  $('games-badge').textContent = String(waiting);
  $('games-badge').hidden = waiting === 0;
}

$('games-refresh').addEventListener('click', () => refreshGames());
$('menu-new-game').addEventListener('click', () => {
  showMenu(null);
  $('setup-details').open = true;
  $('create-online').click();
});

// ----------------------------------------------------------- notifications
function renderNotifyToggle() {
  const box = $('notify-turns');
  const note = $('notify-note');
  box.checked = notify.enabled();
  box.disabled = !notify.supported() || notify.permission() === 'denied';
  note.textContent = !notify.supported()
    ? 'This browser has no notifications to give.'
    : notify.permission() === 'denied'
      ? 'Your browser is blocking notifications for this site — turn them back on in its site settings.'
      : box.checked
        ? "You'll be told when a game is waiting on you, even in another tab."
        : '';
}

$('notify-turns').addEventListener('change', async (e) => {
  if (!e.target.checked) {
    notify.disable();
    status('turn alerts off', '');
  } else {
    const result = await notify.enable();
    status(
      {
        on: "turn alerts on — I'll tell you when a game is waiting on you 🔔",
        blocked: 'your browser is blocking notifications for this site',
        dismissed: 'no permission given, so no alerts',
        unsupported: 'this browser has no notifications to give',
      }[result],
      result === 'on' ? 'good' : 'error',
    );
  }
  renderNotifyToggle();
});

// One alert per turn per game: a game only gets to speak again once the
// turn has passed on and come back.
const told = new Set();

/** The game on screen, told only when you can't see the banner. */
function noteTurnHere() {
  const yours = online() && game.players.length > 1 && game.isTheirTurn(session.playerId);
  document.title = yours ? '● your turn — wordser' : BASE_TITLE;
  if (!yours) {
    told.delete(session.id);
    return;
  }
  if (told.has(session.id) || !document.hidden) return;
  told.add(session.id);
  const others = game.players.filter((p) => p.id !== session.playerId).map((p) => p.name);
  notify.show('Your turn in wordser', {
    body: others.length ? `with ${others.join(', ')}` : 'the board is yours',
    tag: `wordser:${session.id}`,
  });
}

/** The other tables: they can only speak through the games list. */
function noteTurnsElsewhere(games) {
  for (const g of games) {
    if (online() && g.id === session.id) continue; // that one is noteTurnHere's
    if (!waitingOnYou(g)) {
      told.delete(g.id);
      continue;
    }
    if (told.has(g.id)) continue;
    told.add(g.id);
    notify.show('Your turn in wordser', {
      body: `${g.players.filter((n) => n !== g.you).join(', ')} — day ${g.day}`,
      tag: `wordser:${g.id}`,
      url: `?g=${encodeURIComponent(g.id)}`,
    });
  }
}

// Your other games tick along without you looking at them, so the badge and
// the alerts need a slow poll of their own. A minute is plenty for a game
// whose turns take hours.
setInterval(() => {
  if (account.get()) refreshGames();
}, 60_000);

$('fly-camera').addEventListener('change', (e) => {
  setFly(e.target.checked);
  status(
    e.target.checked
      ? 'the view will glide to each new word'
      : 'the view will stay where you put it — ⌖ still jumps to the last word',
    '',
  );
});

$('away-me').addEventListener('change', (e) => {
  const away = e.target.checked;
  const others = game.players.filter((p) => !p.away && !p.isCpu).length;
  doMove({ type: 'away', away }, (r) =>
    r.away
      ? others > 2
        ? "you're marked busy — your turns will pass themselves 💤"
        : "you're marked busy — with only one other player, they will simply carry on"
      : 'welcome back — your turns are yours again 👋',
  );
});

$('goal-words').addEventListener('change', (e) => {
  const raw = e.target.value.trim();
  const words = raw === '' || Number(raw) === 0 ? null : Number(raw);
  doMove({ type: 'goal', words }, (r) =>
    r.goal === null
      ? 'no finish line — the game runs on'
      : `playing to ${r.goal} words, ${r.goal - r.wordsPlayed} to go`,
  );
});

/**
 * Wipe the board and play again. Nobody is asked who starts: the opening
 * word is worth having, so the hat decides. Naming an opener is still on
 * offer where it belongs — the panel that appears when somebody joins
 * mid-game, which is the moment a table actually cares who leads.
 */
function askRestart() {
  const me = online() ? session.playerId : currentPlayer;
  if (online() && !game.isAdmin(me)) return;
  showMenu(null); // what happens next happens on the board, not in here
  doRestart(null);
}

$('restart-game').addEventListener('click', askRestart);

$('mode-turns').addEventListener('change', (e) => {
  const mode = e.target.checked ? 'turns' : 'free';
  doMove({ type: 'mode', mode }, (r) =>
    r.mode === 'turns' ? 'strict turns 🔁' : 'free-for-all — play whenever a friend has 🎲',
  );
});

$('shuffle').addEventListener('click', () => {
  markUsed('shuffle');
  const p = game.players[currentPlayer];
  if (!p) return;
  const before = rackRects();
  // Shuffle the whole tray, gaps and all — it is a request to start again.
  // The parallel array tracks where each slot's contents came from, so the
  // tiles slide to their new homes instead of blinking there.
  const layout = layoutFor(p);
  const from = layout.map((_, i) => i);
  for (let i = layout.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [layout[i], layout[j]] = [layout[j], layout[i]];
    [from[i], from[j]] = [from[j], from[i]];
  }
  rackLayouts.set(p.id, layout);
  renderRack();
  slideRack(before, { sourceOf: (i) => from[i] });
});

$('end-day').addEventListener('click', () => {
  if (online()) return;
  if (!confirm('End the day now? Scores are locked in, everyone gets a fresh rack, and the ★ moves.')) {
    return;
  }
  showMenu(null); // the new day is out there, not in this panel
  // Everyone is about to be dealt a fresh rack, and a half-made move is
  // written against the old one — an exchange holds rack positions, which
  // would land on somebody else's letters entirely.
  cancelModes();
  selected = null;
  const winners = game.startNewDay();
  status(
    winners.length
      ? `day won by ${winners.map((w) => w.name).join(' & ')} ★`
      : 'the day ends with no winner',
    'good',
  );
  refresh();
});

if (savedName) {
  $('online-name').value = savedName;
  $('player-name').value = savedName;
}

resize();
refresh();
// Whatever state we opened in, the loading notice must not outlive the load.
renderAccount();
renderGames();
scheduleAntic(); // the fruit start playing up once everything else is ready
if (account.get()) refreshGames();
if (pendingJoinId) status('you were invited to this game — enter your name, then join');
else if (online()) status('welcome back');
else status('add players, or create an online game');

// Debug/console hooks (handy for poking at the game from devtools).
window.wordser = {
  render, // the raw canvas pass, for perf probes
  get game() { return game; },
  set game(g) { game = g; },
  get session() { return session; },
  get cursor() { return kbCursor; },
  refresh,
  showLastMove,
  lastWordKeys,
  startFlourish,
  get flourishing() { return flourishing; },
  get antic() { return antic; },
  cam,
  get placement() { return placement; },
  get swapping() { return swapping; },
  get exchanging() { return exchanging; },
  setSwapping(s) {
    swapping = s;
    refresh();
  },
  get currentPlayer() { return currentPlayer; },
  /** Any tile on screen the current player isn't holding. Should be []. */
  trayGhosts() {
    const held = [...(game.players[currentPlayer]?.rack ?? [])];
    const ghosts = [];
    for (const el of rackBox.children) {
      const l = el.dataset?.letter;
      if (!l) continue;
      const i = held.indexOf(l);
      if (i === -1) ghosts.push(l);
      else held.splice(i, 1);
    }
    return ghosts;
  },
  showMenu,
  refreshGames,
  noteTurnsElsewhere,
  noteTurnHere,
};
