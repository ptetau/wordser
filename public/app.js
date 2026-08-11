import { Game, GameError, FRUIT_EMOJI, START_CELL, RACK_MAX, waitingOn } from './engine/game.js';
// Moves that leave your turn where it is — a mutation among them: it trades a
// tile for a tile and hands the seat to nobody.
const NON_TURN_MOVES = new Set(['choose', 'proposeEnd', 'voteEnd', 'kick', 'admin', 'mutate']);
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

status('loading dictionary…');
const dictText = await fetch('./data/words.txt').then((r) => r.text());
const dictionary = Dictionary.fromText(dictText);

// ---------------------------------------------------------------- game state
let game = new Game({ dictionary });
let session = null; // Online session when playing over the internet
let seq = 0; // last state sequence seen from the server
let currentPlayer = null;
let placement = null; // { sx, sy, dir, entries: [{x,y,letter,typed,existing,fromBlank,redefine}] }
let mutating = null; // { x, y }
let selected = null; // { x, y } for the actions panel
let kbCursor = null; // keyboard cursor cell, moved with the arrow keys
let cpuWordList = null; // lazy-built candidate words for CPU players
let pickingBlank = null; // 'placement' | 'mutate': choosing a letter for a blank
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

function render() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const c = cam.cell;

  const drawTile = (x, y, letter, { blank = false, pending = false, redefine = false } = {}) => {
    const t = T().tile;
    let [cx, cy] = hexCenter(x, y);
    const move = flourish(x, y);
    if (move) {
      // Transform about the tile's own centre so the letter rides with it.
      ctx.save();
      ctx.translate(cx + move.dx, cy + move.dy);
      ctx.rotate(move.rot);
      ctx.scale(move.scale, move.scale);
      ctx.translate(-cx, -cy);
    }
    const face = pending ? t.pendingFace : blank ? t.blankFace : t.face;
    // A shadow under every tile: this is what makes them read as pieces
    // resting on felt rather than colour printed onto it.
    ctx.beginPath();
    ctx.roundRect(cx - c * 0.4, cy - c * 0.36, c * 0.82, c * 0.86, c * 0.1);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fill();
    hexPath(cx, cy, c * 0.42);
    if (t.style === 'bevel') {
      // A soft top-lit face with a darker lower edge reads as a raised tile.
      const grad = ctx.createLinearGradient(cx, cy - c / 2, cx, cy + c / 2);
      grad.addColorStop(0, (pending ? t.pendingFaceLight : t.faceLight) ?? face);
      grad.addColorStop(1, (pending ? t.pendingFaceDark : t.faceDark) ?? face);
      ctx.fillStyle = grad;
      ctx.fill();
      if (t.edgeDark) {
        ctx.strokeStyle = t.edgeDark;
        ctx.lineWidth = Math.max(1.5, c * 0.045);
        ctx.stroke();
      }
      if (t.edgeLight) {
        hexPath(cx, cy - c * 0.03, c * 0.37);
        ctx.strokeStyle = t.edgeLight;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      hexPath(cx, cy, c * 0.42);
    } else {
      ctx.fillStyle = face;
      ctx.fill();
    }
    if (t.grain && !pending && !blank) {
      // Wood streaks, jittered per cell so no two tiles match.
      const rnd = cellHash(x, y);
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = t.grain;
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const gy = cy - c * 0.35 + rnd() * c * 0.7;
        ctx.beginPath();
        ctx.moveTo(cx - c / 2, gy);
        ctx.bezierCurveTo(cx - c * 0.17, gy + rnd() * c * 0.12 - c * 0.06, cx + c * 0.17, gy - rnd() * c * 0.12 + c * 0.06, cx + c / 2, gy);
        ctx.stroke();
      }
      ctx.restore();
      hexPath(cx, cy, c * 0.42);
    }
    if (redefine) {
      ctx.strokeStyle = T().redefine;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = t.text;
    ctx.font = `700 ${Math.floor(c * 0.48)}px ${T().letterFont ?? 'system-ui'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter.toUpperCase(), cx, cy - c * 0.02);
    const v = blank ? 0 : LETTER_VALUES[letter] ?? 0;
    ctx.font = `${Math.floor(c * 0.19)}px ${T().letterFont ?? 'system-ui'}`;
    ctx.fillText(String(v), cx + c * 0.24, cy + c * 0.3);
    if (move) ctx.restore();
  };

  const lm = lastWordKeys();
  const lit = []; // centres of the last word's cells, haloed after the loop

  for (const [x, y] of visibleHexes()) {
    const [cx, cy] = hexCenter(x, y);
    const p = premiumAt(x, y);
    const isStart = wrapCoord(x) === game.startCell.x && wrapCoord(y) === game.startCell.y;
    const onSeam = wrapCoord(x) === 0 || wrapCoord(y) === 0;
    hexPath(cx, cy, c * 0.47);
    ctx.fillStyle = p
      ? T().premium[p]
      : isStart
        ? T().startFill
        : onSeam
          ? T().seamFill
          : T().cellFill;
    ctx.fill();
    if (T().cellStroke) {
      ctx.strokeStyle = T().cellStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (T().speckle && !p) {
      // A pinch of felt-like texture, stable per cell.
      const rnd = cellHash(x, y);
      ctx.fillStyle = T().speckle;
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(cx - c * 0.35 + rnd() * c * 0.7, cy - c * 0.35 + rnd() * c * 0.7, 1.5, 1.5);
      }
    }
    if (p && c >= 26 && !isStart) {
      ctx.fillStyle = T().premiumLabel;
      ctx.font = `${Math.floor(c * 0.24)}px ${T().letterFont ?? 'system-ui'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(PREMIUM_TEXT[p], cx, cy);
    }

    const tile = game.board.get(x, y);
    if (tile) {
      drawTile(x, y, Board.effective(tile), { blank: !!tile.isBlank });
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
      else if (!e.existing || placement.stealing) {
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

function nextCell() {
  const n = placement.entries.length;
  const [dx, dy] = DIRS[placement.dir];
  return { x: placement.sx + n * dx, y: placement.sy + n * dy };
}

// ------------------------------------------------------------------- panels
function renderPlayers() {
  const box = $('players');
  box.innerHTML = '';
  if (!game.players.length) {
    box.innerHTML = '<div class="muted">No players yet.</div>';
    return;
  }
  const me = online() ? session.playerId : currentPlayer;
  const iAmAdmin = game.isAdmin(me);
  for (const p of game.players) {
    const div = document.createElement('div');
    div.className = 'player';
    if (p.id === currentPlayer) div.classList.add('current');
    // Every seat says where it stands: one is up, the rest are waiting.
    const theirTurn = game.isTheirTurn(p.id);
    div.classList.add(theirTurn ? 'to-play' : 'waiting');
    const you = online() && p.id === session.playerId ? ' <small>(you)</small>' : '';
    const crown = game.isAdmin(p.id) ? ' <span title="game admin">👑</span>' : '';
    const tag = theirTurn
      ? '<span class="tag now">to play</span>'
      : '<span class="tag">waiting</span>';
    div.innerHTML = `
      <span class="name">${esc(p.name)}${crown}${you}</span>
      ${tag}
      <span class="stars">${'★'.repeat(p.stars)}</span>
      <span class="score">${p.score}</span>`;
    if (!online()) {
      div.onclick = () => {
        currentPlayer = p.id;
        cancelModes();
        refresh();
      };
    }
    if (iAmAdmin && p.id !== me) div.appendChild(adminTools(p));
    box.appendChild(div);
  }
}

/** The admin's per-player controls: hand over the crown, or remove a seat. */
function adminTools(p) {
  const tools = document.createElement('span');
  tools.className = 'admin-tools';
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
    : placement?.stealing
      ? "— the old word's letters are free"
      : (online() ? '' : `— ${p.name} `) + `· ${game.bag.pool.length} in today's bag`;
  // Which rack tiles the pending word actually spends. A steal re-uses the
  // old word's letters first, so only what they can't cover leaves the rack.
  let pendingUse = [];
  if (placement?.stealing) {
    const free = [...placement.stealing.word];
    for (const e of placement.entries) {
      const i = free.indexOf(e.letter);
      if (i !== -1) free.splice(i, 1);
      else pendingUse.push(e.fromBlank ? BLANK : e.letter);
    }
  } else if (placement) {
    pendingUse = placement.entries.filter((e) => !e.existing).map((e) => (e.fromBlank ? BLANK : e.letter));
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
    if (show === null) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      box.appendChild(slot);
      return;
    }
    const idx = rackIndexAt.get(at);
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
  if (mutating) {
    if (letter === BLANK) {
      pickingBlank = 'mutate';
      refresh();
    } else {
      applyMutate(letter, false);
    }
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
    placement = { sx: selected.x, sy: selected.y, dir: 'h', entries: [] };
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

/** A tappable a–z tile grid, used for blanks and for mutating letters. */
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
  // No business on screen mid-move, and never one careless tap from a reset.
  $('end-day').hidden =
    online() || !game.players.length || Boolean(placement || mutating || exchanging || pickingBlank);

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
        if (mode === 'mutate') applyMutate(l, true);
        else if (placement) typeLetter(l, { preferBlank: true });
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
  if (mutating) {
    const p = game.players[currentPlayer];
    const available = new Set();
    if (p) {
      const hasBlank = p.rack.includes(BLANK);
      for (const l of 'abcdefghijklmnopqrstuvwxyz') {
        if (hasBlank || p.rack.includes(l)) available.add(l);
      }
    }
    const old = game.board.get(mutating.x, mutating.y);
    const was = old ? Board.effective(old).toUpperCase() : '?';
    if (mutating.pick) {
      // Second step: say what the swap does, and let them commit or back out.
      const preview = previewMutate(mutating.pick);
      const note = preview?.ok
        ? `<span class="preview-ok">you take the ${gotName(preview.got)}</span>`
        : `<span class="preview-bad">${esc(preview?.message ?? 'not a legal swap')}</span>`;
      box.innerHTML = `<b>Mutate:</b> ${was} → ${mutating.pick.toUpperCase()} · ${note}
        ${preview?.ok ? '<div class="muted" style="margin-top:2px">a free trade: no score, and you keep your turn</div>' : ''}
        <div class="place-controls">
          <button id="mutate-back">✕<span class="lbl">back</span></button>
          <button id="mutate-go" class="${preview?.ok ? 'primary' : ''}" ${preview?.ok ? '' : 'disabled'}>✓<span class="lbl">swap</span></button>
        </div>`;
      $('mutate-back').onclick = () => {
        mutating = { x: mutating.x, y: mutating.y };
        refresh();
      };
      $('mutate-go').onclick = () =>
        applyMutate(mutating.pick, !game.players[currentPlayer].rack.includes(mutating.pick));
      return;
    }
    box.innerHTML = `<b>Mutate</b> the “${esc(was)}” — swap in which letter?
      <span class="muted">You take the ${esc(was)}; it costs no points and no turn.</span>
      <button id="cancel-mutate" class="mini">✕</button>`;
    $('cancel-mutate').onclick = () => {
      mutating = null;
      refresh();
    };
    letterGrid(box, {
      available,
      onPick: (l) => {
        mutating = { ...mutating, pick: l };
        refresh();
      },
    });
    return;
  }
  if (placement) {
    const word = placement.entries.map((e) => e.redefine ?? e.letter).join('');
    const preview = previewMove();
    const note = !preview
      ? ''
      : preview.ok
        ? ` · <span class="preview-ok">${preview.points} pts${preview.fruit ? ' 🍒' : ''}</span>`
        : ` · <span class="preview-bad">${esc(preview.message)}</span>`;
    const started = placement.entries.length > 0;
    const heading = placement.stealing
      ? `<b>Steal:</b> ${esc(placement.stealing.word.toUpperCase())} → ${word.toUpperCase() || '…'}`
      : `<b>Placing:</b> ${word.toUpperCase() || `<span class="muted">tap rack tiles or type — ✓ plays it</span>`}`;
    // Cancel sits at the far end from play: they are 6px apart on a phone.
    box.innerHTML = `${heading}${note}
      ${placement.stealing ? '<div class="muted" style="margin-top:2px">spell the new word — arrows slide it along the line</div>' : ''}
      <div class="place-controls">
        <button id="pc-cancel" title="cancel (Esc)">✕<span class="lbl">cancel</span></button>
        ${placement.stealing ? '' : `<button id="pc-dir" title="cycle direction (Space)">${DIR_GLYPH[placement.dir]}<span class="lbl">dir</span></button>`}
        <button id="pc-undo" title="undo letter (Backspace)">⌫<span class="lbl">undo</span></button>
        <button id="pc-play" class="${preview?.ok || !started ? 'primary' : ''}" ${started && !preview?.ok ? 'disabled' : ''} title="play word (Enter)">✓<span class="lbl">${preview?.ok ? `play ${preview.points}` : 'play'}</span></button>
      </div>`;
    if (!placement.stealing) $('pc-dir').onclick = flipDirection;
    // The commit gesture, lit exactly when pressing it is the right move.
    if (preview?.ok) glint($('pc-play'), 'play');
    $('pc-undo').onclick = () => {
      placement.entries.pop();
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
      '<span class="muted">Tap an empty cell to spell a word, or a tile to steal/mutate.</span>';
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
      placement = { sx: selected.x, sy: selected.y, dir, entries: [] };
      selected = null;
      refresh();
    });
  }
  for (const dir of Object.keys(DIRS)) {
    const w = game.board.wordThrough(selected.x, selected.y, dir);
    if (w && w.cells.length >= 2) {
      mkBtn(`Steal ${DIR_GLYPH[dir]} "${w.word.toUpperCase()}"`, () => stealWord(w, dir));
    }
  }
  mkBtn('Mutate this letter — take it, free', () => {
    markUsed('mutate');
    mutating = { x: selected.x, y: selected.y };
    refresh();
  });
  mkBtn('✕ Never mind', () => {
    selected = null;
    refresh();
  });
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

function renderOnline() {
  const stat = $('online-status');
  $('setup-section').hidden = online() || pendingJoinId !== null;
  $('join-controls').hidden = !(pendingJoinId !== null && !online());
  $('online-controls').hidden = online() || pendingJoinId !== null;
  $('online-name').hidden = online();
  $('cpu-section').hidden = pendingJoinId !== null;
  $('fly-camera').checked = flyEnabled;
  // Only the admin sets the table's rules, so only they see the switch.
  const me = online() ? session.playerId : currentPlayer;
  $('mode-row').hidden = !(game.players.length > 1 && game.isAdmin(me));
  $('mode-turns').checked = game.mode === 'turns';
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
  renderNameplate();
  renderTurn();
  renderDayVote();
  renderPlayers();
  renderRack();
  renderActions();
  renderLog();
  renderOnline();
  noteFruit();
  foldSetupWhenPlaying();
  applyGlints();
  document.body.classList.toggle('mode-exchange', Boolean(exchanging));
  document.body.classList.toggle('mode-steal', Boolean(placement?.stealing));
  canvas.classList.toggle('placing', !!placement);
  render();
}

/** On a fresh board, put the placement cursor on the ★ so typing just works. */
function autoStartPlacement() {
  if (placement || !game.board.isEmpty()) return;
  if (currentPlayer == null || !game.players[currentPlayer] || game.players[currentPlayer].isCpu) return;
  placement = { sx: game.startCell.x, sy: game.startCell.y, dir: 'h', entries: [] };
  kbCursor = { ...game.startCell };
  ensureVisible(game.startCell.x, game.startCell.y);
}

function cancelModes() {
  placement = null;
  mutating = null;
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
    }
  }
  seatedNames = new Set(names);
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
  noteTurnHere();
  rememberThisGame();
  refresh();
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
    if (typeof r?.points === 'number') startFlourish(game.lastMove?.keys, r.points);
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
    showLastMove();
    refresh();
    return r;
  } catch (err) {
    showError(err);
    return null;
  }
}

/**
 * Start a steal as an on-board composition: the replacement word is spelled
 * over the old word with rack taps or typing, and the arrow keys slide it
 * along the line (that is the offset). ✓ submits.
 */
function stealWord(w, dir) {
  if (!requirePlayer()) return;
  cancelModes();
  selected = null;
  placement = {
    sx: w.cells[0].x,
    sy: w.cells[0].y,
    dir,
    entries: [],
    stealing: { x: w.cells[0].x, y: w.cells[0].y, dir, word: w.word },
  };
  status(`spell your replacement for "${w.word.toUpperCase()}" — its letters are yours to reuse`, '');
  refresh();
}

/** The move the current placement would submit, or null if incomplete. */
function currentMove() {
  if (!placement) return null;
  if (placement.stealing) {
    const word = placement.entries.map((e) => e.letter).join('');
    if (word.length < 2) return null;
    const st = placement.stealing;
    return {
      type: 'steal',
      x: st.x,
      y: st.y,
      dir: st.dir,
      word,
      offset: st.dir === 'h' ? placement.sx - st.x : placement.sy - st.y,
    };
  }
  const tiles = placement.entries
    .filter((e) => !e.existing)
    .map((e) => ({ x: e.x, y: e.y, letter: e.letter, fromBlank: e.fromBlank }));
  if (!tiles.length) return null;
  const redefinitions = placement.entries
    .filter((e) => e.redefine)
    .map((e) => ({ x: e.x, y: e.y, as: e.redefine }));
  return { type: 'place', tiles, redefinitions };
}

/** Dry-run the pending move on a throwaway copy for live score feedback. */
function previewMove() {
  const move = currentMove();
  if (move == null || currentPlayer == null) return null;
  try {
    const clone = Game.fromJSON(game.toJSON(), { dictionary });
    const r = clone.apply({ playerId: currentPlayer, ...move });
    return { ok: true, points: r.points, fruit: r.fruits?.length > 0 };
  } catch (err) {
    if (err instanceof GameError) return { ok: false, message: err.message };
    console.error(err);
    return null;
  }
}

/** Dry-run a mutation so the swap can show what it leaves you holding. */
function previewMutate(letter) {
  if (currentPlayer == null || !mutating) return null;
  const fromBlank = !game.players[currentPlayer].rack.includes(letter);
  try {
    const clone = Game.fromJSON(game.toJSON(), { dictionary });
    const r = clone.mutate({ playerId: currentPlayer, x: mutating.x, y: mutating.y, letter, fromBlank });
    return { ok: true, got: r.got, words: r.words };
  } catch (err) {
    if (err instanceof GameError) return { ok: false, message: err.message };
    console.error(err);
    return null;
  }
}

const gotName = (l) => (l === BLANK ? 'wildcard' : l.toUpperCase());

function applyMutate(letter, fromBlank) {
  const cell = mutating;
  doMove(
    { type: 'mutate', x: cell.x, y: cell.y, letter, fromBlank },
    (r) =>
      `mutated to ${r.words.map((w) => w.toUpperCase()).join(' & ')} and took the ${gotName(r.got)}` +
      ' — no score, and your turn is still yours',
  );
}

function commitPlacement() {
  const move = currentMove();
  if (!move) {
    status(
      placement?.stealing ? 'spell at least two letters' : 'add at least one new letter',
      'error',
    );
    return;
  }
  if (placement && !placement.stealing) lastDir = placement.dir; // a played direction
  markUsed(placement?.stealing ? 'steal' : 'play');
  doMove(
    move,
    move.type === 'steal'
      ? (r) => `stole it for ${r.points} points${r.stolen ? `, pocketed ${r.stolen}` : ''}${fruitNote(r)}`
      : (r) => `played ${r.words.map((w) => w.toUpperCase()).join(', ')} for ${r.points} points${fruitNote(r)}`,
  );
}

function fruitNote(r) {
  return r.fruits?.length ? ` — ate ${r.fruits.map((f) => FRUIT_EMOJI[f]).join(' ')}` : '';
}

function runCpuTurns() {
  if (online()) return;
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
  render();
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
    render();
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
    render();
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
  // A tap while a word is being spelled moves the word instead of wiping it.
  if (placement?.entries.length && !game.board.get(x, y)) {
    if (placement.stealing) {
      // Slide only along the stolen word's hex line.
      const [dx, dy] = DIRS[placement.stealing.dir];
      const k = dy !== 0 ? y - placement.sy : x - placement.sx;
      if (placement.sx + k * dx === x && placement.sy + k * dy === y) {
        slidePlacement(k * dx, k * dy);
      }
      refresh();
      return;
    }
    const typed = placement.entries.map((e) => e.typed);
    placement = { sx: x, sy: y, dir: placement.dir, entries: [] };
    for (const t of typed) if (!typeLetter(t, { silent: true })) break;
    refresh();
    return;
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
  return { sx: x, sy: y, dir, entries: [] };
}

/** Shift the whole pending word by (dx, dy), keeping its letters. */
function slidePlacement(dx, dy) {
  placement.sx += dx;
  placement.sy += dy;
  if (placement.stealing) {
    const [dx, dy] = DIRS[placement.dir];
    placement.entries = placement.entries.map((e, i) => ({
      ...e,
      x: placement.sx + i * dx,
      y: placement.sy + i * dy,
    }));
  } else {
    const typed = placement.entries.map((e) => e.typed);
    placement.entries = [];
    for (const t of typed) if (!typeLetter(t, { silent: true })) break;
  }
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
    render();
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
  if (placement || mutating || exchanging) return; // mid-move: don't move the view
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

  if (mutating) {
    if (e.key === 'Escape') {
      mutating = null;
      pickingBlank = null;
      refresh();
    } else if (/^[a-z]$/.test(key)) {
      mutating = { x: mutating.x, y: mutating.y, pick: key }; // confirm on ✓
      refresh();
    } else if (e.key === 'Enter' && mutating.pick) {
      const p = game.players[currentPlayer];
      applyMutate(mutating.pick, p && !p.rack.includes(mutating.pick));
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
      // Move the whole word start; the viewport follows the cursor.
      e.preventDefault();
      if (placement.stealing) {
        // Stealing slides only along the stolen word's line: right/down step
        // forward, left/up step back.
        const [dx, dy] = DIRS[placement.stealing.dir];
        const k = arrow[0] > 0 || arrow[1] > 0 ? 1 : -1;
        slidePlacement(k * dx, k * dy);
        const cur = nextCell();
        ensureVisible(cur.x, cur.y);
        refresh();
        return;
      }
      slidePlacement(arrow[0], arrow[1]);
      const cur = nextCell();
      ensureVisible(cur.x, cur.y);
      refresh();
    } else if (e.key === 'Escape') {
      placement = null;
      refresh();
    } else if (e.key === 'Enter') {
      commitPlacement();
    } else if (e.key === 'Backspace') {
      placement.entries.pop();
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
    render();
  }
});

function flipDirection() {
  if (!placement || placement.stealing) return;
  lastDir = NEXT_DIR[placement.dir]; // an explicit choice, worth remembering
  const typed = placement.entries.map((e) => e.typed);
  placement = {
    sx: placement.sx,
    sy: placement.sy,
    dir: NEXT_DIR[placement.dir],
    entries: [],
  };
  for (const t of typed) {
    if (!typeLetter(t, { silent: true })) break;
  }
  refresh();
}

/**
 * Spell the next letter of the word being placed. Existing tiles under the
 * cursor that match are reused; mismatched normal tiles are auto-consumed so
 * you can spell straight across them; mismatched wildcards are redefined.
 */
function typeLetter(letter, { preferBlank = false, silent = false } = {}) {
  if (placement.stealing) {
    // Stealing spells the replacement over the old word; the engine sources
    // letters from the old word and the rack, so just record the letters.
    if (placement.entries.length >= 15) return false;
    placement.entries.push({ ...nextCell(), letter, typed: letter, existing: false });
    if (!silent) {
      status('');
      const cur = nextCell();
      ensureVisible(cur.x, cur.y);
      refresh();
    }
    return true;
  }
  for (let guard = 0; guard < 64; guard++) {
    const cell = nextCell();
    const tile = game.board.get(cell.x, cell.y);
    if (tile) {
      const eff = Board.effective(tile);
      if (eff === letter) {
        placement.entries.push({ ...cell, letter, typed: letter, existing: true });
        break;
      }
      if (tile.isBlank) {
        placement.entries.push({ ...cell, letter, typed: letter, existing: true, redefine: letter });
        break;
      }
      // Spell straight across a mismatched tile: consume it and continue.
      placement.entries.push({ ...cell, letter: eff, typed: eff, existing: true });
      continue;
    }
    const p = game.players[currentPlayer];
    const used = placement.entries
      .filter((e) => !e.existing)
      .map((e) => (e.fromBlank ? BLANK : e.letter));
    const avail = [...p.rack];
    for (const u of used) {
      const i = avail.indexOf(u);
      if (i !== -1) avail.splice(i, 1);
    }
    if (!preferBlank && avail.includes(letter)) {
      placement.entries.push({ ...cell, letter, typed: letter, existing: false });
    } else if (avail.includes(BLANK)) {
      placement.entries.push({ ...cell, letter, typed: letter, existing: false, fromBlank: true });
    } else if (avail.includes(letter)) {
      placement.entries.push({ ...cell, letter, typed: letter, existing: false });
    } else {
      if (!silent) status(`no "${letter.toUpperCase()}" (or blank) left in your rack`, 'error');
      return false;
    }
    break;
  }
  if (!silent) {
    status('');
    const cur = nextCell();
    ensureVisible(cur.x, cur.y);
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
  const p = game.addPlayer(name);
  seatedNames = null; // local seats announce themselves below
  $('player-name').value = '';
  if (currentPlayer == null) currentPlayer = p.id;
  autoStartPlacement();
  status(`${p.name} joined the game 👋 — dealt ${p.rack.length} tiles`, 'good');
  refresh();
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
  cpuWordList ??= buildWordList(dictionary);
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
 * Land a dragged letter on the board: it begins a word there, or carries on
 * the one being spelled when dropped on the cell the arrow is pointing at.
 */
function dropOnBoard(letter, cell) {
  if (!requirePlayer()) return;
  if (game.board.get(cell.x, cell.y)) {
    status('there is a letter there already — drop on an empty cell', 'error');
    return;
  }
  const carryOn = placement && (placement.entries.length > 0 || placement.stealing);
  if (carryOn) {
    const n = nextCell();
    if (n.x !== cell.x || n.y !== cell.y) {
      status('drop it on the arrow to carry this word on, or ✕ to start elsewhere', '');
      return;
    }
  } else {
    placement = startPlacement(cell.x, cell.y);
    kbCursor = { x: cell.x, y: cell.y };
  }
  if (letter === BLANK) {
    pickingBlank = 'placement';
    refresh();
    return;
  }
  typeLetter(letter);
}

rackBox.addEventListener('pointerdown', (e) => {
  // Arranging your letters mid-word is the whole point of the tray, so a
  // placement is no reason to lock it. Exchanging and mutating are: there a
  // tap means "pick this one", and a half-drag would pick the wrong tile.
  if (mutating || exchanging) return;
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
  if (changed) render();
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
// Two things belong to the player rather than to the table: their account
// and the games they are in. They open as popovers from the masthead, so
// they cost nothing until asked for and never crowd the game panel.

const MENUS = { account: 'account-menu', games: 'games-menu' };
let openMenu = null;

function showMenu(which) {
  openMenu = which;
  $('menu-layer').hidden = which === null;
  for (const [name, id] of Object.entries(MENUS)) {
    $(id).hidden = name !== which;
    $(`${name}-btn`).setAttribute('aria-expanded', String(name === which));
  }
  if (which === 'games') refreshGames();
  if (which === 'account') renderAccount();
}

const toggleMenu = (which) => showMenu(openMenu === which ? null : which);

/** A table you can only be told about if the game knows who you are. */
const waitingOnYou = (g) => Boolean(g.yourTurn) && (g.players?.length ?? 0) > 1;

$('account-btn').addEventListener('click', () => {
  markUsed('account');
  toggleMenu('account');
});
$('games-btn').addEventListener('click', () => toggleMenu('games'));

// Click away or press Esc to close, the way every other menu behaves.
document.addEventListener('pointerdown', (e) => {
  if (!openMenu) return;
  if ($('menu-layer').contains(e.target) || $('menubar').contains(e.target)) return;
  showMenu(null);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) {
    showMenu(null);
    $(`${openMenu}-btn`)?.focus();
  }
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
  showMenu,
  refreshGames,
  noteTurnsElsewhere,
  noteTurnHere,
};
