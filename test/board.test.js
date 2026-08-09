import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/engine/board.js';

function put(board, x, y, letters, dir = 'h') {
  for (let i = 0; i < letters.length; i++) {
    board.set(x + (dir === 'h' ? i : 0), y + (dir === 'v' ? i : 0), { letter: letters[i] });
  }
}

test('wordThrough finds the maximal run', () => {
  const b = new Board();
  put(b, -2, 0, 'cat');
  assert.equal(b.wordThrough(-1, 0, 'h').word, 'cat');
  assert.equal(b.wordThrough(-1, 0, 'h').cells[0].x, -2);
  assert.equal(b.wordThrough(-1, 0, 'v').word, 'a');
  assert.equal(b.wordThrough(5, 5, 'h'), null);
});

test('blanks read as their assigned letter', () => {
  const b = new Board();
  b.set(0, 0, { letter: 'c' });
  b.set(1, 0, { isBlank: true, as: 'a' });
  b.set(2, 0, { letter: 't' });
  assert.equal(b.wordThrough(0, 0, 'h').word, 'cat');
});

test('allWords lists each maximal word once', () => {
  const b = new Board();
  put(b, 0, 0, 'cat');
  put(b, 0, 0, 'cot', 'v');
  const words = b.allWords().map((w) => w.word).sort();
  assert.deepEqual(words, ['cat', 'cot']);
});
