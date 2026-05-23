# Bogi Tracker

Tracker web interne pour l'équipe Allagrande Mapei. Affiche la position et la trace du bateau (source Yellow Brick), les cibles AIS dans un rayon de 50 NM, et un overlay vent Windy.

Hébergé sur le Raspberry Pi Zero 2W `backup-db`, exposé via Cloudflare Tunnel. ~20 utilisateurs internes, mot de passe partagé défini dans `.env` (non commité).

## Stack

- **Backend** : Node.js 20+, Express, `ws`, `dotenv`
- **Frontend** : Leaflet 1.4.0 vanilla, pas de framework
- **Persistance** : fichier JSON sur disque pour la trace bateau, mémoire seule pour l'AIS (fenêtre glissante 30 min)
- **Auth** : page de login dédiée + cookie de session HttpOnly (mot de passe partagé, pas de user)

## Arborescence

```
bogi-tracker/
├── server.js              # Express, montage des pollers, shutdown propre
├── package.json
├── .env.example           # template (copier en .env, remplir les clés)
├── .gitignore
├── lib/
│   ├── config.js          # chargement et validation .env
│   ├── auth.js            # auth mot de passe + cookie de session (timing-safe)
│   ├── store.js           # état mémoire + persistance JSON atomique
│   ├── yb.js              # poller Yellow Brick (10 min)
│   ├── ais.js             # client WebSocket aisstream.io (bbox dynamique)
│   └── logger.js          # logger console
├── data/                  # créé au runtime, gitignored (boat.json)
├── views/
│   ├── login.html         # page de login
│   └── app.html           # page principale (carte Leaflet)
├── public/
│   ├── app.js
│   └── style.css
└── systemd/
    └── bogi-tracker.service
```

## Installation locale (dev)

```powershell
cd C:\tmp\bogi-tracker
npm install
copy .env.example .env
notepad .env   # remplir AISSTREAM_KEY et WINDY_KEY
npm run dev    # node --watch server.js
```

Puis ouvrir <http://127.0.0.1:3000>, saisir le mot de passe défini dans `.env`.

## Déploiement sur backup-db (Pi Zero 2W)

### 1. Copier le projet

```bash
# Depuis le laptop, avec SSH par clé déjà configurée
scp -P 47832 -r C:\tmp\bogi-tracker admin@10.147.17.6:/home/admin/
ssh -p 47832 admin@10.147.17.6
```

### 2. Installer dépendances et configurer

```bash
cd /home/admin/bogi-tracker
npm install --omit=dev
cp .env.example .env
nano .env   # remplir AISSTREAM_KEY (réutilisable depuis ais-windy) et WINDY_KEY
```

### 3. Installer le service systemd

```bash
sudo cp systemd/bogi-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bogi-tracker
sudo systemctl status bogi-tracker
journalctl -u bogi-tracker -f   # suivre les logs
```

### 4. Cloudflare Tunnel — nouvelle route

Sur le dashboard Cloudflare Zero Trust → Networks → Tunnels → tunnel `Mapei1` → Public Hostnames :

1. **Supprimer** la route `ais.uservar.io` (ancien ais-windy)
2. **Ajouter** une nouvelle route :
   - Subdomain : ex. `bogi`
   - Domain : `uservar.io` (ou autre selon disponibilité)
   - Service : `http://127.0.0.1:3000`

Puis vérifier <https://bogi.uservar.io> dans le navigateur.

### Migration depuis ais-windy

ais-windy a déjà été stoppé et supprimé de PM2. Pour finir le ménage côté Pi (optionnel) :

```bash
rm -rf /home/admin/ais-windy   # si on veut récupérer l'espace disque
pm2 list                       # confirme que la liste est vide
```

## Endpoints HTTP

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/` | ✓ | Page Leaflet (redirige vers /login si non authentifié) |
| GET | `/login` | — | Page de saisie du mot de passe |
| POST | `/login` | — | Vérifie le mot de passe, pose le cookie de session |
| POST | `/logout` | — | Efface le cookie |
| GET | `/api/state` | ✓ | Snapshot complet (boat + AIS) |
| GET | `/api/windy-key` | ✓ | Clé Windy (pour l'iframe) |
| GET | `/healthz` | — | Statut serveur (lastBoatAt, ageMs) |

## Variables d'environnement

Voir [.env.example](./.env.example). Les clés `AISSTREAM_KEY` et `WINDY_KEY` doivent être remplies avant lancement, sinon le serveur refuse de démarrer.

## Choix de design

- **Pas de DB** : volonté de garder le déploiement léger. La trace bateau (15 min entre points) fait < 1 Mo de JSON même sur un an d'usage continu.
- **AIS en mémoire seule** : fenêtre 30 min glissante. La plupart des cibles n'envoient qu'un point unique pendant qu'elles passent dans la bbox. Au reboot on rebuild via le flux WebSocket.
- **Bbox AIS dynamique** : recentrée à chaque update YB, rayon par défaut 50 NM. Resub si Mapei dérive de plus d'1/5 du rayon.
- **Refresh client** : 60 s, endpoint unique `/api/state` pour limiter les round-trips.
- **Overlay Windy** : iframe semi-transparent posé sur la carte Leaflet, purement visuel et non interactif. Compromis pour garder une vraie base Leaflet (choix sat / OSM / nautique). Pour une vraie intégration interactive on basculera en mode "Windy Map API" en v2.
- **Persistance atomique** : `tmp → fsync → rename` pour éviter les fichiers tronqués en cas de coupure de courant.

## Limites Pi Zero 2W

La RAM du Pi est tendue (~140 MB libres réels avec le honeypot et Fing). Le service est plafonné à 120 MB via `MemoryMax=120M` dans le unit systemd. Si le tracker se fait killer (OOMKilled), regarder le rapport via `journalctl -u bogi-tracker --since "1 hour ago"`.

Migration future possible sur Pi5 sans modif du code.

## Auteur

Clément Samon (CSN) — Allagrande Mapei
