from __future__ import annotations

import json
from typing import Any

MAX_RESPONSE_TOKENS = 1000
MAX_SNIPPET_TOKENS = 200


def clip_text(value: str, tokens: int = MAX_SNIPPET_TOKENS) -> str:
    encoded = value.encode("utf-8")
    budget = tokens * 4
    if len(encoded) <= budget:
        return value
    raw = encoded[: budget - 3]
    return raw.decode("utf-8", "ignore").rstrip() + "…"


def bounded_json(data: dict[str, Any], max_tokens: int = MAX_RESPONSE_TOKENS) -> str:
    """Return compact JSON whose MCP text encoding, plus envelope, stays under the token budget."""
    data = json.loads(json.dumps(data, ensure_ascii=False))
    list_keys = ("results", "symbols", "failures", "artifacts", "lines")
    while True:
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        # MCP wraps this string as JSON text. Count that escaping and a 256-byte protocol envelope.
        if len(json.dumps(encoded, ensure_ascii=False).encode("utf-8")) + 256 <= max_tokens * 4:
            return encoded
        target = next((key for key in list_keys if isinstance(data.get(key), list) and len(data[key]) > 1), None)
        if target:
            data[target].pop()
            data["truncated"] = True
            continue
        string_path = _largest_string(data)
        if string_path:
            parent, key = string_path
            current = parent[key]
            if len(current) > 32:
                parent[key] = current[: max(16, int(len(current) * 0.75))].rstrip() + "…"
                data["truncated"] = True
                continue
        if target and data[target]:
            data[target].pop()
            data["truncated"] = True
            continue
        return json.dumps({"error": "response too large", "truncated": True}, separators=(",", ":"))


def _largest_string(value: Any):
    candidates = []

    def visit(item: Any, parent: Any = None, key: Any = None) -> None:
        if isinstance(item, dict):
            for child_key, child in item.items():
                visit(child, item, child_key)
        elif isinstance(item, list):
            for index, child in enumerate(item):
                visit(child, item, index)
        elif isinstance(item, str) and parent is not None:
            candidates.append((len(item), parent, key))

    visit(value)
    if not candidates:
        return None
    _, parent, key = max(candidates, key=lambda item: item[0])
    return parent, key
