"""Parse a folder of real files and print summary stats only (no content)."""
import json
import sys
import time
from pathlib import Path

import tiktoken

from parse_test import OUT, PARSERS

enc = tiktoken.get_encoding("cl100k_base")  # approximation of Qwen token counts


def main(folder):
    OUT.mkdir(exist_ok=True)
    total = 0
    for f in sorted(Path(folder).iterdir()):
        if f.suffix.lower() not in PARSERS:
            print(f"skip {f.name}")
            continue
        t = time.perf_counter()
        try:
            units = PARSERS[f.suffix.lower()](f)
        except Exception as e:
            print(f"!! {f.name}: {type(e).__name__}: {e}")
            continue
        dt = time.perf_counter() - t
        toks = sum(len(enc.encode(u["text"] + " " + u.get("notes", ""))) for u in units)
        total += toks
        vis = [u for u in units if u["needs_vision"]]
        empty = sum(1 for u in units if len(u["text"].split()) < 5)
        notes = sum(1 for u in units if u.get("notes"))
        eqs = sum(u["text"].count("$") // 2 for u in units)
        (OUT / f"{f.stem}.units.json").write_text(json.dumps(units, indent=1), encoding="utf-8")
        print(f"{f.name}\n   {len(units)} {units[0]['type']}s, ~{toks:,} tokens, parsed in {dt:.1f}s; "
              f"{len(vis)} need vision; {empty} near-empty; {notes} with speaker notes; {eqs} equations as LaTeX")
        reasons = {}
        for u in vis:
            for r in u.get("reasons") or ["embedded images"]:
                reasons[r.split(" (")[0]] = reasons.get(r.split(" (")[0], 0) + 1
        if reasons:
            print("   vision reasons:", reasons)
    print(f"\nTOTAL ~{total:,} tokens of text (before vision)")


if __name__ == "__main__":
    main(sys.argv[1])
