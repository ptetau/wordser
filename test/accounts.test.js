import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAction, memoryStore } from '../api/game.js';
import { signUp, signIn, whoIs, AuthError } from '../api/accounts.js';

const act = (store, body) => handleAction(store, body);

test('an account can be made, and the passphrase is never stored', async () => {
  const store = memoryStore();
  const r = await act(store, { action: 'signup', name: 'Ada', passphrase: 'lovelace1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.account, 'Ada');
  assert.ok(r.data.accountToken.length >= 32);

  const stored = await store.get('wordser:user:ada');
  assert.ok(stored.hash && stored.salt);
  assert.equal(JSON.stringify(stored).includes('lovelace1'), false, 'the passphrase leaked');
});

test('short passphrases and taken names are refused', async () => {
  const store = memoryStore();
  const short = await act(store, { action: 'signup', name: 'Ada', passphrase: 'abc' });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /at least 8/);

  await act(store, { action: 'signup', name: 'Ada', passphrase: 'lovelace1' });
  const again = await act(store, { action: 'signup', name: '  ada  ', passphrase: 'another1' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /taken/);
});

test('signing in needs the right passphrase, whatever the case of the name', async () => {
  const store = memoryStore();
  await act(store, { action: 'signup', name: 'Ada', passphrase: 'lovelace1' });

  const wrong = await act(store, { action: 'signin', name: 'Ada', passphrase: 'nope12345' });
  assert.equal(wrong.status, 403);
  const nobody = await act(store, { action: 'signin', name: 'Ghost', passphrase: 'whatever1' });
  assert.equal(nobody.status, 403);
  assert.equal(nobody.data.error, wrong.data.error, 'a missing account must look like a wrong one');

  const right = await act(store, { action: 'signin', name: 'ADA', passphrase: 'lovelace1' });
  assert.equal(right.status, 200);
  assert.equal(right.data.account, 'Ada');
});

test('a session token names its account until it is signed out', async () => {
  const store = memoryStore();
  const { accountToken } = (await act(store, {
    action: 'signup', name: 'Ada', passphrase: 'lovelace1',
  })).data;
  assert.equal((await whoIs(store, accountToken)).name, 'Ada');
  assert.equal(await whoIs(store, 'not-a-token'), null);
  await act(store, { action: 'signout', accountToken });
  assert.equal(await whoIs(store, accountToken), null);
});

test('a game follows you to another device', async () => {
  const store = memoryStore();
  const { accountToken } = (await act(store, {
    action: 'signup', name: 'Ada', passphrase: 'lovelace1',
  })).data;

  // The sofa: create a game while signed in.
  const made = (await act(store, { action: 'create', name: 'Ada', accountToken })).data;
  assert.equal(made.you, 0);

  // The bus: a device that has never seen this game, holding only the
  // account token, can still read and play the seat.
  const seen = await act(store, { action: 'state', id: made.id, accountToken });
  assert.equal(seen.status, 200);
  assert.equal(seen.data.you, 0);
  assert.ok(seen.data.game.players[0].rack.every((l) => l !== '?'), 'own rack should be visible');

  // And it turns up in the list of games.
  const mine = await act(store, { action: 'mygames', accountToken });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.games.map((g) => g.id), [made.id]);
  assert.equal(mine.data.games[0].you, 'Ada');
  assert.equal(mine.data.games[0].yourTurn, true);
});

test('rejoining a game you are already in takes your seat back', async () => {
  const store = memoryStore();
  const { accountToken } = (await act(store, {
    action: 'signup', name: 'Ada', passphrase: 'lovelace1',
  })).data;
  const made = (await act(store, { action: 'create', name: 'Ada', accountToken })).data;
  const rejoin = await act(store, {
    action: 'join', id: made.id, name: 'Ada on the bus', accountToken,
  });
  assert.equal(rejoin.status, 200);
  assert.equal(rejoin.data.you, 0, 'should be the same seat');
  assert.equal(rejoin.data.game.players.length, 1, 'and not a second one');
});

test('somebody else\'s token gets them nowhere', async () => {
  const store = memoryStore();
  const ada = (await act(store, { action: 'signup', name: 'Ada', passphrase: 'lovelace1' })).data;
  const bob = (await act(store, { action: 'signup', name: 'Bob', passphrase: 'bobbob123' })).data;
  const made = (await act(store, {
    action: 'create', name: 'Ada', accountToken: ada.accountToken,
  })).data;

  const nosy = await act(store, {
    action: 'state', id: made.id, accountToken: bob.accountToken,
  });
  assert.equal(nosy.status, 403);

  const list = await act(store, { action: 'mygames', accountToken: bob.accountToken });
  assert.deepEqual(list.data.games, []);
});

test('which account a seat belongs to never leaves the server', async () => {
  const store = memoryStore();
  const { accountToken } = (await act(store, {
    action: 'signup', name: 'Ada', passphrase: 'lovelace1',
  })).data;
  const made = (await act(store, { action: 'create', name: 'Ada', accountToken })).data;
  assert.equal('account' in made.game.players[0], false);
  const state = (await act(store, { action: 'state', id: made.id, accountToken })).data;
  assert.equal('account' in state.game.players[0], false);
  // ...but it is on the record, which is how the seat is found again.
  const record = await store.get(`wordser:game:${made.id}`);
  assert.equal(record.game.players[0].account, 'ada');
});

test('playing without an account still works exactly as before', async () => {
  const store = memoryStore();
  const anon = (await act(store, { action: 'create', name: 'Nobody' })).data;
  assert.equal(anon.you, 0);
  const state = await act(store, {
    action: 'state', id: anon.id, playerId: 0, token: anon.token,
  });
  assert.equal(state.status, 200);
});

test('the account helpers refuse nonsense directly', async () => {
  const store = memoryStore();
  await assert.rejects(() => signUp(store, { name: 'A', passphrase: 'longenough1' }), AuthError);
  await assert.rejects(() => signIn(store, { name: 'nobody', passphrase: 'x' }), AuthError);
});
