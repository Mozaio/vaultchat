# VaultChat Deployment — Render & Railway (Free-Tier-Fokus)

Diese Anleitung deckt **zwei** komplett kostenlose Wege ab, ohne Netlify:

- **Weg A — Render** (Server + Client beide auf Render)
- **Weg B — Railway** (Server + Client beide auf Railway, laeuft auf dem $5 Gratis-Trial-Credit)

Die benoetigten Config-Dateien liegen bereits im Repo:
`render.yaml` (Repo-Root), `server/railway.json`.

---

## Vorbereitung (einmalig, fuer beide Wege)

1. Repo auf GitHub pushen (Render/Railway deployen per Repo-Link).
2. Einen JWT-Secret-Wert erzeugen, falls du ihn manuell setzen willst:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   (Render setzt diesen Wert ueber `generateValue: true` automatisch.)

---

## Weg A — Render (empfohlen fuer „einfach und kostenlos")

### Architektur
- `vaultchat-server` → **Web Service (Free)**, Node + WebSocket.
- `vaultchat-client` → **Static Site (Free)**, Vite-Bundle.

Beide laufen unter `*.onrender.com`, der Client wird per Env-Variablen
automatisch mit der Server-URL verdrahtet (siehe `render.yaml`).

### Deploy in 4 Klicks

1. **Render-Konto erstellen** → GitHub verbinden.
2. **Dashboard → „New +" → „Blueprint"** → Repo auswaehlen.
3. Render liest `render.yaml`, legt **beide** Services an, baut und deployt.
4. In der UI die Secrets bestaetigen (JWT\_SECRET wird generiert, TURN-Variablen
   optional leer lassen).

Nach ca. 2–3 Minuten:
- Server: `https://vaultchat-server.onrender.com`
- Client: `https://vaultchat-client.onrender.com`

### WICHTIG — Free-Tier-Eigenheiten bei Render

1. **Web Service Free schlaeft nach 15 Min Inaktivitaet.**
   Das heisst: nach 15 Min ohne Request wird der Node-Prozess gestoppt.
   Beim naechsten Zugriff braucht der Cold-Start ~30 Sek.
   **Konsequenz fuer VaultChat:** Der In-Memory-Store ist leer.
   - Alle eingeloggten User muessen sich **neu einloggen** (JWTs bleiben gueltig,
     aber die serverseitige Online-Routing-Tabelle ist weg → WS neu aufbauen).
   - Nachrichten, die waehrend des Schlafens gesendet werden sollten,
     bleiben in der **Client-Outbox** und werden automatisch nachgesendet,
     sobald beide Peers wieder verbunden sind.

2. **Gegen das Einschlafen — UptimeRobot (gratis) als Pinger:**
   - Konto auf [uptimerobot.com](https://uptimerobot.com) anlegen.
   - **„Add New Monitor" → „HTTP(s)"**
   - URL: `https://vaultchat-server.onrender.com/healthz`
   - Interval: **5 Minuten**
   - Damit bleibt der Dienst dauerhaft wach, Free-Tier faktisch ohne Schlaf.
   (Render toleriert das — es gibt kein Limit auf eingehende Requests.)

3. **Static Site schlaeft nie.** Der Client ist also immer erreichbar,
   unabhaengig vom Server-Status.

4. **Keine Persistenz.** Redeploys und Sleeps wischen den RAM. Das ist Teil
   der Zero-Knowledge-Architektur. Die User-Backup-JSON (Export-Button in der
   AuthPanel) ist die einzige Art, Identitaeten nach einem Redeploy wieder
   zu nutzen. Das ist ein **Feature**, kein Bug.

### Logs & Debugging
- Render UI → Service → **Logs**.
- WebSocket-Traffic siehst du im Browser-DevTools unter **Network → WS**.

---

## Weg B — Railway

### Architektur
- `vaultchat-server` → **Service** aus `server/`-Ordner, Node + WS.
- `vaultchat-client` → **Service** aus `client/`-Ordner, statisch serviert.

Railway hat **keinen** echten Free-Tier mehr — aber einen einmaligen
**$5 Trial-Credit** ohne Ablauf. Fuer eine kleine VaultChat-Instanz reicht
das mehrere Wochen bis Monate, je nach Nutzung. Kein Sleep, keine Wartezeit.

### Deploy-Schritte (Server)

1. **Railway-Konto erstellen**.
2. **New Project → Deploy from GitHub repo** → dein Repo waehlen.
3. Im neuen Service:
   - **Settings → Root Directory** → `server`
   - Railway erkennt `server/railway.json` automatisch.
4. **Variables:**
   ```
   VAULTCHAT_JWT_SECRET   = <openssl rand -hex 32>
   VAULTCHAT_CORS_ORIGIN  = https://<client-railway-domain>   (spaeter setzen)
   VAULTCHAT_TURN_URL     = (optional, nur fuer Calls hinter strikten NATs)
   VAULTCHAT_TURN_USER    = (optional)
   VAULTCHAT_TURN_PASS    = (optional)
   VAULTCHAT_FORCE_RELAY  = (optional, "1" erzwingt Relay-Only)
   ```
5. **Settings → Networking → Generate Domain** → Server-URL notieren,
   z. B. `vaultchat-server-production.up.railway.app`.

### Deploy-Schritte (Client)

1. Im gleichen Projekt: **„+ New" → „GitHub Repo"** → dasselbe Repo erneut waehlen.
2. **Settings → Root Directory** → `client`
3. **Settings → Build Command:** `npm ci && npm run build`
4. **Settings → Start Command:** `npx serve -s dist -l $PORT`
   (Serve als Dep hinzufuegen, siehe Hinweis unten.)
5. **Variables:**
   ```
   VITE_API_BASE = https://vaultchat-server-production.up.railway.app
   VITE_WS_URL   = https://vaultchat-server-production.up.railway.app
   ```
   (Der Client konvertiert `https://` intern automatisch zu `wss://` fuer WS.)
6. **Settings → Networking → Generate Domain** → Client-URL notieren.
7. Zurueck zum Server-Service und `VAULTCHAT_CORS_ORIGIN` auf die **Client-URL**
   setzen, dann Server redeployen.

#### Kleine Repo-Anpassung fuer Railway-Client

Railway laeuft Node, also brauchen wir einen statischen Server. Am einfachsten
`serve` als devDependency einbauen:

```bash
cd client
npm install --save-dev serve
```

Und in `client/package.json` ein Start-Script:

```json
"scripts": {
  "start": "serve -s dist -l ${PORT:-3000}"
}
```

Dann kannst du in Railway einfach **Start Command: `npm run start`** setzen.

### Railway-Vorteile gegenueber Render Free
- Kein Sleep → In-Memory-State bleibt erhalten.
- Schnellere Cold-Start-Zeit bei Deploy.
- Sauberes Logging & Metrics UI.

### Railway-Nachteile
- Trial-Credit endlich ($5). Danach automatische Abschaltung, bis du Geld aufladest.
- Kreditkarte fuer Upgrade noetig (nicht fuer Trial).

---

## Welchen Weg nehmen?

| Szenario | Empfehlung |
| --- | --- |
| „Ich will kostenlos und dauerhaft laufen lassen" | **Render + UptimeRobot** (Weg A) |
| „Ich will mal 2–4 Wochen testen ohne Setup-Aufwand" | **Railway** (Weg B) |
| „Ich habe einen eigenen Rechner und will gar keinen Provider" | `DEPLOY.md` alte Version / Cloudflare Tunnel — frag bei Bedarf nach |

---

## Nach dem Deployment — Checkliste

1. **Client oeffnen** → Code-Integrity-Banner zeigt `unknown` (erster Start),
   Hash pinnen.
2. **Registrieren** → Backup der Identity-JSON sofort runterladen und sicher speichern.
   Ohne dieses Backup kommst du nach einem Server-Redeploy nicht mehr an dein Konto.
3. **Zweiten Account in einem anderen Browser anlegen**, DM senden, Key-Fingerprint
   ueber einen **anderen Kanal** (Telefon, Signal, persoenliches Treffen) vergleichen
   und im SafetyNumberDialog als „Verified" markieren.
4. **DevTools → Network → WS**: pruefen, dass im Frame nur `envelope`,
   `toUserId`, `cid` auftauchen — **nicht** `fromUserId`. Das bestaetigt, dass
   Sealed Sender aktiv ist.
5. **Auto-Lock testen**: 10 Minuten nichts tun → Session locked, Re-Auth verlangt.

---

## Troubleshooting

| Problem | Ursache / Loesung |
| --- | --- |
| `CORS blocked` in der Browser-Konsole | `VAULTCHAT_CORS_ORIGIN` am Server stimmt nicht mit der Client-URL ueberein |
| WS verbindet nicht, Status 1006 | Server schlaeft (Render Free), warte 30 Sek oder setze UptimeRobot auf |
| `401 unauthorized` direkt nach Login | Server hat neu gestartet, In-Memory-User-Liste weg. JSON-Backup importieren und neu entsperren. |
| Client zeigt `pinned_mismatch` | Neues Bundle deployed → Hash-Pin bestaetigen, wenn du den Deploy selbst ausgeloest hast |
| Kein Audio bei Call hinter striktem NAT | `TURN_URL`/`TURN_USER`/`TURN_CRED` setzen, Relay-Only im Client aktivieren |
