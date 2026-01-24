import json
from pathlib import Path

INPUT = Path("split_out/conversations_chunk_001.json")
OUTPUT = Path("split_out/conversations_chunk_001_first50.json")
N = 50

data = json.loads(INPUT.read_text(encoding="utf-8"))
OUTPUT.write_text(json.dumps(data[:N], ensure_ascii=False), encoding="utf-8")

print(f"Wrote {OUTPUT} with {N} conversations")

