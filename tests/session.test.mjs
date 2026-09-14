import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, verifySession, sessionCookieHeader, readCookie } from '../worker/src/session.js';

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
