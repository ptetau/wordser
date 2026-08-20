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
  assert.equal(move.data.result.points, 10);
  assert.equal(move.data.game.players[0].score, 10);
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

test('the server enforces credentials and whose turn it is', async () => {
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
  // New games rotate turns, so Ana has to wait for Ben.
  const second = await handleAction(store, mv([{ x: 3, y: 0, letter: 'a' }]));
  assert.equal(second.status, 400);
  assert.match(second.data.error, /Ben's turn/);
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

test('a CPU seat can be added to an online game and plays for itself', async () => {
  const store = memoryStore();
  const ana = (await handleAction(store, { action: 'create', name: 'Ana' })).data;
  const added = await handleAction(store, {
    action: 'addcpu', id: ana.id, playerId: 0, token: ana.token,
  });
  assert.equal(added.status, 200);
  const cpu = added.data.game.players[1];
  assert.ok(cpu.isCpu);
  assert.match(cpu.name, /Robo/);
  // Turn-based by default: it is still Ana's move, so the robot waits.
  assert.equal(added.data.game.turnId, 0);
  assert.equal(added.data.game.cells.length, 0);
  // Nobody can act as the CPU: it has no token.
  const bad = await handleAction(store, {
    action: 'move', id: ana.id, playerId: 1, token: 'x',
    move: { type: 'mutate', x: 0, y: 0, letter: 'q' },
  });
  assert.equal(bad.status, 403);
  // Unauthenticated users can't add CPUs either.
  const anon = await handleAction(store, { action: 'addcpu', id: ana.id, playerId: 0, token: 'nope' });
  assert.equal(anon.status, 403);
});

test('stacking and calling a new day both travel over the wire', async () => {
  const store = memoryStore();
  const { ana, ben } = await setupGame(store);
  await rigRack(store, ana.id, 0, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  await handleAction(store, {
    action: 'move', id: ana.id, playerId: 0, token: ana.token,
    move: {
      type: 'place',
      tiles: [{ x: 0, y: 0, letter: 'c' }, { x: 1, y: 0, letter: 'a' }, { x: 2, y: 0, letter: 't' }],
    },
  });

  // Ben writes over the A, keeping the points rather than the letter.
  await rigRack(store, ana.id, 1, ['o', 'e', 'e', 'e', 'e', 'e', 'e']);
  const stacked = await handleAction(store, {
    action: 'move', id: ana.id, playerId: 1, token: ben.token,
    move: { type: 'stack', stacks: [{ x: 1, y: 0, letter: 'o' }] },
  });
  assert.equal(stacked.status, 200);
  assert.deepEqual(stacked.data.result.words, ['cot']);
  assert.equal(stacked.data.result.points, 5);
  assert.deepEqual(stacked.data.result.gave, ['a']);

  // Only the admin can call the day, and it banks the scores.
  const refused = await handleAction(store, {
    action: 'move', id: ana.id, playerId: 1, token: ben.token, move: { type: 'newDay' },
  });
  assert.equal(refused.status, 400);
  const day = await handleAction(store, {
    action: 'move', id: ana.id, playerId: 0, token: ana.token, move: { type: 'newDay' },
  });
  assert.equal(day.status, 200);
  assert.equal(day.data.game.day, 2);
  assert.deepEqual(day.data.result.winners, ['Ana']);
  assert.equal(day.data.game.players[0].score, 0);
});

test('the admin can delete a game outright; nobody else can', async () => {
  const store = memoryStore();
  const { ana, ben } = await setupGame(store);

  // Ben runs nothing, so his request is refused.
  const refused = await handleAction(store, {
    action: 'delete', id: ana.id, playerId: 1, token: ben.token,
  });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /only the game admin/);

  // The admin's request removes the record for good...
  const gone = await handleAction(store, {
    action: 'delete', id: ana.id, playerId: 0, token: ana.token,
  });
  assert.equal(gone.status, 200);
  assert.equal(gone.data.deleted, ana.id);

  // ...so everyone else's next poll reads the game as expired.
  const after = await handleAction(store, {
    action: 'state', id: ana.id, playerId: 1, token: ben.token,
  });
  assert.equal(after.status, 404);
});

test('mygames says which tables are yours to run', async () => {
  const store = memoryStore();
  const sess = (await handleAction(store, {
    action: 'signup', name: 'Ana', passphrase: 'long enough pass',
  })).data;
  const made = (await handleAction(store, {
    action: 'create', name: 'Ana', accountToken: sess.accountToken,
  })).data;
  const mine = (await handleAction(store, {
    action: 'mygames', accountToken: sess.accountToken,
  })).data;
  const card = mine.games.find((g) => g.id === made.id);
  assert.equal(card.admin, true, 'the creator runs the table');
});
