#!/usr/bin/env python3
"""Regenerate CREDITS.md from assets/catalog/curated.json (CC-BY requires attribution)."""
import json, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
d = json.loads((ROOT / "assets/catalog/curated.json").read_text(encoding="utf8"))
lines = ["# Credits", "",
         "Fan project. *Slendytubbies* is by ZeoWorks; *Teletubbies* is owned by WildBrain.",
         "Non-commercial use only.", "", "## 3D models", ""]
for m in sorted(d, key=lambda m: m["author"].lower()):
    lines.append(f"- **{m['name']}** by [{m['author']}]({m['url']}) — {m['license']}")
(ROOT / "CREDITS.md").write_text("\n".join(lines) + "\n", encoding="utf8")
print(f"wrote CREDITS.md ({len(d)} entries)")
