// Orchestration des scrapers AIS tiers : déclenché à chaque nouvelle position YB de Mapei
// avec un délai aléatoire (jitter) pour éviter tout pattern régulier détectable.
// Hors course (pas de nouvelles positions YB), AUCUN scrape n'est lancé.
//
// Un scraper est un objet { name: string, runOnce: async () => count? }
// runOnce fait UN fetch externe et push les résultats dans store.appendAisPosition / updateAisStatic.
import { makeLogger } from './logger.js';

const log = makeLogger('trigger');

export function startScraperTrigger({ store, scrapers, minDelayMs = 30_000, maxDelayMs = 120_000 }) {
  let pending = null;
  let running = false;

  async function fire() {
    pending = null;
    if (running) return;            // sécurité : pas de chevauchement
    running = true;
    try {
      for (const s of scrapers) {
        try {
          const t0 = Date.now();
          const n = await s.runOnce();
          log.info(`[${s.name}] ${n ?? '?'} cibles en ${Date.now() - t0} ms`);
        } catch (e) {
          log.warn(`[${s.name}] échec : ${e.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  function schedule(reason = 'newBoatPosition') {
    if (pending) return;            // debounce : déjà planifié
    if (scrapers.length === 0) return;
    const delay = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
    log.info(`Scrape planifié dans ${Math.round(delay / 1000)} s (trigger : ${reason})`);
    pending = setTimeout(fire, delay);
  }

  store.events.on('newBoatPosition', () => schedule('newBoatPosition'));

  // Bootstrap : si une position YB existe déjà au démarrage, planifier un scrape initial
  if (store.lastBoatPosition()) schedule('bootstrap');

  return () => {
    if (pending) { clearTimeout(pending); pending = null; }
  };
}
