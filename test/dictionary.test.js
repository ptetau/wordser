import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dictionary, loadBundledDictionary } from '../src/engine/dictionary.js';

test('dictionary lookups are case-insensitive', () => {
  const d = new Dictionary(['Cat', 'DOG']);
  assert.ok(d.has('cat'));
  assert.ok(d.has('CAT'));
  assert.ok(d.has('dog'));
  assert.ok(!d.has('cow'));
});

test('the bundled word list loads and looks sane', async () => {
  const d = await loadBundledDictionary();
  assert.ok(d.size > 200_000);
  assert.ok(d.has('cat'));
  assert.ok(d.has('quixotic'));
  assert.ok(!d.has('qzxv'));
});
