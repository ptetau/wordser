import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAction, memoryStore } from '../api/game.js';

async function setupGame(store) {
  const ana = (await handleAction(store, { action: 'create', name: 'Ana' })).data;
  const ben = (await handleAction(store, { action: 'join', id: ana.id, name: 'Ben' })).data;
  return { ana, ben };
}

async function rigRack(store, id, playerId, rack) {
  const record = await store.get(`wordser:game:${id}`);
  record.game.players[playerId].rack = rack;
  assert.ok(await store.put(`wordser:game:${id}`, record, record.seq));
}

test('create, join, and play a move over the wire', async () => {
  const store = memoryStore();
  const { ana, ben } = await setupGame(store);
  assert.equal(ana.you, 0);
  assert.equal(ben.you, 1);
  assert.equal(ben.game.players.length, 2);

  await rigRack(store, ana.id, 0, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  const move = await handleAction(store, {
    action: 'move',
    id: ana.id,
    playerId: 0,
    token: ana.token,
    move: {
      type: 'place',
      tiles: [
        { x: 0, y: 0, letter: 'c' },
        { x: 1, y: 0, letter: 'a' },
        { x: 2, y: 0, letter: 't' },
      ],
    },
  });
  assert.equal(move.status, 200);
  assert.equal(move.data.result.points, 15);
  assert.equal(move.data.game.players[0].score, 15);
});

test('states are personalized: own rack visible, others masked, no tokens', async () => {
  const store = memoryStore();
  const { ana, ben } = await setupGame(store);
  {
    const record = await store.get(`wordser:game:${ana.id}`);
    record.game.players[0].pendingChoice = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    await store.put(`wordser:game:${ana.id}`, record, record.seq);
  }
  const s = (await handleAction(store, {
    action: 'state', id: ana.id, playerId: 0, token: ana.token,
  })).data;
  const other = (await handleAction(store, {
    action: 'state', id: ana.id, playerId: 1, token: ben.token,
  })).data;
  assert.equal(s.game.players[0].pendingChoice.length, 7);
  assert.equal(other.game.players[0].pendingChoice, undefined);
  assert.equal(s.game.players[0].rack.length, 7);
  assert.ok(s.game.players[0].rack.every((l) => l !== '?'));
  assert.ok(s.game.players[1].rack.every((l) => l === '?'));
  assert.ok(s.game.players.every((p) => !('token' in p)));
  assert.ok(ben.game.players[0].rack.every((l) => l === '?'));
});

test('the server enforces credentials and the friend rule', async () => {
  const store = memoryStore();
  const { ana } = await setupGame(store);
  const bad = await handleAction(store, {
    action: 'state', id: ana.id, playerId: 0, token: 'wrong',
  });
  assert.equal(bad.status, 403);

  await rigRack(store, ana.id, 0, ['c', 'a', 't', 'a', 't', 'e', 'e']);
  const mv = (t) => ({
    action: 'move', id: ana.id, playerId: 0, token: ana.token,
    move: { type: 'place', tiles: t },
  });
  const first = await handleAction(store, mv([
    { x: 0, y: 0, letter: 'c' }, { x: 1, y: 0, letter: 'a' }, { x: 2, y: 0, letter: 't' },
  ]));
  assert.equal(first.status, 200);
  const second = await handleAction(store, mv([{ x: 3, y: 0, letter: 'a' }]));
  assert.equal(second.status, 400);
  assert.match(second.data.error, /friend/);
});

test('unknown games and stale polls answer cheaply', async () => {
  const store = memoryStore();
  const missing = await handleAction(store, { action: 'state', id: 'nope' });
  assert.equal(missing.status, 404);

  const { ana } = await setupGame(store);
  const s = (await handleAction(store, {
    action: 'state', id: ana.id, playerId: 0, token: ana.token,
  })).data;
  const again = (await handleAction(store, {
    action: 'state', id: ana.id, playerId: 0, token: ana.token, since: s.seq,
  })).data;
  assert.equal(again.unchanged, true);
});

test('compare-and-set rejects stale writes', async () => {
  const store = memoryStore();
  assert.equal(await store.put('k', { seq: 1 }, 0), true);
  assert.equal(await store.put('k', { seq: 2 }, 5), false);
  assert.equal(await store.put('k', { seq: 2 }, 1), true);
});
