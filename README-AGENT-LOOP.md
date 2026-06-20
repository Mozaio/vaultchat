# VaultChat / Umbra — Autonome Agenten-Schleife (Claude Code / Desktop-App)

Macht aus Claude Code einen sich selbst antreibenden Loop, der VaultChat
Richtung Produktziel weiterentwickelt — mit vier spezialisierten Subagenten
und einem Sicherheits-Gate, bis du ihn stoppst oder GOAL.md leer ist. Die
App läuft auf **render.com**; der tester pusht über das Terminal und löst
den Deploy direkt im **Render-Dashboard über Chrome** aus.

## Was drin ist

```
.claude/
├── agents/
│   ├── denker.md      # recherchiert online + plant (Opus)
│   ├── schreiber.md   # implementiert (Sonnet)
│   ├── waechter.md    # Security-Review gegen THREAT_MODEL.md (Opus)
│   └── tester.md      # Bug-Check am neuen Code + Render-Deploy via Chrome (Sonnet)
├── hooks/
│   └── goal-gate.py   # Stop-Hook: treibt die Schleife
└── settings.json      # verdrahtet den Stop-Hook
CLAUDE.md              # fester Ablauf + oberste Sicherheitsregel
GOAL.md                # dein Ziel als Checkliste
```

## Der Ablauf

denker (planen/recherchieren) -> schreiber (umsetzen) -> waechter
(Security-Review) -> tester (Bugs prüfen; wenn sauber + waechter PASS:
git commit/push im Terminal, dann Manual Deploy im Render-Dashboard über
Chrome) -> zurück zum denker.

Ein Punkt in GOAL.md wird erst abgehakt, wenn waechter **PASS** und tester
**DEPLOY OK** liefern.

## Installation

1. Inhalt dieses Ordners in den vaultchat-Repo-Root kopieren, sodass
   `.claude/`, `CLAUDE.md`, `GOAL.md` neben `package.json` liegen. Schon
   vorhandene `CLAUDE.md` ergänzen statt überschreiben.
2. Hook ausführbar machen (macOS): `chmod +x .claude/hooks/goal-gate.py`

## Voraussetzungen (einmalig)

1. **Claude in Chrome aktivieren:** Desktop-App -> deine Initialen unten
   links -> Settings -> den **Claude in Chrome**-Connector einschalten und
   die Chrome-Extension installieren. In einer Code-Session kannst du die
   Verbindung mit `/chrome` herstellen bzw. mit "Reconnect extension"
   neu verbinden, falls sie idle wird.
2. **In Chrome bei Render eingeloggt sein** (dashboard.render.com). Claude
   teilt deinen Browser-Login — deshalb braucht der Deploy keinen API-Key.
3. **git push muss im Terminal funktionieren** (Remote auf dein GitHub-Repo,
   Auth z.B. via gh / SSH-Key gesetzt).
4. **Auto-Deploy in Render auf "No" stellen.** Sonst deployt schon der Push
   automatisch — du willst aber, dass der tester den Deploy bewusst nach
   Bug-Check + waechter-PASS im Dashboard auslöst.

## In der Desktop-App starten

1. Desktop-App -> **Code**-Tab -> neue Session, Arbeitsordner = vaultchat-Repo.
2. Über **Views** das **Subagent-Pane** + **Terminal** öffnen.
3. **WebSearch/WebFetch** aktiv (der denker recherchiert online).
4. **Chrome-Verbindung aktiv** (`/chrome`), Chrome-Fenster sichtbar lassen.
5. Permission-Mode auf **acceptEdits** (oder **auto**), damit Edits, git
   und Browser-Aktionen ohne Nachfrage laufen.
6. Start-Prompt:

   > Arbeite GOAL.md ab. Halte dich exakt an den Ablauf in CLAUDE.md:
   > denker -> schreiber -> waechter -> tester. Sicherheit vor Features.

Stoppen jederzeit mit `Esc` / Session unterbrechen.

## Wichtig — bitte lesen

- **Der tester deployt auf deine LIVE-Seite.** Deshalb läuft der waechter
  (Security-Review) Pflicht-mäßig VOR dem Deploy. Schalt ihn nicht aus.
- **Browser pausiert bei Login/2FA/CAPTCHA.** Das Chrome-Fenster muss
  sichtbar bleiben; bei einer Anmeldeseite hält Claude an und bittet dich,
  das einmal manuell zu machen. "Manual Deploy" ist eine veröffentlichende
  Aktion — Claude in Chrome kann bei heiklen Aktionen trotzdem nachfragen.
- **Staging empfohlen.** Sicherer ist ein zweiter Render-Service
  (vaultchat-staging): der tester deployt dorthin, du promotest selbst nach
  Prod. Gerade für ein Krypto-Produkt sinnvoll — sag Bescheid, dann baue
  ich den Staging-Pfad als Default ein.
- **Krypto-Diffs selbst reviewen,** bevor sie live gehen.
- **Eingebaute Bremse:** Ohne echten Fortschritt bricht Claude Code den
  Stop-Hook nach 8 Runden in Folge ab. GOAL.md-Punkte klein halten.
- **Token-Kosten:** Subagenten-lastige Loops verbrauchen deutlich mehr
  Tokens. Opus nur für Denken/Sicherheit, Sonnet fürs Schreiben/Testen.
