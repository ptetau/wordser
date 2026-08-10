import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { handleAction, memoryStore } from '../api/game.js';
import { makeGame, tilesFor } from './helpers.js';

const fresh = (names = []) => {
  const g = new Game({ dictionary: new Dictionary(['cat', 'cot']) });
  names.forEach((n) => g.addPlayer(n));
  return g;
};

test('the first player to sit down is the admin', () => {
  const g = fresh(['Ana', 'Ben']);
  assert.equal(g.adminId, 0);
  assert.equal(g.isAdmin(0), true);
  assert.equal(g.isAdmin(1), false);
});

test('a CPU never holds admin, but the next human does', () => {
  const g = fresh();
  g.addCpu();
  assert.equal(g.adminId, null);
  assert.equal(g.isAdmin(0), false);
  const ana = g.addPlayer('Ana');
  assert.equal(g.adminId, ana.id);
});

test('only the admin may remove players or hand the crown on', () => {
  const g = fresh(['Ana', 'Ben', 'Cleo']);
  assert.throws(() => g.removePlayer({ playerId: 1, targetId: 2 }), /only the game admin/);
  assert.throws(() => g.transferAdmin({ playerId: 1, toId: 2 }), GameError);
  assert.equal(g.players.length, 3);
});

test('the admin cannot remove themselves', () => {
  const g = fresh(['Ana', 'Ben']);
  assert.throws(() => g.removePlayer({ playerId: 0, targetId: 0 }), /hand admin over first/);
  assert.equal(g.players.length, 2);
});

test('admin can be handed over, and the new admin can remove the old one', () => {
  const g = fresh(['Ana', 'Ben']);
  assert.throws(() => g.transferAdmin({ playerId: 0, toId: 0 }), /already the admin/);
  assert.deepEqual(g.transferAdmin({ playerId: 0, toId: 1 }), { admin: 1 });
  assert.equal(g.adminId, 1);
  assert.throws(() => g.transferAdmin({ playerId: 0, toId: 1 }), /only the game admin/);
  const r = g.removePlayer({ playerId: 1, targetId: 0 });
  assert.equal(r.removed, 'Ana');
  assert.deepEqual(g.players.map((p) => p.name), ['Ben']);
  assert.equal(g.adminId, 0); // Ben slid up into seat 0 and kept the crown
});

test('admin cannot go to a CPU seat', () => {
  const g = fresh(['Ana']);
  const cpu = g.addCpu();
  assert.throws(() => g.transferAdmin({ playerId: 0, toId: cpu.id }), /CPU player cannot be the admin/);
  assert.equal(g.adminId, 0);
});

test('removing renumbers the seats and returns the map', () => {
  const g = fresh(['Ana', 'Ben', 'Cleo', 'Dai']);
  const r = g.removePlayer({ playerId: 0, targetId: 1 });
  assert.equal(r.removed, 'Ben');
  assert.deepEqual(r.map, [0, null, 1, 2]);
  assert.deepEqual(g.players.map((p) => p.name), ['Ana', 'Cleo', 'Dai']);
  assert.deepEqual(g.players.map((p) => p.id), [0, 1, 2]);
  assert.equal(g.player(1).name, 'Cleo');
});

test("a removed player's letters go back into the day's bag", () => {
  const g = fresh(['Ana', 'Ben']);
  const before = g.bag.pool.length;
  g.players[1].rack = ['q', 'z'];
  g.removePlayer({ playerId: 0, targetId: 1 });
  assert.equal(g.bag.pool.length, before + 2);
  assert.ok(g.bag.pool.includes('q') && g.bag.pool.includes('z'));
});

test('turn bookkeeping follows the renumbering', () => {
  const g = makeGame(['cat', 'cot'], {
    players: ['Ana', 'Ben', 'Cleo'],
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], [], []],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.lastPlayerId, 0);
  g.pass({ playerId: 2 });
  assert.deepEqual([...g.passed], [2]);

  // Remove Ben (seat 1): Cleo slides to seat 1 and keeps her pass.
  g.removePlayer({ playerId: 0, targetId: 1 });
  assert.deepEqual([...g.passed], [1]);
  assert.equal(g.lastPlayerId, 1);
  assert.equal(g.player(1).name, 'Cleo');
});

test('removing the last mover frees everyone else to play', () => {
  const g = makeGame(['cat'], {
    players: ['Ana', 'Ben'],
    racks: [[], ['c', 'a', 't', 'e', 'e', 'e', 'e']],
  });
  g.pass({ playerId: 0 });
  assert.equal(g.lastPlayerId, 0);
  // Ben is admin here only after a hand-over; do it, then Ben drops Ana.
  g.transferAdmin({ playerId: 0, toId: 1 });
  g.removePlayer({ playerId: 1, targetId: 0 });
  assert.equal(g.lastPlayerId, null);
  assert.equal(g.place({ playerId: 0, tiles: tilesFor('cat', g.startCell.x, g.startCell.y) }).points > 0, true);
});

test('a live day-end vote survives a removal, and holdouts can be removed', () => {
  const g = fresh(['Ana', 'Ben', 'Cleo']);
  g.bag.pool = [];
  g.proposeDayEnd({ playerId: 0 });
  g.voteDayEnd({ playerId: 2, agree: true });
  assert.deepEqual(g.dayEndVote.agreed, [0, 2]);
  assert.equal(g.day, 1);

  // Ben was the only holdout — removing him completes the proposal.
  const r = g.removePlayer({ playerId: 0, targetId: 1 });
  assert.equal(r.dayEnded, true);
  assert.equal(g.day, 2);
  assert.equal(g.dayEndVote, null);
});

test("removing the proposer drops their proposal", () => {
  const g = fresh(['Ana', 'Ben', 'Cleo']);
  g.bag.pool = [];
  g.transferAdmin({ playerId: 0, toId: 2 });
  g.proposeDayEnd({ playerId: 1 });
  g.removePlayer({ playerId: 2, targetId: 1 });
  assert.equal(g.dayEndVote, null);
  assert.equal(g.day, 1);
});

test('admin rights survive serialization, and old saves fall back to the first human', () => {
  const g = fresh(['Ana', 'Ben']);
  g.transferAdmin({ playerId: 0, toId: 1 });
  const opts = { dictionary: new Dictionary(['cat']) };
  const round = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), opts);
  assert.equal(round.adminId, 1);

  const legacy = g.toJSON();
  delete legacy.adminId;
  legacy.players[0].isCpu = true;
  assert.equal(Game.fromJSON(JSON.parse(JSON.stringify(legacy)), opts).adminId, 1);
});

test('kick and admin dispatch through apply()', () => {
  const g = fresh(['Ana', 'Ben', 'Cleo']);
  assert.equal(g.apply({ type: 'admin', playerId: 0, toId: 1 }).admin, 1);
  assert.equal(g.apply({ type: 'kick', playerId: 1, targetId: 2 }).removed, 'Cleo');
  assert.equal(g.players.length, 2);
});

// ------------------------------------------------------------------ online

async function table(store) {
  const ana = (await handleAction(store, { action: 'create', name: 'Ana' })).data;
  const ben = (await handleAction(store, { action: 'join', id: ana.id, name: 'Ben' })).data;
  const cleo = (await handleAction(store, { action: 'join', id: ana.id, name: 'Cleo' })).data;
  return { ana, ben, cleo };
}

const send = (store, who, id, move) =>
  handleAction(store, { action: 'move', id, playerId: who.you, token: who.token, move });

test('the creator is admin online, and can remove a player over the wire', async () => {
  const store = memoryStore();
  const { ana, ben, cleo } = await table(store);
  assert.equal(ana.game.adminId, 0);

  const denied = await send(store, ben, ana.id, { type: 'kick', targetId: 2 });
  assert.equal(denied.status, 400);
  assert.match(denied.data.error, /only the game admin/);

  const kicked = await send(store, ana, ana.id, { type: 'kick', targetId: 1 });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.data.result.removed, 'Ben');
  assert.deepEqual(kicked.data.game.players.map((p) => p.name), ['Ana', 'Cleo']);

  // Cleo slid from seat 2 to seat 1: her token still works and reports it.
  const hers = await handleAction(store, {
    action: 'state',
    id: ana.id,
    playerId: cleo.you, // the stale id she still remembers
    token: cleo.token,
  });
  assert.equal(hers.status, 200);
  assert.equal(hers.data.you, 1);
  assert.equal(hers.data.game.players[1].name, 'Cleo');
  assert.notEqual(hers.data.game.players[1].rack[0], '?'); // her own rack, not masked

  // Ben's credentials are gone with his seat.
  const his = await handleAction(store, {
    action: 'state', id: ana.id, playerId: 1, token: ben.token,
  });
  assert.equal(his.status, 403);
});

test('handing admin over the wire moves the rights, not the seats', async () => {
  const store = memoryStore();
  const { ana, ben } = await table(store);
  const handed = await send(store, ana, ana.id, { type: 'admin', toId: 1 });
  assert.equal(handed.status, 200);
  assert.equal(handed.data.game.adminId, 1);

  const nope = await send(store, ana, ana.id, { type: 'kick', targetId: 2 });
  assert.equal(nope.status, 400);
  const yep = await send(store, ben, ana.id, { type: 'kick', targetId: 2 });
  assert.equal(yep.status, 200);
  assert.deepEqual(yep.data.game.players.map((p) => p.name), ['Ana', 'Ben']);
});

test('an admin who removes a seat below their own keeps their identity', async () => {
  const store = memoryStore();
  const { ana, ben, cleo } = await table(store);
  await send(store, ana, ana.id, { type: 'admin', toId: 2 }); // Cleo (seat 2) is admin
  const r = await send(store, cleo, ana.id, { type: 'kick', targetId: 1 }); // drops Ben
  assert.equal(r.status, 200);
  assert.equal(r.data.you, 1); // Cleo is seat 1 now, and told so
  assert.equal(r.data.game.adminId, 1);
  // Her rack is unmasked in her own view, proving the token landed on her seat.
  assert.notEqual(r.data.game.players[1].rack[0], '?');
  assert.equal(r.data.game.players[0].rack[0], '?');
  // And Ana's token still resolves to seat 0.
  const anaState = await handleAction(store, {
    action: 'state', id: ana.id, playerId: 0, token: ana.token,
  });
  assert.equal(anaState.data.you, 0);
  assert.equal(anaState.data.game.players[0].name, 'Ana');
  assert.equal(ben.token !== cleo.token, true);
});
