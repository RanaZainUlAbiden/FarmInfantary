import argon2 from 'argon2';

export const PASSWORD_OPTIONS = Object.freeze({
  type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1,
  hashLength: 32,
});
export function validNewPassword(value) {
  return typeof value === 'string' && [...value].length >= 15
    && [...value].length <= 128 && Buffer.byteLength(value, 'utf8') <= 1024;
}
export function validLoginPassword(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && Buffer.byteLength(value, 'utf8') <= 1024;
}
export async function hashPassword(password) {
  if (!validNewPassword(password)) throw new Error('Use a password of 15 to 128 characters.');
  return argon2.hash(password, PASSWORD_OPTIONS);
}
export async function verifyPassword(hash, password) {
  if (!validLoginPassword(password) || typeof hash !== 'string' || !hash.startsWith('$argon2id$')) return false;
  // Bound work even for a damaged or unexpectedly modified database record.
  // Do not let an encoded cost parameter bypass the process memory limit.
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[2] !== 'v=19') return false;
  const entries = parts[3].split(',').map(p => p.split('='));
  if (entries.length !== 3 || entries.some(([k,v]) => !['m','t','p'].includes(k) || !/^[1-9]\d*$/.test(v))) return false;
  const costs = Object.fromEntries(entries.map(([k,v]) => [k,Number(v)]));
  if (Object.keys(costs).length !== 3 || costs.m < 19_456 || costs.m > 65_536
      || costs.t < 2 || costs.t > 5 || costs.p < 1 || costs.p > 4) return false;
  try { return await argon2.verify(hash, password); } catch { return false; }
}

// Bound native KDF memory use. Excess work is refused, never queued unboundedly.
export function createPasswordWorkLimit(maximum = 4) {
  let active = 0;
  return async function passwordWork(work) {
    if (active >= maximum) return { busy: true };
    active++;
    try { return { value: await work() }; } finally { active--; }
  };
}
