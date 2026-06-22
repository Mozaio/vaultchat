#!/usr/bin/env python3
"""
Stop-Hook fuer VaultChat/Umbra.
Blockiert das Stoppen, solange GOAL.md noch offene Punkte (- [ ]) hat,
und weist Claude an, mit dem festen Ablauf weiterzuarbeiten.
"""
import json
import sys

data = json.load(sys.stdin)

# KRITISCH: verhindert Endlosschleife innerhalb desselben Stop-Zyklus.
if data.get("stop_hook_active"):
    sys.exit(0)

try:
    with open("GOAL.md", encoding="utf-8") as f:
        goal = f.read()
except FileNotFoundError:
    # Kein Ziel definiert -> nicht blockieren.
    sys.exit(0)

if "- [ ]" in goal:
    print(json.dumps({
        "decision": "block",
        "reason": (
            "GOAL.md hat noch offene Punkte (- [ ]). Nimm den naechsten "
            "offenen Punkt von oben und durchlauf den Ablauf aus CLAUDE.md: "
            "denker -> schreiber -> waechter -> tester. UEBERSPRINGE Punkte "
            "mit Marker '- [-]' (nutzer-exklusiv, Billing/Secret/Account) — "
            "die NICHT erfragen, nur ueberspringen. NIE den Nutzer um "
            "Bestaetigung fragen (volle Vollmacht laut CLAUDE.md): der "
            "waechter-Gate IST die Freigabe. Der tester prueft nur den neuen "
            "Code auf Bugs und deployt bei sauberem Ergebnis (und nur nach "
            "waechter PASS): git commit/push ueber das Terminal, dann Manual "
            "Deploy im Render-Dashboard ueber Chrome. Hake den Punkt nur ab, "
            "wenn waechter PASS und tester DEPLOY OK liefern. Dann weiter zum "
            "naechsten Punkt."
        )
    }))

sys.exit(0)
