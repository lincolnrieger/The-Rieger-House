// Same PIN hashing as src/worker.js, for use from Node scripts.
const ITERATIONS = 100_000;
const toHex = (buf) => Buffer.from(buf).toString('hex');

async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

module.exports = { hashPin };
