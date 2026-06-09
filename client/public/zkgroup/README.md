# client/public/zkgroup — CI-generiert, nicht von Hand bearbeiten

Dieser Ordner enthält das vorgebaute **zkgroup-WASM** (Signals auditierte
`zkgroup`-Crate aus libsignal, via `wasm/zkgroup-wasm`). Die Dateien
`zkgroup_wasm.js` + `zkgroup_wasm_bg.wasm` werden vom Workflow
`.github/workflows/zkgroup-wasm.yml` gebaut und **automatisch hierher
zurück-committet** (Weg A, Phase A3).

Warum hier: Renders Client-Build ist reines Vite (kein Rust). Dateien unter
`public/` liefert Vite unverändert aus — der Client lädt das WASM zur
Laufzeit per dynamischem Import (`/zkgroup/zkgroup_wasm.js`), nur hinter dem
experimentellen zkgroup-Flag, nie auf dem heißen Pfad.

Manuelle Änderungen werden beim nächsten CI-Lauf überschrieben. Um das WASM
neu zu bauen: `wasm/zkgroup-wasm/**` ändern oder den Workflow manuell
auslösen (`workflow_dispatch`).
