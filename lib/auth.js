// Middleware Basic Auth avec comparaison à temps constant
import crypto from 'node:crypto';

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function basicAuth({ user, pass, realm = 'bogi-tracker' }) {
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ') && safeEqual(header, expected)) return next();
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).send('Authentication required');
  };
}
