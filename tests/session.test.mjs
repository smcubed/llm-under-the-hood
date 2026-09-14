import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, verifySession, sessionCookieHeader, readCookie, safeEqual, hmac, passcodeMatches } from '../worker/src/session.js';

test('issue then verify round-trips and yields the client id', async () => {
  const tok = await issueSession('s3cret', 1_000_000);
  const v = await verifySession(tok, 's3cret', 1_000_000 + 5);
  assert.equal(v.ok, true); assert.match(v.clientId, /^[0-9a-f]{16}$/);
});
test('rejects expired, tampered, wrong-secret, and garbage tokens', async () => {
  const tok = await issueSession('s3cret', 0);
  assert.equal((await verifySession(tok, 's3cret', 40 * 24 * 3600 * 1000)).ok, false);
  assert.equal((await verifySession(tok.replace(/.$/, c => (c === 'a' ? 'b' : 'a')), 's3cret', 1)).ok, false);
  assert.equal((await verifySession(tok, 'other', 1)).ok, false);
  assert.equal((await verifySession('nope', 's3cret', 1)).ok, false);
  assert.equal((await verifySession(undefined, 's3cret', 1)).ok, false);
});
test('cookie header is HttpOnly, Secure, SameSite=Strict, 30 days', () => {
  const h = sessionCookieHeader('abc');
  assert.match(h, /^sess=abc; /); assert.match(h, /HttpOnly/); assert.match(h, /Secure/); assert.match(h, /SameSite=Strict/); assert.match(h, /Max-Age=2592000/); assert.match(h, /Path=\//);
});
test('readCookie pulls sess out of a Cookie header', () => {
  assert.equal(readCookie('a=1; sess=xyz; b=2', 'sess'), 'xyz');
  assert.equal(readCookie(null, 'sess'), undefined);
});

test('safeEqual: equal strings true; different content, different length, or non-strings false', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('abc', undefined), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual(123, 123), false);
});
test('hmac is deterministic hex and keyed by the secret', async () => {
  const a = await hmac('k', 'msg'), b = await hmac('k', 'msg');
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(await hmac('other', 'msg'), a);
  assert.notEqual(await hmac('k', 'msg2'), a);
});
test('passcodeMatches compares digests so lengths do not leak; matches only the exact passcode', async () => {
  assert.equal(await passcodeMatches('correct horse', 'correct horse', 's'), true);
  assert.equal(await passcodeMatches('wrong', 'correct horse', 's'), false);
  assert.equal(await passcodeMatches('correct horse!', 'correct horse', 's'), false);
  assert.equal(await passcodeMatches('', 'correct horse', 's'), false);
  assert.equal(await passcodeMatches('correct horse', '', 's'), false);
  assert.equal(await passcodeMatches(undefined, 'correct horse', 's'), false);
});
