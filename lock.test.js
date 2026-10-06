const test = require('node:test');
const assert = require('node:assert/strict');
const LOCK = require('./lock.js');

// Fewer rounds than the app uses, to keep the tests quick.
const FAST = 1000;

test('data encrypted with a code comes back with the same code', async () => {
  const salt = LOCK.randomSalt();
  const key = await LOCK.deriveKey('482913', salt, FAST);
  const blob = await LOCK.encryptText(key, JSON.stringify({ txns: [{ desc: 'TESCO STORES', amount: -12.5 }] }));
  assert.ok(!blob.ct.includes('TESCO') && !Buffer.from(blob.ct, 'base64').toString().includes('TESCO'), 'stored form is not readable');
  const again = await LOCK.deriveKey('482913', salt, FAST);
  assert.deepEqual(JSON.parse(await LOCK.decryptText(again, blob)), { txns: [{ desc: 'TESCO STORES', amount: -12.5 }] });
});

test('a wrong code cannot decrypt', async () => {
  const salt = LOCK.randomSalt();
  const blob = await LOCK.encryptText(await LOCK.deriveKey('482913', salt, FAST), 'secret');
  await assert.rejects(LOCK.decryptText(await LOCK.deriveKey('482914', salt, FAST), blob));
});

test('the same data and code never encrypt the same way twice', async () => {
  const key = await LOCK.deriveKey('482913', LOCK.randomSalt(), FAST);
  const a = await LOCK.encryptText(key, 'same');
  const b = await LOCK.encryptText(key, 'same');
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(LOCK.randomSalt(), LOCK.randomSalt());
});

test('obvious codes are refused', () => {
  for (const c of ['000000', '111111', '123456', '654321', '789012', '12345', 'abcdef']) assert.ok(LOCK.isWeakCode(c), c);
  for (const c of ['482913', '102938', '112233', '135790']) assert.ok(!LOCK.isWeakCode(c), c);
});

test('wrong guesses slow down: free tries, then 30s doubling to a 15 minute cap', () => {
  assert.deepEqual([0, 4, 5, 6, 7, 20].map(LOCK.lockoutMs), [0, 0, 30000, 60000, 120000, 900000]);
});
