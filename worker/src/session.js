const MAX_AGE_S = 30 * 24 * 3600;
const enc = new TextEncoder();

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(nBytes) {
  const a = new Uint8Array(nBytes); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function issueSession(secret, nowMs = Date.now()) {
  const clientId = randomHex(8);
  const exp = nowMs + MAX_AGE_S * 1000;
  return `${clientId}.${exp}.${await hmac(secret, `${clientId}.${exp}`)}`;
}
export async function verifySession(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return { ok: false };
  const [clientId, expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!clientId || !sig || !Number.isFinite(exp) || exp < nowMs) return { ok: false };
  const expected = await hmac(secret, `${clientId}.${exp}`);
  return safeEqual(sig, expected) ? { ok: true, clientId } : { ok: false };
}
export function sessionCookieHeader(token) {
  return `sess=${token}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}
export function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
export { safeEqual };
