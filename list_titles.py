import json, csv
from pathlib import Path
from datetime import datetime

# Datei hier anpassen:
INPUT = Path("split_out/conversations_chunk_003.json")
OUTPUT = Path("chunk003_titles.csv")

data = json.loads(INPUT.read_text(encoding="utf-8"))

def to_dt(ts):
    try:
        return datetime.fromtimestamp(float(ts))
    except Exception:
        return None

rows = []
for i, conv in enumerate(data, start=1):
    title = (conv.get("title") or "").strip()
    dt = to_dt(conv.get("create_time"))
    dt_str = dt.strftime("%Y-%m-%d %H:%M") if dt else ""
    rows.append([i, dt_str, title])

with OUTPUT.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["nr", "datetime", "title"])
    w.writerows(rows)

print("Wrote", OUTPUT, "with", len(rows), "rows")
