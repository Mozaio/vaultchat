# Blinde Discovery (GOAL 0.1d) — Design-Spec

**Ziel:** Der Server lernt den Klartext-Username **nie** — weder bei der
Registrierung (heute in `users[].username` im Klartext gespeichert) noch bei
der Suche (heute `GET /api/users/search?q=<username>`, Exact-Match gegen
Klartext). Discovery bleibt **Exact-Match only** (kein Verzeichnis-Browsing,
Signal/Session-Stil) — nur eben blind.

## Verfahren: OPRF(ristretto255, SHA-512)

Standard-OPRF nach IRTF-CFRG-Draft „Oblivious Pseudorandom Functions (OPRFs)
using Prime-Order Groups". Umsetzbar mit den libsodium-Ristretto-Primitiven
(`crypto_core_ristretto255_*`, `crypto_scalarmult_ristretto255`), die der
Client bereits über `libsodium-wrappers-sumo` hat.

Der Server hält ein langlebiges Geheimnis `k` (32-Byte-Ristretto-Skalar). Die
PRF ist `F_k(name) = H2(name, k · H1(name))`:

1. **Blind (Client):** `P = H1(normalize(name))` (hash-to-point); Zufalls-Blind
   `r`; sende `B = r · P`.
2. **Evaluate (Server):** antworte `E = k · B`. Der Server sieht nur einen
   gleichverteilten Punkt `B` — er lernt weder den Namen noch dass es eine
   bestimmte Person ist (OPRF-/DH-Sicherheit).
3. **Unblind (Client):** `N = r⁻¹ · E = k · P`; **Tag** `= SHA-512(name ‖ N)`.

Der **Tag** ist der Lookup-Schlüssel:
- **Registrierung:** Client registriert sich unter seinem `Tag`; der Server
  speichert `Tag → { publicKey, … }` und **keinen** Klartext-Namen.
- **Discovery:** Client berechnet den `Tag` des Zielnamens und fragt den Server
  „Account zu diesem Tag?". Der Server matcht nur Tags, sieht nie den Namen.

## Ehrliche Sicherheitsgrenze (Pflicht-Eintrag in THREAT_MODEL.md)

OPRF schlägt **passive** Beobachtung: keine Klartext-Namen in Logs, Query-
Strings, Proxy-Logs oder im persistierten State; Netzwerk-Beobachter und ein
*ehrlicher-aber-neugieriger* Server lernen nichts.

ABER: Ein **bösartiger** Server, der `k` besitzt, kann offline `Tag` für
beliebige Kandidaten-Namen berechnen und gegen den Index prüfen
(Dictionary-/Enumeration-Angriff auf niedrig-entropische Namen). Das ist die
fundamentale Grenze ohne Enclave (Signal löst es mit SGX) oder Threshold-OPRF.
Wir umgehen das nicht still, sondern **dokumentieren es** (so erlaubt es die
GOAL.md-Präambel) und mildern es: Rate-Limits auf Evaluate, Empfehlung
hoch-entropischer Handles, später optional Threshold-OPRF (mehrere
Key-Shares). Gegenüber heute (Server kennt **alle** Namen im Klartext) ist es
trotzdem ein klarer Gewinn.

## Abhängigkeiten / Trade-offs

- `k` muss **dauerhaft stabil** sein (Rotation invalidiert alle Tags →
  Neu-Registrierung). Als Server-Secret `VAULTCHAT_DISCOVERY_OPRF_KEY` (USER
  setzt es; fail-closed in production, wenn ungesetzt).
- Der `Tag → Account`-Index muss **durable** sein → hängt an 0.1a (heute
  `state: ephemeral`). Bis dahin funktioniert blinde Discovery nur ephemer.
- Migration: bestehende klartext-indizierte Accounts → Tag-Index. Da der State
  aktuell ohnehin bei jedem Restart leer ist, reicht „beim nächsten Login unter
  Tag neu registrieren"; bei durable State später Dual-Index in der Übergangszeit.

## Zerlegung (siehe GOAL.md 0.1d-1 … 0.1d-5)

1. **0.1d-1** Spec + Threat-Model-Eintrag (dieses Dokument). *(docs)*
2. **0.1d-2** Server-OPRF-Primitive + Key-Mgmt: `POST /api/discovery/evaluate`
   (gibt `k · B` zurück), `k` aus Env, fail-closed in prod; libsodium als
   Server-Dependency. Rate-limited. *(server)*
3. **0.1d-3** Account-Index per Tag: Registrierung speichert Tag statt Name,
   Discovery sucht per Tag; Klartext-Name raus aus dem Server-State. *(server)*
4. **0.1d-4** Client-Blinding + Verdrahtung: Tag bei Register + Lookup berechnen;
   `?q=<name>` durch blinden Tag-Lookup ersetzen. *(client — Runtime-Risiko,
   braucht Verifikation, da Client nicht deploy-typgecheckt wird)*
5. **0.1d-5 (USER)** `VAULTCHAT_DISCOVERY_OPRF_KEY` setzen (für immer stabil) +
   durable State (0.1a). *(nutzer-exklusiv)*

Quellen: [gtank — Efficient Private Contact Search](https://blog.gtank.cc/private-contact-search/),
[liboprf (libsodium-basiert)](https://github.com/stef/liboprf),
[oprf-ts](https://github.com/privacyresearchgroup/oprf-ts).
