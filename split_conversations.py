import json
from pathlib import Path

# Einstellungen:
INPUT = Path("conversations.json")
OUTDIR = Path("split_out")
CHUNK_SIZE = 250  # Anzahl Conversations pro Datei (anpassen: 100–500 ist meist gut)

OUTDIR.mkdir(exist_ok=True)

data = json.loads(INPUT.read_text(encoding="utf-8"))
assert isinstance(data, list), "Unerwartetes Format: conversations.json ist nicht eine Liste."

# sortiere sicherheitshalber nach create_time (älteste zuerst)
def ct(conv):
    v = conv.get("create_time")
    try:
        return float(v)
    except Exception:
        return 0.0

data.sort(key=ct)

for i in range(0, len(data), CHUNK_SIZE):
    chunk = data[i:i+CHUNK_SIZE]
    idx = i // CHUNK_SIZE + 1
    out = OUTDIR / f"conversations_chunk_{idx:03d}.json"
    out.write_text(json.dumps(chunk, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out}  ({len(chunk)} conversations)")
