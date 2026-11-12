from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tribeira_recall.memory_source import read_memories

FAKE_SERVER = textwrap.dedent(
    """
    import json
    import sys

    for line in sys.stdin:
        message = json.loads(line)
        if "id" not in message:
            continue
        method = message["method"]
        if method == "initialize":
            result = {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "serverInfo": {"name": "fake-memory", "version": "0"},
            }
        elif method == "tools/call":
            result = {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {
                                "results": [
                                    {
                                        "id": "m1",
                                        "memory": "Use local SQLite for recall.",
                                        "scope": "reasoning:global",
                                        "kind": "decision",
                                    },
                                    {
                                        "id": "m2",
                                        "memory": "Retry the focused test after a flake.",
                                        "scope": "opencode:demo",
                                        "kind": "lesson",
                                    },
                                ]
                            }
                        ),
                    }
                ]
            }
        else:
            result = {}
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
    """
)


class MemorySourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.server = self.root / "fake_memory_server.py"
        self.server.write_text(FAKE_SERVER)

    def tearDown(self):
        self.temp.cleanup()

    def test_unset_command_skips_source(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(read_memories(), [])

    def test_reads_search_results_without_write_tools(self):
        command = f"{sys.executable} {self.server}"
        with mock.patch.dict(
            os.environ,
            {"RECALL_MEMORY_MCP_COMMAND": command, "RECALL_MEMORY_SCOPES": "reasoning:global,opencode:demo"},
            clear=True,
        ):
            documents = read_memories()
        self.assertEqual([doc.doc_key for doc in documents], ["memory:m1", "memory:m2"])
        self.assertEqual([doc.kind for doc in documents], ["decision", "lesson"])
        self.assertEqual(documents[0].source, "mem0:m1")
        self.assertEqual(documents[0].origin, "mem0")
        self.assertEqual(documents[0].title, "reasoning:global decision")
        self.assertEqual(documents[1].content, "Retry the focused test after a flake.")
        self.assertEqual(len(documents[0].content_hash), 64)

    def test_error_response_is_raised(self):
        failing = self.root / "failing_server.py"
        failing.write_text(
            textwrap.dedent(
                """
                import json
                import sys

                for line in sys.stdin:
                    message = json.loads(line)
                    if "id" not in message:
                        continue
                    if message["method"] == "initialize":
                        result = {"protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": {}}
                        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
                    else:
                        error = {"code": -32000, "message": "memory unavailable"}
                        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "error": error}), flush=True)
                """
            )
        )
        with mock.patch.dict(
            os.environ, {"RECALL_MEMORY_MCP_COMMAND": f"{sys.executable} {failing}"}, clear=True
        ):
            with self.assertRaisesRegex(RuntimeError, "memory unavailable"):
                read_memories()


if __name__ == "__main__":
    unittest.main()
