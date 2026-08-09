import { Game, GameError, FRUIT_EMOJI, START_CELL } from './engine/game.js';
import { buildWordList, takeCpuTurn } from './cpu.js';
import { Dictionary } from './engine/dictionary.js';
import { Board, WORLD, wrapCoord } from './engine/board.js';
import { premiumAt } from './engine/premium.js';
import { LETTER_VALUES, BLANK } from './engine/tiles.js';
import { Online, NetError } from './net.js';

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

const online = () => session !== null;

// ---------------------------------------------------------------- rendering
const cam = { x: -6.5, y: -4.5, cell: 44 };

const PREMIUM_FILL = { TW: '#8c2f23', DW: '#6e4038', TL: '#1f5d8a', DL: '#3d5a75' };
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
  return { x: Math.floor(cam.x + px / cam.cell), y: Math.floor(cam.y + py / cam.cell) };
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
      const isStart = wrapCoord(x) === START_CELL.x && wrapCoord(y) === START_CELL.y;
      ctx.fillStyle = p ? PREMIUM_FILL[p] : isStart ? '#2c3140' : '#262b35';
      ctx.fillRect(sx + 1, sy + 1, c - 2, c - 2);
      if (p && c >= 30 && !isStart) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = `${Math.floor(c / 4)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(PREMIUM_TEXT[p], sx + c / 2, sy + c / 2);
      }
    }
  }

  // Seams of the looping 120×120 world.
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1.5;
  for (let x = x0; x <= x1; x++) {
    if (wrapCoord(x) !== 0) continue;
    ctx.beginPath();
    ctx.moveTo((x - cam.x) * c, 0);
    ctx.lineTo((x - cam.x) * c, h);
    ctx.stroke();
  }
  for (let y = y0; y <= y1; y++) {
    if (wrapCoord(y) !== 0) continue;
    ctx.beginPath();
    ctx.moveTo(0, (y - cam.y) * c);
    ctx.lineTo(w, (y - cam.y) * c);
    ctx.stroke();
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

  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui';

  // Tiles, fruits, and the start star — looked up per visible cell so the
  // looping world repeats in every direction.
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const tile = game.board.get(x, y);
      if (tile) {
        drawTile(x, y, Board.effective(tile), { blank: !!tile.isBlank });
        continue;
      }
      const fruit = game.fruits.get(Board.key(x, y));
      if (fruit) {
        const fx = (x - cam.x) * c + c / 2;
        const fy = (y - cam.y) * c + c / 2;
        ctx.beginPath();
        ctx.arc(fx, fy, c * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(242,211,119,0.22)';
        ctx.fill();
        ctx.font = `${Math.floor(c * 0.72)}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(FRUIT_EMOJI[fruit] ?? '🍇', fx, fy + c * 0.05);
      } else if (wrapCoord(x) === START_CELL.x && wrapCoord(y) === START_CELL.y) {
        ctx.fillStyle = 'rgba(227,179,65,0.9)';
        ctx.font = `${Math.floor(c * 0.55)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', (x - cam.x) * c + c / 2, (y - cam.y) * c + c / 2 + c * 0.02);
      }
    }
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

  if (kbCursor && !placement) {
    const sx = (kbCursor.x - cam.x) * c;
    const sy = (kbCursor.y - cam.y) * c;
    ctx.strokeStyle = 'rgba(242,211,119,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(sx + 2, sy + 2, c - 4, c - 4);
    ctx.setLineDash([]);
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
    const you = online() && p.id === session.playerId ? ' <small>(you)</small>' : '';
    div.innerHTML = `
      <span class="name">${p.name}${you}${mustWait ? ' <small>(waiting)</small>' : ''}</span>
      <span class="stars">${'★'.repeat(p.stars)}</span>
      <span class="score">${p.score}</span>`;
    if (!online()) {
      div.onclick = () => {
        currentPlayer = p.id;
        cancelModes();
        refresh();
      };
    }
    box.appendChild(div);
  }
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
  $('rack-hint').textContent = online() ? '' : `— ${p.name}`;
  const pendingUse = placement
    ? placement.entries.filter((e) => !e.existing).map((e) => (e.fromBlank ? BLANK : e.letter))
    : [];
  const rack = [...p.rack];
  for (const u of pendingUse) {
    const i = rack.indexOf(u);
    if (i !== -1) rack.splice(i, 1);
  }
  for (const l of rack) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'tile' + (l === BLANK ? ' blank' : '');
    t.innerHTML = l === BLANK ? '★<sub>0</sub>' : `${l}<sub>${LETTER_VALUES[l]}</sub>`;
    t.onclick = () => rackTap(l);
    box.appendChild(t);
  }
}

function rackTap(letter) {
  if (mutating) {
    if (letter === BLANK) {
      const as = (window.prompt('Play the blank as which letter?') ?? '').trim().toLowerCase();
      if (/^[a-z]$/.test(as)) applyMutate(as, true);
    } else {
      applyMutate(letter, false);
    }
    return;
  }
  if (placement) {
    if (letter === BLANK) {
      const as = (window.prompt('Play the blank as which letter?') ?? '').trim().toLowerCase();
      if (/^[a-z]$/.test(as)) typeLetter(as, { preferBlank: true });
    } else {
      typeLetter(letter);
    }
    return;
  }
  status('tap an empty cell first to start a word', '');
}

function renderActions() {
  const box = $('cell-actions');
  $('end-day').hidden = online();
  const chooser = online()
    ? game.players[session.playerId]
    : game.players.find((p) => p.pendingChoice);
  if (chooser?.pendingChoice) {
    box.innerHTML = `<b>${FRUIT_EMOJI.cherry} Cherry${online() ? '' : ` for ${chooser.name}`}:</b> keep one letter:
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
          (r) => `kept "${r.letter.toUpperCase()}" from the cherry ${FRUIT_EMOJI.cherry}`,
        );
      picker.appendChild(t);
    });
    return;
  }
  if (mutating) {
    box.innerHTML =
      '<b>Mutate:</b> tap a rack tile (or type) to swap it in. <button id="cancel-mutate">✕ Cancel</button>';
    $('cancel-mutate').onclick = () => {
      mutating = null;
      refresh();
    };
    return;
  }
  if (placement) {
    const word = placement.entries.map((e) => e.redefine ?? e.letter).join('');
    box.innerHTML = `<b>Placing:</b> ${word.toUpperCase() || '…'}
      <div class="place-controls">
        <button id="pc-dir" title="flip direction (Space)">${placement.dir === 'h' ? '→' : '↓'}</button>
        <button id="pc-undo" title="undo letter (Backspace)">⌫</button>
        <button id="pc-cancel" title="cancel (Esc)">✕</button>
        <button id="pc-play" class="primary" title="play word (Enter)">✓</button>
      </div>`;
    $('pc-dir').onclick = flipDirection;
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

function renderOnline() {
  const stat = $('online-status');
  $('setup-section').hidden = online() || pendingJoinId !== null;
  $('join-controls').hidden = !(pendingJoinId !== null && !online());
  $('online-controls').hidden = online() || pendingJoinId !== null;
  $('share').hidden = !online();
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

function refresh() {
  renderPlayers();
  renderRack();
  renderActions();
  renderLog();
  renderOnline();
  canvas.classList.toggle('placing', !!placement);
  render();
}

function cancelModes() {
  placement = null;
  mutating = null;
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
  seq = d.seq;
  game = Game.fromJSON(d.game, { dictionary });
  currentPlayer = session.playerId;
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
      showError(err);
      if (err instanceof NetError && (err.status === 409 || err.status === 404)) sync(true);
    }
    return null;
  }
  try {
    const r = game.apply({ playerId: currentPlayer, ...move });
    cancelModes();
    selected = null;
    status(describe(r), 'good');
    if (move.type !== 'choose' && game.players.length > 1) {
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
  doMove(
    {
      type: 'steal',
      x: w.cells[0].x,
      y: w.cells[0].y,
      dir,
      word: word.trim().toLowerCase(),
      offset,
    },
    (r) => `stole it for ${r.points} points${r.stolen ? `, pocketed ${r.stolen}` : ''}${fruitNote(r)}`,
  );
}

function applyMutate(letter, fromBlank) {
  const cell = mutating;
  doMove(
    { type: 'mutate', x: cell.x, y: cell.y, letter, fromBlank },
    (r) => `mutated to ${r.words.map((w) => w.toUpperCase()).join(' & ')} for ${r.points} points`,
  );
}

function commitPlacement() {
  const tiles = placement.entries
    .filter((e) => !e.existing)
    .map((e) => ({ x: e.x, y: e.y, letter: e.letter, fromBlank: e.fromBlank }));
  const redefinitions = placement.entries
    .filter((e) => e.redefine)
    .map((e) => ({ x: e.x, y: e.y, as: e.redefine }));
  if (!tiles.length) {
    status('add at least one new letter', 'error');
    return;
  }
  doMove(
    { type: 'place', tiles, redefinitions },
    (r) => `played ${r.words.map((w) => w.toUpperCase()).join(', ')} for ${r.points} points${fruitNote(r)}`,
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
      status(`${p.name} played ${r.words.map((w) => w.toUpperCase()).join(', ')} for ${r.points} points${fruitNote(r)}`, '');
    } else if (game.lastPlayerId != null && !game.players[game.lastPlayerId].isCpu) {
      // A stuck CPU passes so the friend rule can't deadlock its humans.
      status(`${p.name} couldn't find a word and passes`, '');
      game.lastPlayerId = null;
      acted = true;
    }
  }
  if (acted) refresh();
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
async function sync(force = false) {
  if (!online() || polling) return;
  polling = true;
  try {
    const d = await session.state(force ? undefined : seq);
    if (!d.unchanged) adoptView(d);
  } catch (err) {
    if (err instanceof NetError && err.status === 403) {
      status('this game does not recognise you on this device', 'error');
    } else if (err instanceof NetError && err.status === 404) {
      status('this game has expired', 'error');
    }
  } finally {
    polling = false;
  }
}
setInterval(() => sync(), 3000);

function askName() {
  const typed = $('player-name').value.trim();
  if (typed) return typed;
  const p = (window.prompt('Your name?') ?? '').trim();
  return p || null;
}

async function goOnline(result) {
  session = result.session;
  pendingJoinId = null;
  history.replaceState(null, '', shareLink());
  adoptView(result.view);
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
    const anchorX = cam.x + mx / cam.cell;
    const anchorY = cam.y + my / cam.cell;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    cam.cell = Math.min(72, Math.max(18, (pinch.cell * dist) / pinch.dist));
    cam.x = anchorX - mx / cam.cell;
    cam.y = anchorY - my / cam.cell;
    render();
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.px;
  const dy = e.clientY - drag.py;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) {
    cam.x -= dx / cam.cell;
    cam.y -= dy / cam.cell;
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
  cancelModes();
  kbCursor = { x, y };
  if (game.board.get(x, y)) {
    selected = { x, y };
  } else {
    selected = null;
    if (requirePlayer()) placement = { sx: x, sy: y, dir: 'h', entries: [] };
  }
  refresh();
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const anchorX = cam.x + px / cam.cell;
    const anchorY = cam.y + py / cam.cell;
    cam.cell = Math.min(72, Math.max(18, cam.cell * (e.deltaY > 0 ? 0.9 : 1.1)));
    cam.x = anchorX - px / cam.cell;
    cam.y = anchorY - py / cam.cell;
    render();
  },
  { passive: false },
);

const ARROWS = {
  arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1],
};

/** Pan the camera the minimum needed to keep cell (x, y) comfortably visible. */
function ensureVisible(x, y) {
  const w = canvas.clientWidth / cam.cell;
  const h = canvas.clientHeight / cam.cell;
  if (x < cam.x + 1) cam.x = x - 1;
  if (x + 1 > cam.x + w - 1) cam.x = x + 2 - w;
  if (y < cam.y + 1) cam.y = y - 1;
  if (y + 1 > cam.y + h - 1) cam.y = y + 2 - h;
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();
  const arrow = ARROWS[key];

  if (mutating) {
    if (e.key === 'Escape') {
      mutating = null;
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
      const typed = placement.entries.map((en) => en.typed);
      placement = {
        sx: placement.sx + arrow[0],
        sy: placement.sy + arrow[1],
        dir: placement.dir,
        entries: [],
      };
      for (const t of typed) if (!typeLetter(t, { silent: true })) break;
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
      kbCursor = {
        x: Math.round(cam.x + canvas.clientWidth / cam.cell / 2),
        y: Math.round(cam.y + canvas.clientHeight / cam.cell / 2),
      };
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
  } else if (/^[a-z]$/.test(key) && kbCursor && !game.board.get(kbCursor.x, kbCursor.y)) {
    if (requirePlayer()) {
      selected = null;
      placement = { sx: kbCursor.x, sy: kbCursor.y, dir: 'h', entries: [] };
      typeLetter(key);
    }
  } else if (key === '+' || key === '=') {
    cam.cell = Math.min(72, cam.cell * 1.1);
    render();
  } else if (key === '-') {
    cam.cell = Math.max(18, cam.cell * 0.9);
    render();
  }
});

function flipDirection() {
  if (!placement) return;
  const typed = placement.entries.map((e) => e.typed);
  placement = {
    sx: placement.sx,
    sy: placement.sy,
    dir: placement.dir === 'h' ? 'v' : 'h',
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
  const p = game.addPlayer(name);
  $('player-name').value = '';
  if (currentPlayer == null) currentPlayer = p.id;
  status(`${p.name} joined with a rack of ${p.rack.length}`, 'good');
  refresh();
});

$('add-cpu').addEventListener('click', () => {
  if (online()) return;
  cpuWordList ??= buildWordList(dictionary);
  const n = game.players.filter((p) => p.isCpu).length + 1;
  const p = game.addPlayer(`Robo ${n} 🤖`);
  p.isCpu = true;
  if (currentPlayer == null) currentPlayer = p.id;
  status(`${p.name} joined — it plays whenever it may`, 'good');
  if (game.players.length > 1) setTimeout(runCpuTurns, 400);
  refresh();
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
