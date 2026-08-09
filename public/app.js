import { Game, GameError } from './engine/game.js';
import { Dictionary } from './engine/dictionary.js';
import { Board } from './engine/board.js';
import { premiumAt } from './engine/premium.js';
import { LETTER_VALUES, BLANK } from './engine/tiles.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

const status = (msg, cls = '') => {
  $('status').textContent = msg;
  $('status').className = cls;
};

status('loading dictionary…');
const dictText = await fetch('./data/words.txt').then((r) => r.text());
const dictionary = Dictionary.fromText(dictText);
const game = new Game({ dictionary });
status(`dictionary loaded (${dictionary.size.toLocaleString()} words). Add players to start.`);

// ---------------------------------------------------------------- view state
const cam = { x: -6.5, y: -4.5, cell: 44 }; // cam.x/y: board coords of top-left
let currentPlayer = null;
let placement = null; // { sx, sy, dir, entries: [{x, y, letter, existing, fromBlank, redefine}] }
let mutating = null; // { x, y }
let selected = null; // { x, y } for the actions panel

const PREMIUM_FILL = {
  TW: '#8c2f23', DW: '#6e4038', TL: '#1f5d8a', DL: '#3d5a75',
};
const PREMIUM_TEXT = { TW: '3×W', DW: '2×W', TL: '3×L', DL: '2×L' };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}
window.addEventListener('resize', resize);

function cellAt(px, py) {
  return {
    x: Math.floor(cam.x + px / cam.cell),
    y: Math.floor(cam.y + py / cam.cell),
  };
}

function render() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const x0 = Math.floor(cam.x) - 1;
  const y0 = Math.floor(cam.y) - 1;
  const x1 = Math.ceil(cam.x + w / cam.cell) + 1;
  const y1 = Math.ceil(cam.y + h / cam.cell) + 1;
  const c = cam.cell;

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const sx = (x - cam.x) * c;
      const sy = (y - cam.y) * c;
      const p = premiumAt(x, y);
      ctx.fillStyle = p ? PREMIUM_FILL[p] : x === 0 && y === 0 ? '#2c3140' : '#262b35';
      ctx.fillRect(sx + 1, sy + 1, c - 2, c - 2);
      if (p && c >= 30) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = `${Math.floor(c / 4)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(PREMIUM_TEXT[p], sx + c / 2, sy + c / 2);
      }
    }
  }

  const drawTile = (x, y, letter, { blank = false, pending = false, redefine = false } = {}) => {
    const sx = (x - cam.x) * c;
    const sy = (y - cam.y) * c;
    const pad = Math.max(2, c * 0.06);
    ctx.fillStyle = pending ? '#f2d377' : blank ? '#cfd8e3' : '#e9dcc3';
    ctx.beginPath();
    ctx.roundRect(sx + pad, sy + pad, c - pad * 2, c - pad * 2, c * 0.12);
    ctx.fill();
    if (redefine) {
      ctx.strokeStyle = '#b05cd6';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = '#2b2417';
    ctx.font = `700 ${Math.floor(c * 0.5)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter.toUpperCase(), sx + c / 2, sy + c / 2 - c * 0.02);
    const v = blank ? 0 : LETTER_VALUES[letter] ?? 0;
    ctx.font = `${Math.floor(c * 0.2)}px system-ui`;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), sx + c - pad - 2, sy + c - pad - c * 0.12);
  };

  for (const [k, tile] of game.board.cells) {
    const [x, y] = k.split(',').map(Number);
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    drawTile(x, y, Board.effective(tile), { blank: !!tile.isBlank });
  }

  if (placement) {
    for (const e of placement.entries) {
      if (e.redefine) drawTile(e.x, e.y, e.redefine, { blank: true, redefine: true });
      else if (!e.existing) drawTile(e.x, e.y, e.letter, { pending: true, blank: e.fromBlank });
    }
    const cur = nextCell();
    const sx = (cur.x - cam.x) * c;
    const sy = (cur.y - cam.y) * c;
    ctx.strokeStyle = '#f2d377';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(sx + 2, sy + 2, c - 4, c - 4);
    ctx.fillStyle = '#f2d377';
    ctx.font = `700 ${Math.floor(c * 0.4)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(placement.dir === 'h' ? '→' : '↓', sx + c / 2, sy + c / 2);
  } else if (selected) {
    const sx = (selected.x - cam.x) * c;
    const sy = (selected.y - cam.y) * c;
    ctx.strokeStyle = '#7fd4ff';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(sx + 2, sy + 2, c - 4, c - 4);
  }
}

function nextCell() {
  const n = placement.entries.length;
  return {
    x: placement.sx + (placement.dir === 'h' ? n : 0),
    y: placement.sy + (placement.dir === 'v' ? n : 0),
  };
}

// ------------------------------------------------------------------- panels
function renderPlayers() {
  const box = $('players');
  box.innerHTML = '';
  if (!game.players.length) {
    box.innerHTML = '<div class="muted">No players yet.</div>';
    return;
  }
  for (const p of game.players) {
    const div = document.createElement('div');
    div.className = 'player';
    if (p.id === currentPlayer) div.classList.add('current');
    const mustWait = game.players.length > 1 && game.lastPlayerId === p.id;
    if (mustWait) div.classList.add('waiting');
    div.innerHTML = `
      <span class="name">${p.name}${mustWait ? ' <small>(waiting for a friend)</small>' : ''}</span>
      <span class="stars">${'★'.repeat(p.stars)}</span>
      <span class="score">${p.score}</span>`;
    div.onclick = () => {
      currentPlayer = p.id;
      cancelModes();
      refresh();
    };
    box.appendChild(div);
  }
}

function renderRack() {
  const box = $('rack');
  box.innerHTML = '';
  const p = game.players[currentPlayer];
  if (!p) {
    box.innerHTML = '<div class="muted">Select a player.</div>';
    return;
  }
  const pendingUse = placement
    ? placement.entries.filter((e) => !e.existing).map((e) => (e.fromBlank ? BLANK : e.letter))
    : [];
  const rack = [...p.rack];
  for (const u of pendingUse) {
    const i = rack.indexOf(u);
    if (i !== -1) rack.splice(i, 1);
  }
  for (const l of rack) {
    const t = document.createElement('div');
    t.className = 'tile' + (l === BLANK ? ' blank' : '');
    t.innerHTML = l === BLANK ? '★<sub>0</sub>' : `${l}<sub>${LETTER_VALUES[l]}</sub>`;
    box.appendChild(t);
  }
}

function renderActions() {
  const box = $('cell-actions');
  if (mutating) {
    box.innerHTML = '<b>Mutate:</b> type the new letter for the selected tile (Esc to cancel).';
    return;
  }
  if (placement) {
    const word = placement.entries.map((e) => e.redefine ?? e.letter).join('');
    box.innerHTML = `<b>Placing:</b> ${word.toUpperCase() || '…'}<br>
      <span class="muted">Enter to play · Space flips direction · Esc cancels</span>`;
    return;
  }
  if (!selected || !game.board.get(selected.x, selected.y)) {
    box.innerHTML = '<span class="muted">Click an empty cell to type a word, or a tile to steal/mutate.</span>';
    return;
  }
  box.innerHTML = '';
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    box.appendChild(b);
  };
  for (const dir of ['h', 'v']) {
    const w = game.board.wordThrough(selected.x, selected.y, dir);
    if (w && w.cells.length >= 2) {
      mkBtn(`Steal ${dir === 'h' ? '→' : '↓'} "${w.word.toUpperCase()}"`, () => stealWord(w, dir));
    }
  }
  mkBtn('Mutate this letter', () => {
    mutating = { x: selected.x, y: selected.y };
    refresh();
  });
}

function renderLog() {
  $('log').innerHTML = game.log.slice(-14).reverse().map((l) => `<div>${l}</div>`).join('');
}

function refresh() {
  renderPlayers();
  renderRack();
  renderActions();
  renderLog();
  canvas.classList.toggle('placing', !!placement);
  render();
}

function cancelModes() {
  placement = null;
  mutating = null;
}

function requirePlayer() {
  if (currentPlayer == null || !game.players[currentPlayer]) {
    status('add and select a player first', 'error');
    return false;
  }
  return true;
}

// -------------------------------------------------------------------- moves
function stealWord(w, dir) {
  if (!requirePlayer()) return;
  const word = window.prompt(
    `Replace "${w.word.toUpperCase()}" with (your rack + its letters; leftovers are stolen, 12 rack max):`,
  );
  if (!word) return;
  let offset = 0;
  if (word.trim().length !== w.cells.length) {
    const o = window.prompt('Offset from the old word’s first letter (0 = same start):', '0');
    if (o === null) return;
    offset = Number(o) || 0;
  }
  try {
    const r = game.stealReplace({
      playerId: currentPlayer,
      x: w.cells[0].x,
      y: w.cells[0].y,
      dir,
      word: word.trim(),
      offset,
    });
    selected = null;
    afterMove(`stole it for ${r.points} points${r.stolen ? `, pocketed ${r.stolen}` : ''}`);
  } catch (err) {
    showError(err);
  }
}

function commitPlacement() {
  const tiles = placement.entries
    .filter((e) => !e.existing)
    .map((e) => ({ x: e.x, y: e.y, letter: e.letter, fromBlank: e.fromBlank }));
  const redefinitions = placement.entries
    .filter((e) => e.redefine)
    .map((e) => ({ x: e.x, y: e.y, as: e.redefine }));
  if (!tiles.length) {
    status('type at least one new letter', 'error');
    return;
  }
  try {
    const r = game.place({ playerId: currentPlayer, tiles, redefinitions });
    placement = null;
    afterMove(`played ${r.words.map((w) => w.toUpperCase()).join(', ')} for ${r.points} points`);
  } catch (err) {
    showError(err);
  }
}

function afterMove(msg) {
  status(msg, 'good');
  // Hot-seat convenience: hand the seat to the next player.
  if (game.players.length > 1) {
    currentPlayer = (currentPlayer + 1) % game.players.length;
  }
  refresh();
}

function showError(err) {
  if (err instanceof GameError) status(err.message, 'error');
  else {
    console.error(err);
    status(String(err.message ?? err), 'error');
  }
}

// -------------------------------------------------------------------- input
let drag = null;
canvas.addEventListener('mousedown', (e) => {
  drag = { px: e.clientX, py: e.clientY, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.px;
  const dy = e.clientY - drag.py;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.moved) {
    cam.x -= dx / cam.cell;
    cam.y -= dy / cam.cell;
    drag.px = e.clientX;
    drag.py = e.clientY;
    render();
  }
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const clicked = !drag.moved;
  drag = null;
  if (!clicked) return;
  const rect = canvas.getBoundingClientRect();
  if (e.target !== canvas) return;
  const { x, y } = cellAt(e.clientX - rect.left, e.clientY - rect.top);
  cancelModes();
  if (game.board.get(x, y)) {
    selected = { x, y };
  } else {
    selected = null;
    if (requirePlayer()) placement = { sx: x, sy: y, dir: 'h', entries: [] };
  }
  refresh();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const anchorX = cam.x + px / cam.cell;
  const anchorY = cam.y + py / cam.cell;
  cam.cell = Math.min(72, Math.max(20, cam.cell * (e.deltaY > 0 ? 0.9 : 1.1)));
  cam.x = anchorX - px / cam.cell;
  cam.y = anchorY - py / cam.cell;
  render();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();

  if (mutating) {
    if (e.key === 'Escape') {
      mutating = null;
      refresh();
      return;
    }
    if (/^[a-z]$/.test(key)) {
      const p = game.players[currentPlayer];
      const fromBlank = p && !p.rack.includes(key) && p.rack.includes(BLANK);
      try {
        const r = game.mutate({ playerId: currentPlayer, ...mutating, letter: key, fromBlank });
        mutating = null;
        selected = null;
        afterMove(`mutated to ${r.words.map((w) => w.toUpperCase()).join(' & ')} for ${r.points} points`);
      } catch (err) {
        showError(err);
      }
    }
    return;
  }

  if (!placement) return;

  if (e.key === 'Escape') {
    placement = null;
    refresh();
  } else if (e.key === 'Enter') {
    commitPlacement();
  } else if (e.key === 'Backspace') {
    placement.entries.pop();
    refresh();
  } else if (e.key === ' ') {
    e.preventDefault();
    if (placement.entries.length === 0) {
      placement.dir = placement.dir === 'h' ? 'v' : 'h';
      refresh();
    }
  } else if (/^[a-z]$/.test(key)) {
    typeLetter(key);
  }
});

function typeLetter(letter) {
  const cell = nextCell();
  const tile = game.board.get(cell.x, cell.y);
  if (tile) {
    if (Board.effective(tile) === letter) {
      placement.entries.push({ ...cell, letter, existing: true });
    } else if (tile.isBlank) {
      placement.entries.push({ ...cell, letter, existing: true, redefine: letter });
    } else {
      status(`that cell already holds "${Board.effective(tile).toUpperCase()}"`, 'error');
      return;
    }
  } else {
    const p = game.players[currentPlayer];
    const used = placement.entries
      .filter((e) => !e.existing)
      .map((e) => (e.fromBlank ? BLANK : e.letter));
    const avail = [...p.rack];
    for (const u of used) {
      const i = avail.indexOf(u);
      if (i !== -1) avail.splice(i, 1);
    }
    if (avail.includes(letter)) {
      placement.entries.push({ ...cell, letter, existing: false });
    } else if (avail.includes(BLANK)) {
      placement.entries.push({ ...cell, letter, existing: false, fromBlank: true });
    } else {
      status(`no "${letter.toUpperCase()}" (or blank) left in your rack`, 'error');
      return;
    }
  }
  status('');
  refresh();
}

// ------------------------------------------------------------------ chrome
$('add-player-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('player-name').value.trim();
  if (!name) return;
  const p = game.addPlayer(name);
  $('player-name').value = '';
  if (currentPlayer == null) currentPlayer = p.id;
  status(`${p.name} joined with a rack of ${p.rack.length}`, 'good');
  refresh();
});

$('end-day').addEventListener('click', () => {
  const winners = game.startNewDay();
  status(
    winners.length
      ? `day won by ${winners.map((w) => w.name).join(' & ')} ★`
      : 'the day ends with no winner',
    'good',
  );
  refresh();
});

resize();
refresh();

// Debug/console hooks (handy for poking at the game from devtools).
window.wordser = { game, refresh, cam };
