# Bogi Tracker

Tracker web interne pour l'équipe Allagrande Mapei (IMOCA 60).
Affiche la position et la trace du bateau (source Yellow Brick), les cibles AIS dans un rayon configurable, un overlay vent Windy interactif, et un **routage prévisionnel 10 h** basé sur une polaire reconstruite à partir des points historiques + forecast ECMWF.

Service privé, ~10–20 utilisateurs internes, mot de passe partagé.

---

## Fonctionnalités

- **Trace bateau** colorée selon la vitesse (gradient Turbo, resserré sur la plage 15–30 kn typique IMOCA).
- **Marqueur bateau** orienté selon le cap, ombre portée, plein écran sur la base Windy Map Forecast.
- **Points YB cliquables** : popup avec vitesse, cap, vent (TWA/TWD/TWS si backfill dispo), altitude, timestamp UTC.
- **Cibles AIS** dans un rayon de 100 NM, double source :
  - **aisstream.io** (WebSocket, bbox dynamique recentrée sur Mapei) — meilleur pour le live.
  - **MarineTraffic** scrapé via Playwright headless + plugin stealth (Cloudflare bypass), déclenché 30–120 s après chaque nouveau point YB.
  - Fade visuel des marqueurs selon l'âge du dernier report (vert <15 min, orange <1 h, rouge sinon).
- **Extrapolation +1 h / +5 h / +10 h** :
  - **Ligne droite rouge** (cap et vitesse constants depuis le dernier YB).
  - **Routage polaire bleu** (TWA constant, polaire Mapei, forecast ECMWF IFS 0.25°).
- **Curseur Windy synchronisé** : badge orange "@HH:MM" qui suit la timeline Windy et affiche la position projetée à l'heure de la prévision sélectionnée. En passé, rewind vers le point YB historique le plus proche, avec vent réel (backfill Open-Meteo). En futur, position du routage polaire + TWA/TWD/TWS/BSP/Cap à ce point.
- **Polaire Mapei** reconstruite en continu : pour chaque point YB, on récupère le vent historique via Open-Meteo Archive (ERA5), on calcule TWA/TWS, on agrège par bins (TWA 10°, TWS 2 kn, médiane boatSpeed).
- **Menu collapsible** sur desktop et mobile : toggles AIS, points YB, extrapolations, bouton Recentrer + Aide.
- **Mode classique caché** (flag localStorage) pour retomber sur l'ancienne extrapolation seule sans la polaire, au cas où.
- **Auth simple** : mot de passe partagé, page de login, cookie de session HttpOnly (comparaison timing-safe).

---

## Stack

- **Backend** : Node.js ≥ 20, Express 4, `ws`, `dotenv`, `playwright-extra` + `puppeteer-extra-plugin-stealth` pour le scraping AIS.
- **Frontend** : Leaflet **1.4.0** (version imposée par Windy), Windy Plugin Map Forecast (`libBoot.js`), aucun framework JS, vanilla DOM.
- **Persistance** : JSON sur disque (trace bateau, point details, polaire wind backfill). Pas de DB. AIS en mémoire seule (fenêtre glissante).
- **Auth** : cookie de session HttpOnly, mot de passe partagé.
- **Météo** : Windy Embed API (display), Open-Meteo Archive (backfill historique ERA5), Open-Meteo Forecast (routage `ecmwf_ifs025`).
- **Exposition** : Cloudflare Tunnel (subdomain dédié, pas de port forwarding).

---

## Architecture

```
                    ┌──────────────────────┐
                    │  Yellow Brick API    │
                    │  (positions Mapei)   │
                    └──────────┬───────────┘
                               │ poll 10 min
                               ▼
┌────────────┐         ┌───────────────┐         ┌──────────────────┐
│ aisstream  │ ──ws──▶ │  store        │ ◀────── │  MarineTraffic    │
│ (bbox)     │         │  (events bus) │  scrape │  Playwright+stealth│
└────────────┘         │               │         └──────────────────┘
                       │  - boat track │
                       │  - ais window │
                       │  - point      │         ┌──────────────────┐
                       │    details    │ ◀────── │  Open-Meteo       │
                       │    + wind     │ backfill│  Archive (ERA5)   │
                       └──────┬────────┘         └──────────────────┘
                              │
                              │ events: newBoatPosition
                              ▼
                       ┌──────────────┐          ┌──────────────────┐
                       │ refreshRoute │ ───────▶ │ Open-Meteo        │
                       │ (TWA const)  │ forecast │ Forecast ECMWF    │
                       └──────┬───────┘          └──────────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │  cachedRoute │
                       └──────┬───────┘
                              │
                              ▼
                    ┌──────────────────────┐
                    │  Express HTTP API    │
                    │  + cookie auth       │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Frontend Leaflet +  │
                    │  Windy Map Forecast  │
                    └──────────────────────┘
```

---

## Arborescence

```
bogi-tracker/
├── server.js                    # Express, montage des pollers/scrapers, route compute en arrière-plan
├── package.json
├── .env.example                 # template (à copier en .env)
├── .gitignore
├── lib/
│   ├── config.js                # chargement et validation .env
│   ├── auth.js                  # auth password + cookie de session (timing-safe)
│   ├── store.js                 # état mémoire + persistance JSON atomique + EventEmitter
│   ├── yb.js                    # poller Yellow Brick + enricher pointDetails
│   ├── ais.js                   # client WebSocket aisstream.io (bbox dynamique)
│   ├── ais-marinetraffic.js     # scraper Playwright headless + stealth
│   ├── scraper-trigger.js       # trigger scrapers AIS sur newBoatPosition (jitter 30-120s)
│   ├── wind-backfill.js         # remplit pointDetails[id].wind via Open-Meteo Archive
│   ├── polar.js                 # construit polaire {TWA, TWS, médiane BSP} depuis points enrichis
│   ├── routing.js               # route TWA constant via Open-Meteo Forecast (ECMWF IFS 0.25°)
│   └── logger.js                # logger console namespacé
├── data/                        # créé au runtime, gitignored (boat.json, point-details.json)
├── views/
│   ├── login.html
│   └── app.html                 # page principale (Windy + Leaflet)
├── public/
│   ├── app.js                   # logique frontend (rendu trace, extrap, AIS, routage, curseur Windy)
│   ├── style.css
│   └── favicon.svg
└── systemd/
    └── bogi-tracker.service     # unit systemd (template, adapter User/WorkingDirectory)
```

---

## Endpoints HTTP

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/` | ✓ | Page Leaflet/Windy (redirige vers `/login` si non authentifié) |
| GET | `/login` | — | Page de saisie du mot de passe |
| POST | `/login` | — | Vérifie le mot de passe, pose le cookie de session |
| POST | `/logout` | — | Efface le cookie |
| GET | `/api/state` | ✓ | Snapshot complet (boat track + AIS filtré dans le rayon) |
| GET | `/api/track-details` | ✓ | Détails de tous les points YB (vitesse, cap, vent backfill) |
| GET | `/api/yb-point/:id` | ✓ | Détail d'un point YB par id (cache puis fetch à la demande) |
| GET | `/api/polar` | ✓ | Polaire Mapei agrégée depuis les points YB enrichis |
| GET | `/api/route` | ✓ | Route prévisionnelle 10 h (recalculée à chaque nouveau YB) |
| GET | `/api/ais-debug` | ✓ | Tous les AIS reçus sans filtre, triés par distance à Mapei |
| GET | `/api/windy-key` | ✓ | Clé Windy (pour le plugin frontend) |
| GET | `/healthz` | — | Statut serveur (`lastBoatAt`, `ageMs`) |

---

## Variables d'environnement

Voir [.env.example](./.env.example). Variables obligatoires :

- `LOGIN_PASSWORD` — mot de passe d'accès (partagé équipage).
- `AISSTREAM_KEY` — clé aisstream.io (free tier suffisant).
- `WINDY_KEY` — clé Windy Map Forecast API.

Variables ajustables :

- `YB_KEYWORD`, `YB_EVENT`, `YB_POLL_MS` — source Yellow Brick.
- `AIS_RADIUS_NM` (def. 50) — rayon de filtrage AIS côté serveur (l'abonnement WS est plus large pour compenser le throttle aisstream).
- `AIS_TRACK_WINDOW_MS` (def. 30 min) — fenêtre glissante pour la mémoire AIS.
- `BOAT_SAVE_MS`, `DATA_DIR`, `LOG_LEVEL`, `PORT`, `BIND`.

---

## Installation locale (dev)

Prérequis : Node ≥ 20.

```powershell
cd C:\tmp\bogi-tracker
npm install
copy .env.example .env
notepad .env   # remplir LOGIN_PASSWORD, AISSTREAM_KEY, WINDY_KEY
npm run dev    # node --watch server.js
```

Ouvrir <http://127.0.0.1:3000>, saisir le mot de passe.

> **Note Playwright** : `playwright-core` est inclus, mais pas le binaire Chromium. Pour activer le scraping MarineTraffic en local, installer Chromium séparément (`/usr/bin/chromium` sur Linux est détecté). En son absence, le code skip silencieusement les scrapers headless — le reste du tracker fonctionne (aisstream + YB + Windy + routage).

---

## Déploiement (Raspberry Pi)

Cible recommandée : **Pi 5 (4 ou 8 GB)** sous Debian Trixie 13 ou Bookworm. Le projet a tourné en prod sur Pi Zero 2W (cf. limites plus bas), mais le Pi 5 est largement plus confortable, notamment avec le scraping headless Playwright.

### 1. Copier le projet

```bash
# Depuis le poste de dev (adapter user@host à votre cible)
scp -r ./bogi-tracker user@pi:/home/user/
ssh user@pi
```

### 2. Dépendances

```bash
cd ~/bogi-tracker
npm install --omit=dev

# Pour le scraping MarineTraffic (optionnel)
sudo apt install -y chromium

cp .env.example .env
nano .env   # remplir LOGIN_PASSWORD, AISSTREAM_KEY, WINDY_KEY
```

### 3. Systemd

Le template [`systemd/bogi-tracker.service`](./systemd/bogi-tracker.service) est à adapter (User, WorkingDirectory, EnvironmentFile, MemoryMax).

```bash
sudo cp systemd/bogi-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bogi-tracker
sudo systemctl status bogi-tracker
journalctl -u bogi-tracker -f   # suivre les logs
```

### 4. Exposition (Cloudflare Tunnel recommandé)

Sur Cloudflare Zero Trust → Networks → Tunnels → votre tunnel → Public Hostnames, ajouter une route vers `http://127.0.0.1:3000`. Pas de port forwarding, le Pi reste injoignable directement depuis Internet.

---

## Choix de design

- **Pas de DB** : déploiement léger. La trace bateau (point toutes les 10–15 min) fait < 1 Mo de JSON sur une année.
- **AIS en mémoire seule** : fenêtre glissante (30 min par défaut). La plupart des cibles ne pingent qu'une fois pendant le passage en bbox. Au reboot, le flux WS rebuild.
- **Bbox AIS dynamique** : recentrée à chaque update YB, rayon par défaut 50 NM (le filtre client est à 100 NM, le sur-abonnement compense le throttle aisstream sur les petites bbox).
- **Double source AIS (aisstream + MarineTraffic scrapé)** : aisstream est gratuit mais incomplet et throttlé ; MT comble les trous. Le scraper utilise un profil persistant Chromium (cf_clearance), UA/viewport/zoom/centre randomisés, mouse moves et drag-pan organiques pour passer Cloudflare Bot Management.
- **Routage TWA constant** : approximation grossière (pas de manœuvres, pas de courant, polaire reconstruite à partir des points YB enrichis, pas de polaire constructeur). Indication, pas une vraie route optimisée. Refaite en arrière-plan à chaque nouveau point YB, avec queue chaining si un compute est déjà in-flight (pour garantir que la route finale soit toujours basée sur le dernier YB).
- **Modèle météo ECMWF IFS 0.25°** (`ecmwf_ifs025` côté Open-Meteo) — cohérent avec l'overlay Windy par défaut. `ecmwf_ifs04` est déprécié et renvoie null partout.
- **Interpolation vent linéaire** entre les heures Open-Meteo, avec composantes vectorielles unitaires (sin/cos) pour gérer le wrap-around 359°→1°.
- **Persistance atomique** : `tmp → fsync → rename` pour éviter les fichiers tronqués en cas de coupure.
- **Auth single-password** : volontaire, audience interne et fermée. Mot de passe stocké dans `.env`, comparaison timing-safe.

---

## Limites connues

- **Routage TWA constant** : ce n'est pas un router optimisé. Il faut le voir comme une projection "si Mapei tient son angle au vent actuel et que le vent évolue selon ECMWF, où sera-t-il". Pas de gestion des manœuvres ni du courant.
- **Polaire bruitée** : reconstruite depuis l'historique réel du bateau, donc dépend de la couverture conditions/angles. Meilleure au fil du temps.
- **Cible Pi Zero 2W** : possible mais RAM tendue (~140 MB libres avec d'autres services), `MemoryMax=120M` dans le unit. Scraping headless **incompatible** Pi Zero (Chromium trop lourd). Migrer sur Pi 5 dès que possible.
- **Windy iframe** : interaction limitée à ce que l'API publique expose. Plus complet via le plugin Map Forecast utilisé ici, mais on reste dépendant de leurs hooks (`broadcast`, `timestamp`).
- **aisstream free tier** : throttle progressif sur les abonnements bbox larges, d'où la stratégie double-source.

---

## Historique

- **v1** — base Leaflet + iframe Windy + aisstream uniquement.
- **v2** — migration sur Windy Map Forecast (plugin natif), curseur timeline, extrapolation +1/+5/+10 h.
- **v3** — scraping MarineTraffic en complément (×3 sur la couverture AIS observée).
- **v4** — wind-backfill Open-Meteo, polaire Mapei, routage TWA constant + ECMWF forecast.
- **v4.1** — popups standardisées labels sailing (TWA / TWD / TWS / BSP / Cap / heure UTC / mention ECMWF).

Migration prod Pi Zero 2W → Pi 5 effectuée en mai 2026 pour supporter le scraping headless.

---

## Auteur

Clément Samon (CSN) — Allagrande Mapei
