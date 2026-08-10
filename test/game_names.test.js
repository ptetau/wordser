import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { handleAction, memoryStore } from '../api/game.js';
import { makeGame } from './helpers.js';

const fresh = () => new Game({ dictionary: new Dictionary(['cat']) });

test('two players cannot share a name', () => {
  const g = fresh();
  g.addPlayer('Ana');
  assert.throws(() => g.addPlayer('Ana'), GameError);
  assert.throws(() => g.addPlayer('Ana'), /already playing/);
  assert.equal(g.players.length, 1);
});

test('names collide regardless of case and stray spacing', () => {
  const g = fresh();
  g.addPlayer('Ana');
  assert.throws(() => g.addPlayer('ANA'), /already playing/);
  assert.throws(() => g.addPlayer('  ana  '), /already playing/);
  assert.throws(() => g.addPlayer('aNa'), /already playing/);
  g.addPlayer('Ana B');
  assert.throws(() => g.addPlayer('Ana   B'), /already playing/);
  assert.deepEqual(g.players.map((p) => p.name), ['Ana', 'Ana B']);
});

test('names are stored trimmed and space-collapsed; blanks are refused', () => {
  const g = fresh();
  assert.equal(g.addPlayer('  Ana   Lee  ').name, 'Ana Lee');
  assert.throws(() => g.addPlayer('   '), /name is required/);
  assert.throws(() => g.addPlayer(''), /name is required/);
});

test('different names still seat fine, and nameTaken reports honestly', () => {
  const g = makeGame(['cat']);
  assert.equal(g.nameTaken('Ana'), true);
  assert.equal(g.nameTaken('ana'), true);
  assert.equal(g.nameTaken('Cleo'), false);
  const p = g.addPlayer('Cleo');
  assert.equal(p.id, 2);
  assert.equal(g.nameTaken('Cleo'), true);
});

test('CPU seats pick the first free Robo number', () => {
  const g = fresh();
  g.addPlayer('Ana');
  assert.equal(g.addCpu().name, 'Robo 1 🤖');
  assert.equal(g.addCpu().name, 'Robo 2 🤖');
  assert.equal(g.players[1].isCpu, true);
});

test('a CPU works around a human who took its name', () => {
  const g = fresh();
  g.addPlayer('Robo 1 🤖');
  const cpu = g.addCpu();
  assert.equal(cpu.name, 'Robo 2 🤖');
  assert.equal(cpu.isCpu, true);
});

test('joining an online game with a taken name is refused', async () => {
  const store = memoryStore();
  const ana = (await handleAction(store, { action: 'create', name: 'Ana' })).data;
  const dupe = await handleAction(store, { action: 'join', id: ana.id, name: 'Ana' });
  assert.equal(dupe.status, 400);
  assert.match(dupe.data.error, /already playing/);
  const cased = await handleAction(store, { action: 'join', id: ana.id, name: '  aNa ' });
  assert.equal(cased.status, 400);

  // The refused joins left no seat behind.
  const state = await handleAction(store, {
    action: 'state',
    id: ana.id,
    playerId: 0,
    token: ana.token,
  });
  assert.equal(state.data.game.players.length, 1);

  const ben = await handleAction(store, { action: 'join', id: ana.id, name: 'Ben' });
  assert.equal(ben.status, 200);
  assert.equal(ben.data.you, 1);
});

test('online CPU seats get distinct names', async () => {
  const store = memoryStore();
  const ana = (await handleAction(store, { action: 'create', name: 'Ana' })).data;
  const one = await handleAction(store, {
    action: 'addcpu',
    id: ana.id,
    playerId: 0,
    token: ana.token,
  });
  const two = await handleAction(store, {
    action: 'addcpu',
    id: ana.id,
    playerId: 0,
    token: ana.token,
  });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const names = two.data.game.players.map((p) => p.name);
  assert.deepEqual(names, ['Ana', 'Robo 1 🤖', 'Robo 2 🤖']);
  assert.equal(new Set(names).size, names.length);
});

test('every arrival announces itself in the log, exactly once', () => {
  const g = fresh();
  g.addPlayer('Ana');
  assert.deepEqual(g.log, ['Ana joined the game 👋']);
  g.addPlayer('Ben');
  assert.equal(g.log.filter((l) => l.includes('joined')).length, 2);

  // A CPU seat announces itself the same way, and only once.
  const cpu = g.addCpu();
  const joins = g.log.filter((l) => l.includes('joined'));
  assert.equal(joins.length, 3);
  assert.equal(joins[2], `${cpu.name} joined the game 👋`);

  // A refused name leaves no trace.
  assert.throws(() => g.addPlayer('ana'), /already playing/);
  assert.equal(g.log.filter((l) => l.includes('joined')).length, 3);
});

test('players already in an online game hear about a new arrival', async () => {
  const store = memoryStore();
  const ana = (await handleAction(store, { action: 'create', name: 'Ana' })).data;
  await handleAction(store, { action: 'join', id: ana.id, name: 'Ben' });

  const anaSees = await handleAction(store, {
    action: 'state', id: ana.id, playerId: 0, token: ana.token,
  });
  assert.match(anaSees.data.game.log.join('\n'), /Ben joined the game/);

  // And so does a CPU seat added by somebody else.
  await handleAction(store, { action: 'addcpu', id: ana.id, playerId: 0, token: ana.token });
  const later = await handleAction(store, {
    action: 'state', id: ana.id, playerId: 0, token: ana.token,
  });
  const joins = later.data.game.log.filter((l) => l.includes('joined the game'));
  assert.deepEqual(joins, ['Ana joined the game 👋', 'Ben joined the game 👋', 'Robo 1 🤖 joined the game 👋']);
});
