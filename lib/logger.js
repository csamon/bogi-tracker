// Logger console avec timestamps ISO et niveaux
const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const current = levels[process.env.LOG_LEVEL || 'info'] ?? 2;

function ts() { return new Date().toISOString(); }
function fmt(level, scope, msg, extra) {
  let suffix = '';
  if (extra !== undefined) {
    if (extra instanceof Error) suffix = ' ' + (extra.stack || extra.message);
    else if (typeof extra === 'string') suffix = ' ' + extra;
    else suffix = ' ' + JSON.stringify(extra);
  }
  return `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${suffix}`;
}

export function makeLogger(scope) {
  return {
    error: (msg, extra) => { if (current >= 0) console.error(fmt('error', scope, msg, extra)); },
    warn:  (msg, extra) => { if (current >= 1) console.warn(fmt('warn',  scope, msg, extra)); },
    info:  (msg, extra) => { if (current >= 2) console.log(fmt('info',  scope, msg, extra)); },
    debug: (msg, extra) => { if (current >= 3) console.log(fmt('debug', scope, msg, extra)); },
  };
}
