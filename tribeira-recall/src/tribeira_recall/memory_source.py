from __future__ import annotations

import hashlib
import json
import os
import select
import shlex
import subprocess
from typing import Any

from .db import Document

DEFAULT_SCOPES = (
    "reasoning:*",
    "claude:global",
    "codex:global",
    "opencode:global",
)


def read_memories() -> list[Document]:
    """Read configured tribeira-memory stdio MCP; never calls a write tool."""
    command = os.environ.get("RECALL_MEMORY_MCP_COMMAND")
    if not command:
        return []
    scopes = tuple(s for s in os.environ.get("RECALL_MEMORY_SCOPES", ",".join(DEFAULT_SCOPES)).split(",") if s)
    process = subprocess.Popen(
        shlex.split(command),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert process.stdin and process.stdout
    next_id = 0

    def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
        nonlocal next_id
        next_id += 1
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": next_id, "method": method, "params": params}) + "\n")
        process.stdin.flush()
        while True:
            ready, _, _ = select.select([process.stdout], [], [], 30.0)
            if not ready:
                raise TimeoutError("memory MCP response timed out after 30s")
            response = json.loads(process.stdout.readline())
            if response.get("id") == next_id:
                if "error" in response:
                    raise RuntimeError(response["error"].get("message", "memory MCP error"))
                return response.get("result", {})

    try:
        call(
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "tribeira-recall-indexer", "version": "0.1.0"},
            },
        )
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        process.stdin.flush()
        raw = call(
            "tools/call",
            {
                "name": "memory_search",
                "arguments": {"query": "decisions lessons causes traps conventions research", "scopes": list(scopes), "limit": 20},
            },
        )
        text = "\n".join(part.get("text", "") for part in raw.get("content", []) if part.get("type") == "text")
        payload = json.loads(text)
        results = payload.get("results", payload if isinstance(payload, list) else [])
        documents = []
        for item in results:
            memory_id = str(item.get("id", ""))
            body = str(item.get("memory", item.get("text", "")))
            if not memory_id or not body:
                continue
            scope = str(item.get("scope", "memory"))
            digest = hashlib.sha256(body.encode()).hexdigest()
            documents.append(
                Document(
                    doc_key=f"memory:{memory_id}",
                    kind="lesson" if item.get("kind") == "lesson" else "decision",
                    source=f"mem0:{memory_id}",
                    origin="mem0",
                    title=f"{scope} {item.get('kind', 'note')}"[:200],
                    content=body[:6000],
                    content_hash=digest,
                )
            )
        return documents
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdin.close()
        process.stdout.close()
