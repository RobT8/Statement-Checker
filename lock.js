/*
 * Statement Check — app lock.
 *
 * The 6-digit code is not just a gate: it's stretched into an AES-256 key
 * (PBKDF2-SHA256, 600,000 rounds, random salt) and everything the app stores
 * is encrypted with it. Without the code the saved data is unreadable, and a
 * wrong code is detected because AES-GCM refuses to decrypt.
 *
 * Uses the browser's built-in Web Crypto; the same code runs under Node for
 * the tests.
 */
(function (root) {
  'use strict';

  const subtle = root.crypto && root.crypto.subtle;
  const ITERATIONS = 600000;
  const MAX_FREE_TRIES = 5;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s);
  }

  function fromB64(str) {
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  }

  function randomSalt() {
    return toB64(root.crypto.getRandomValues(new Uint8Array(16)));
  }

  async function deriveKey(code, saltB64, iterations) {
    const base = await subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: fromB64(saltB64), iterations: iterations || ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function encryptText(key, text) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return { v: 1, iv: toB64(iv), ct: toB64(ct) };
  }

  // Throws if the key is wrong (or the data was tampered with).
  async function decryptText(key, blob) {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
    return dec.decode(pt);
  }

  // Codes anyone would try first: one digit repeated, or a run up or down.
  function isWeakCode(code) {
    if (!/^\d{6}$/.test(code)) return true;
    if (/^(\d)\1{5}$/.test(code)) return true;
    const d = code.split('').map(Number);
    const up = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10);
    const down = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
    return up || down;
  }

  // After 5 wrong codes, wait 30s, then double each time, up to 15 minutes.
  function lockoutMs(fails) {
    if (fails < MAX_FREE_TRIES) return 0;
    return Math.min(15 * 60 * 1000, 30000 * Math.pow(2, fails - MAX_FREE_TRIES));
  }

  const api = { ITERATIONS, MAX_FREE_TRIES, randomSalt, deriveKey, encryptText, decryptText, isWeakCode, lockoutMs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LOCK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
