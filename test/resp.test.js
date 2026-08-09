import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCommand, parseReply } from '../api/resp.js';

test('commands encode as RESP arrays of bulk strings', () => {
  assert.equal(encodeCommand(['GET', 'k']), '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
  assert.equal(encodeCommand(['SET', 'k', 'é']), `*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n`);
});

test('replies parse across all the types the store uses', () => {
  assert.deepEqual(parseReply(Buffer.from('+OK\r\n')), { value: 'OK', next: 5 });
  assert.deepEqual(parseReply(Buffer.from(':42\r\n')), { value: 42, next: 5 });
  assert.deepEqual(parseReply(Buffer.from('$5\r\nhello\r\n')), { value: 'hello', next: 11 });
  assert.deepEqual(parseReply(Buffer.from('$-1\r\n')), { value: null, next: 5 });
  const err = parseReply(Buffer.from('-ERR nope\r\n'));
  assert.equal(err.err, 'ERR nope');
  const arr = parseReply(Buffer.from('*2\r\n$1\r\na\r\n:7\r\n'));
  assert.deepEqual(arr.value, ['a', 7]);
});

test('incomplete buffers return null until the reply is whole', () => {
  assert.equal(parseReply(Buffer.from('$5\r\nhel')), null);
  assert.equal(parseReply(Buffer.from('*2\r\n$1\r\na\r\n')), null);
  assert.equal(parseReply(Buffer.from('+OK')), null);
});

test('consecutive replies parse one at a time', () => {
  const buf = Buffer.from('+OK\r\n:1\r\n');
  const first = parseReply(buf, 0);
  assert.equal(first.value, 'OK');
  const second = parseReply(buf, first.next);
  assert.equal(second.value, 1);
});
