export function authConfig(env) {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || /CHANGE_ME/i.test(secret)) {
    throw new Error('Session authentication requires a random SESSION_SECRET of at least 32 characters.');
  }
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { throw new Error('APP_ORIGIN must be an absolute browser origin.'); }
  const secure = env.NODE_ENV !== 'development';
  if (origin.origin !== env.APP_ORIGIN || origin.username || origin.password
      || (origin.protocol !== 'https:' && !(env.NODE_ENV === 'development'
        && origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))) {
    throw new Error('APP_ORIGIN must be HTTPS, or localhost HTTP in development, with no path.');
  }
  return Object.freeze({ secret, origin: origin.origin, secure,
    cookieName: secure ? '__Host-fi_session' : 'fi_session',
    lifetimeSeconds: 8 * 60 * 60, idleSeconds: 30 * 60,
    loginWindowSeconds: 15 * 60, ipAttempts: 30, usernameAttempts: 10,
  });
}

export function readSessionToken(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return null;
  const matches = header.split(';').map(p => p.trim()).filter(p => p.split('=',1)[0] === name);
  if (matches.length !== 1) return null;
  const token = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
export function sessionCookie(config, token, clear = false) {
  return `${config.cookieName}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : config.lifetimeSeconds}${config.secure ? '; Secure' : ''}`;
}
export function sameOriginRequest(req, config, mutation = false) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (mutation && origin !== config.origin) return false;
  if (origin !== undefined && origin !== config.origin) return false;
  return true;
}
