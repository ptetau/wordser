import { Game, GameError, FRUIT_EMOJI, START_CELL } from './engine/game.js';
const NON_TURN_MOVES = new Set(['choose', 'proposeEnd', 'voteEnd', 'kick', 'admin']);
import { buildWordList, takeCpuTurn } from './cpu.js';
import { Dictionary } from './engine/dictionary.js';
import { Board, WORLD, wrapCoord, DIRS } from './engine/board.js';
import { premiumAt } from './engine/premium.js';
import { LETTER_VALUES, BLANK } from './engine/tiles.js';
import { Online, NetError } from './net.js';
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

const online = () => session !== null;

const savedName = (() => {
  try {
    return localStorage.getItem('wordser:name') ?? '';
  } catch {
    return '';
  }
})();
function rememberName(name) {
  try {
    localStorage.setItem('wordser:name', name);
  } catch {}
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

function render() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const c = cam.cell;
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui';

  const drawTile = (x, y, letter, { blank = false, pending = false, redefine = false } = {}) => {
    const t = T().tile;
    const [cx, cy] = hexCenter(x, y);
    const face = pending ? t.pendingFace : blank ? t.blankFace : t.face;
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
  };

  const lm = game.lastMove && !placement ? new Set(game.lastMove.keys) : null;

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
        ctx.beginPath();
        ctx.arc(cx, cy, c * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = T().fruitRing;
        ctx.fill();
        // Keep fruit legible even zoomed far out.
        ctx.font = `${Math.max(16, Math.floor(c * 0.68))}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(FRUIT_EMOJI[fruit] ?? '🍇', cx, cy + c * 0.08);
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
      hexPath(cx, cy, c * 0.46);
      ctx.strokeStyle = T().lastMove;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
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
    const mustWait = game.players.length > 1 && game.lastPlayerId === p.id;
    if (mustWait) div.classList.add('waiting');
    const you = online() && p.id === session.playerId ? ' <small>(you)</small>' : '';
    const crown = game.isAdmin(p.id) ? ' <span title="game admin">👑</span>' : '';
    div.innerHTML = `
      <span class="name">${esc(p.name)}${crown}${you}${mustWait ? ' <small>(waiting)</small>' : ''}</span>
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
  $('rack-hint').textContent =
    (online() ? '' : `— ${p.name} `) + `· ${game.bag.pool.length} in today's bag`;
  const pendingUse = placement
    ? placement.entries.filter((e) => !e.existing).map((e) => (e.fromBlank ? BLANK : e.letter))
    : [];
  const rack = [...p.rack];
  for (const u of pendingUse) {
    const i = rack.indexOf(u);
    if (i !== -1) rack.splice(i, 1);
  }
  rack.forEach((l, i) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'tile' + (l === BLANK ? ' blank' : '');
    if (exchanging?.picks.includes(i)) t.classList.add('selected');
    t.innerHTML = l === BLANK ? '★<sub>0</sub>' : `${l}<sub>${LETTER_VALUES[l]}</sub>`;
    t.onclick = () => rackTap(l, i);
    box.appendChild(t);
  });
  $('shuffle').hidden = !p;
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
  $('end-day').hidden = online() || !game.players.length;

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
    box.innerHTML = '<b>Mutate:</b> swap in which letter? <button id="cancel-mutate" class="mini">✕</button>';
    $('cancel-mutate').onclick = () => {
      mutating = null;
      refresh();
    };
    letterGrid(box, {
      available,
      onPick: (l) => applyMutate(l, !game.players[currentPlayer].rack.includes(l)),
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
    const heading = placement.stealing
      ? `<b>Steal:</b> ${esc(placement.stealing.word.toUpperCase())} → ${word.toUpperCase() || '…'}`
      : `<b>Placing:</b> ${word.toUpperCase() || '…'}`;
    box.innerHTML = `${heading}${note}
      ${placement.stealing ? '<div class="muted" style="margin-top:2px">spell the new word — arrows slide it along the line</div>' : ''}
      <div class="place-controls">
        ${placement.stealing ? '' : `<button id="pc-dir" title="cycle direction (Space)">${DIR_GLYPH[placement.dir]}</button>`}
        <button id="pc-undo" title="undo letter (Backspace)">⌫</button>
        <button id="pc-cancel" title="cancel (Esc)">✕</button>
        <button id="pc-play" class="primary" title="play word (Enter)">✓${preview?.ok ? ` ${preview.points}` : ''}</button>
      </div>`;
    if (!placement.stealing) $('pc-dir').onclick = flipDirection;
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
    if (game.players[currentPlayer]) {
      const ex = document.createElement('button');
      ex.id = 'exchange-btn';
      ex.style.cssText = 'display:block;width:100%;margin-top:6px';
      ex.textContent = '⇄ Exchange letters instead of playing';
      ex.onclick = () => {
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
        propose.onclick = () =>
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
        doMove({ type: 'pass' }, (r) =>
          r.dayEnded ? 'everyone passed — a new day begins! ★' : 'passed',
        );
      box.appendChild(pass);
    }
    return;
  }
  box.innerHTML = '<div class="word-btns"></div>';
  const btns = box.querySelector('.word-btns');
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    btns.appendChild(b);
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
  mkBtn('Mutate this letter', () => {
    mutating = { x: selected.x, y: selected.y };
    refresh();
  });
}

function renderLog() {
  $('log').innerHTML = game.log.slice(-14).reverse().map((l) => `<div>${esc(l)}</div>`).join('');
}

function renderOnline() {
  const stat = $('online-status');
  $('setup-section').hidden = online() || pendingJoinId !== null;
  $('join-controls').hidden = !(pendingJoinId !== null && !online());
  $('online-controls').hidden = online() || pendingJoinId !== null;
  $('online-name').hidden = online();
  $('cpu-section').hidden = pendingJoinId !== null;
  $('share').hidden = !online();
  document.body.classList.toggle(
    'no-game',
    !online() && pendingJoinId === null && game.players.length === 0,
  );
  if (online()) {
    const me = game.players[session.playerId];
    stat.textContent = `Online as ${me ? me.name : '…'} — share the link so friends can join.`;
    $('share-link').value = shareLink();
  } else if (pendingJoinId !== null) {
    stat.textContent = 'You have been invited to an online game. Enter a name below, then join.';
  } else {
    stat.textContent = 'Hot-seat mode: everyone shares this screen.';
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
  renderDayVote();
  renderPlayers();
  renderRack();
  renderActions();
  renderLog();
  renderOnline();
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
  // Someone else's move arrived: announce it and bring it into view.
  if (changed && game.lastMove && game.lastMove.playerId !== session.playerId && !placement) {
    const [x, y] = game.lastMove.keys[0].split(',').map(Number);
    ensureVisible(x, y);
    if (game.log.length) status(game.log[game.log.length - 1], '');
  }
  document.title =
    online() && game.players.length > 1 && game.lastPlayerId !== session.playerId
      ? '● your turn — wordser'
      : BASE_TITLE;
  refresh();
}

async function doMove(move, describe) {
  if (online()) {
    try {
      const d = await session.move(move);
      cancelModes();
      selected = null;
      adoptView(d);
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

function applyMutate(letter, fromBlank) {
  const cell = mutating;
  doMove(
    { type: 'mutate', x: cell.x, y: cell.y, letter, fromBlank },
    (r) => `mutated to ${r.words.map((w) => w.toUpperCase()).join(' & ')} for ${r.points} points`,
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
  for (const p of game.players) {
    if (!p.isCpu) continue;
    if (game.players.length > 1 && game.lastPlayerId === p.id) continue;
    const r = takeCpuTurn(game, p.id, cpuWordList);
    if (r) {
      acted = true;
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
    if (game.lastMove?.keys?.length && !placement) {
      const [x, y] = game.lastMove.keys[0].split(',').map(Number);
      ensureVisible(x, y);
    }
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
  const typed = ($('online-name').value || $('player-name').value).trim();
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
  status('online game ready — share the link!', 'good');
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
  }
}

// -------------------------------------------------------------------- input
const pointers = new Map();
let drag = null;
let pinch = null;

canvas.addEventListener('pointerdown', (e) => {
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
    if (requirePlayer()) placement = { sx: x, sy: y, dir: 'h', entries: [] };
  }
  refresh();
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

/** Pan the camera the minimum needed to keep hex (x, y) comfortably visible. */
function ensureVisible(x, y) {
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
      const p = game.players[currentPlayer];
      const fromBlank = p && !p.rack.includes(key) && p.rack.includes(BLANK);
      applyMutate(key, fromBlank);
    }
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
      placement = { sx: kbCursor.x, sy: kbCursor.y, dir: 'h', entries: [] };
      typeLetter(key);
    }
  } else if (key === '+' || key === '=' || key === '-') {
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
  $('player-name').value = '';
  if (currentPlayer == null) currentPlayer = p.id;
  autoStartPlacement();
  status(`${p.name} joined with a rack of ${p.rack.length}`, 'good');
  refresh();
});

$('add-cpu').addEventListener('click', async () => {
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
  status(`${p.name} joined — it plays whenever it may`, 'good');
  if (game.players.length > 1) setTimeout(runCpuTurns, 400);
  refresh();
});

// Drag rack tiles to rearrange them. Only when nothing is being spelled, so
// the visible tiles map one-to-one onto the rack array.
let rackDrag = null;
let suppressRackTap = false;
const rackBox = $('rack');
rackBox.addEventListener('pointerdown', (e) => {
  if (placement || mutating || exchanging) return;
  const tile = e.target.closest('.tile');
  if (!tile) return;
  rackDrag = {
    tile,
    idx: [...rackBox.children].indexOf(tile),
    x0: e.clientX,
    y0: e.clientY,
    pid: e.pointerId,
    moved: false,
  };
});
rackBox.addEventListener('pointermove', (e) => {
  if (!rackDrag || e.pointerId !== rackDrag.pid) return;
  const dx = e.clientX - rackDrag.x0;
  const dy = e.clientY - rackDrag.y0;
  if (!rackDrag.moved && Math.hypot(dx, dy) > 10) {
    rackDrag.moved = true;
    rackDrag.tile.setPointerCapture(e.pointerId);
    rackDrag.tile.classList.add('dragging');
  }
  if (rackDrag.moved) rackDrag.tile.style.transform = `translate(${dx}px, ${dy}px)`;
});
function endRackDrag(e) {
  if (!rackDrag || e.pointerId !== rackDrag.pid) return;
  const d = rackDrag;
  rackDrag = null;
  d.tile.classList.remove('dragging');
  d.tile.style.transform = '';
  if (!d.moved) return; // a plain tap: let the click handler spell it
  suppressRackTap = true;
  setTimeout(() => (suppressRackTap = false), 0);
  const p = game.players[currentPlayer];
  if (!p) return;
  let best = d.idx;
  let bestDist = Infinity;
  [...rackBox.children].forEach((k, i) => {
    const r = k.getBoundingClientRect();
    const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  if (best !== d.idx && best < p.rack.length && d.idx < p.rack.length) {
    const [moved] = p.rack.splice(d.idx, 1);
    p.rack.splice(best, 0, moved);
  }
  renderRack();
}
rackBox.addEventListener('pointerup', endRackDrag);
rackBox.addEventListener('pointercancel', endRackDrag);

$('shuffle').addEventListener('click', () => {
  const p = game.players[currentPlayer];
  if (!p) return;
  for (let i = p.rack.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p.rack[i], p.rack[j]] = [p.rack[j], p.rack[i]];
  }
  renderRack();
});

$('end-day').addEventListener('click', () => {
  if (online()) return;
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
if (!online() && !pendingJoinId) {
  status(`dictionary loaded (${dictionary.size.toLocaleString()} words). Add players, or create an online game.`);
}

// Debug/console hooks (handy for poking at the game from devtools).
window.wordser = {
  get game() { return game; },
  set game(g) { game = g; },
  get session() { return session; },
  get cursor() { return kbCursor; },
  refresh,
  cam,
};
