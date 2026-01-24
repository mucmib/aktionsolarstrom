import json
from pathlib import Path

INPUT = Path("split_out/conversations_chunk_001.json")
OUTPUT = Path("beginning_plaintext.txt")

MAX_CONVERSATIONS = 5      # extrem klein anfangen
MAX_CHARS_PER_CONV = 20000 # harte Textgrenze pro Conversation

data = json.loads(INPUT.read_text(encoding="utf-8"))

out_lines = []

for i, conv in enumerate(data[:MAX_CONVERSATIONS], start=1):
    title = conv.get("title", "Untitled")
    out_lines.append(f"\n=== CONVERSATION {i}: {title} ===\n")

    mapping = conv.get("mapping") or {}
    text_accu = ""

    for node in mapping.values():
        msg = node.get("message")
        if not msg:
            continue
        role = (msg.get("author") or {}).get("role", "unknown")
        parts = (msg.get("content") or {}).get("parts") or []
        for p in parts:
            if isinstance(p, str):
                text_accu += f"{role.upper()}: {p}\n\n"
        if len(text_accu) > MAX_CHARS_PER_CONV:
            text_accu += "\n[TEXT GEKÜRZT]\n"
            break

    out_lines.append(text_accu)

OUTPUT.write_text("".join(out_lines), encoding="utf-8")
print(f"Wrote {OUTPUT}")
