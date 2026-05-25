// Authentification par mot de passe seul + cookie de session signé
import crypto from 'node:crypto';

const COOKIE_NAME = 'bogi_auth';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function tokenForPassword(password) {
  // HMAC-SHA256 du mot de passe avec une constante : permet de stocker un token côté client
  // qui n'est pas le mot de passe en clair, et que le serveur peut recalculer pour vérifier.
  return crypto.createHmac('sha256', password).update('bogi-tracker-v1').digest('hex');
}

function parseCookies(header = '') {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createPasswordAuth({ password }) {
  const token = tokenForPassword(password);

  function isAuthed(req) {
    const cookies = parseCookies(req.headers.cookie);
    const cookie = cookies[COOKIE_NAME];
    return !!cookie && safeEqual(cookie, token);
  }

  function setAuthCookie(res) {
    const expires = new Date(Date.now() + COOKIE_MAX_AGE_MS).toUTCString();
    // Secure : exige HTTPS (Cloudflare Tunnel toujours HTTPS, localhost exempté par les navigateurs modernes)
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Expires=${expires}`);
  }

  function clearAuthCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`);
  }

  // Middleware : exige une session valide
  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    if (req.accepts('html')) return res.redirect('/login');
    res.status(401).json({ error: 'Authentication required' });
  }

  // GET /login : si déjà authed, on saute la page
  function loginGet(viewsDir) {
    return (req, res) => {
      if (isAuthed(req)) return res.redirect('/');
      res.sendFile('login.html', { root: viewsDir });
    };
  }

  // POST /login : vérifie le mot de passe, pose le cookie
  function loginPost(req, res) {
    const submitted = (req.body?.password || '').toString();
    const ok = submitted.length === password.length
      && safeEqual(submitted, password);
    if (ok) {
      setAuthCookie(res);
      return res.redirect('/');
    }
    res.redirect('/login?err=1');
  }

  function logout(req, res) {
    clearAuthCookie(res);
    res.redirect('/login');
  }

  return { requireAuth, loginGet, loginPost, logout, isAuthed };
}
