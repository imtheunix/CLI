# Independent verification of Recall MCP candidate c2dd5114 (job d802cd05)

Date: 2026-11-10
Verifier: GLM Flash, single independent pass (job d802cd05), refutation attempt of
producer evidence from job 7ebc6f89 (DeepSeek).
Candidate under test: `c2dd5114a9541ddaf0be59a9530f776c62337a81`
("test(recall): verify MCP tool surface, stdio exchange, memory source, embedder and CLI").

## Verdict

**No HOLD. All four producer claims reproduced. c2dd5114 stands verified.**
No deterministic defect was found in the candidate's own diff. Three
non-blocking observations concern *inherited* feature code (predating the
candidate) and are recorded below for upstream follow-up; none refutes the
candidate's verification claims.

## Content identity and ancestry

- `git merge-base --is-ancestor c2dd5114 origin/main` → candidate **is** an
  ancestor of origin/main.
- My worktree HEAD **is exactly c2dd5114** with a clean tree, so every run
  below tested the exact candidate content; no archive extraction was needed.
- Main has since moved: `b11cde5e` is a concurrently merging duplicate
  ("verify MCP tools, stdio exchange, memory source, embedder and CLI") that
  extends 4 of the candidate's test files (`test_cli.py`, `test_embeddings.py`,
  `test_mcp_server.py`, `test_mcp_stdio.py`, +289/−28) but touches neither
  `memory_source.py` nor the producer report. Nothing attributed to c2dd5114
  below is taken from b11cde5e.
- Candidate's full production-code diff is 3 lines in
  `tribeira-recall/src/tribeira_recall/memory_source.py` (terminate/wait, then
  close child stdin/stdout pipes in `finally`). Everything else in the commit
  is tests + the producer report.

## Claim 1 — focused 26-test discovery: REPRODUCED

Setup per `docs/recall.md`: fresh `python3 -m venv tribeira-recall/.venv` +
`pip install -e tribeira-recall` (PyPI deps only; no model/provider data).
Run:

```sh
HF_HUB_OFFLINE=1 RECALL_ONNX_THREADS=1 \
  tribeira-recall/.venv/bin/python -m unittest discover -s tribeira-recall/tests -v
```

Result: **Ran 26 tests, OK — 26 passed, 0 failed, 0 skipped** (1.16–1.39 s
across runs). All 15 test names listed in the producer report appear in the
verbose output and pass. Producer claimed 26/26/0 — confirmed.

## Claim 2 — real MCP stdio exchange: REPRODUCED + extended with own probes

Beyond the checked-in `test_mcp_stdio` (which passed as part of Claim 1), I ran
my own stdio probe (`/tmp/recall-refute-d802cd05-3351725/probe_stdio.py`,
disposable, outside the repo) with **my own synthetic fixtures** — different
content, repo and kinds from the producer's — seeded into a temp DB via the
fake embedder, then a real `python -m tribeira_recall serve` subprocess
(`RECALL_DB`/`RECALL_ARTIFACT_ROOT` temp, `HF_HUB_OFFLINE=1`,
`TRANSFORMERS_OFFLINE=1`, `RECALL_ONNX_THREADS=1`, memory-MCP env var stripped;
every call under `asyncio.wait_for` ≤90 s; child lifecycle owned by mcp
stdio_client context managers).

Observed over the wire:

- initialize → serverInfo `tribeira-recall`, negotiated protocol `2025-11-25`.
- `tools/list` → exactly `artifact_get, artifact_list, artifact_put, recall,
  similar_failures, symbol`.
- `recall(query="kubernetes pod eviction", k=3)` → `isError=False`, my seeded
  `probe-repo:runbook/k8s.md` ranked #1 (`BM25 #1 + cosine #2`), row shape
  exactly `{source, kind, snippet, why}`. The cosine leg used the **real local
  MiniLM ONNX query embedding from cache** — no download (offline env), no
  provider call.
- `symbol(name="evacuate_node", repo="probe-repo")` → exact name/source/signature.
- `similar_failures("429 rate limit retry flake")` → my seeded job #1.
- New cases the producer's tests do not cover:
  - **Unknown tool** `totally_unknown_tool` → `isError=True`,
    `"Unknown tool: totally_unknown_tool"`; bounded, no hang, no crash.
  - **`artifact_get` with missing id** → `isError=False` with in-band
    `{"error": "ValueError: unknown artifact id"}` — the `bounded_errors`
    contract holds over real stdio (protocol success, structured error payload).
  - **Bogus `kinds=["no-such-kind"]`** → `{"results": []}`, bounded.
  - **`k=0`** → returns 1 result (see observation O-1).
- `pgrep` after run: no orphan `tribeira_recall` processes.

## Claim 3 — MemorySource parser / read-only / failure behavior: VERIFIED with own fake servers

My own probes (`probe_memory_source.py`, run with `-W error::ResourceWarning`)
against throwaway fake stdio servers in temp dirs:

- **Read-only by protocol audit**: my logging fake server records every
  JSON-RPC message; the client sends exactly `initialize` + `tools/call` with
  `name="memory_search"` — never `tools/list`, never any write tool. Scopes
  pass through `RECALL_MEMORY_SCOPES` correctly. The unset-command case spawns
  no process and returns `[]`.
- **No silent swallowing of transport failures** (all propagate as raised
  exceptions): server exits before replying → `JSONDecodeError`; non-JSON tool
  text → `JSONDecodeError`; missing script → child exits → `JSONDecodeError`;
  truly missing binary → Popen `FileNotFoundError`; unresponsive server →
  `TimeoutError: memory MCP response timed out after 30s` at exactly 30.0 s
  (bounded as documented).
- **Transport success is not conflated with a semantic match**: parser errors
  raise rather than masquerade as results; a successful transport with garbage
  content raises. (What the server *claims* as results is mapped verbatim into
  Documents — quality/semantics are correctly out of scope, see Limitations.)
- **The candidate's 3-line pipe cleanup works**: the whole probe suite ran with
  `ResourceWarning` promoted to error; no warning fired, no pipe leak, no
  orphan fake servers.

## Claim 4 — LocalEmbedder boundaries + CLI isolation: VERIFIED

Own probes (`probe_embedder_cli.py`) with fakes and temp paths:

- `embed([])` returns `[]` with no model load; still skips the model after a
  model is loaded; a batch calls the model once and the lazy model object is
  reused across `embed`/`query`.
- Wrong-dimension `embed` and `query` raise `ValueError("Expected 384 embedding
  dimensions, got 383")` (exact message); an injected model failure propagates
  (no swallowing).
- CLI: `stats --db <temp>` and `cleanup --db <temp>` return bounded JSON;
  `serve` dispatch calls `mcp_server.run` and returns 0 **without initializing
  Store/services** (`mcp_server._store is None` — no DB opened on dispatch).
- The `index`/`serve` dispatch tests (mocked) and `benchmark` (fake search)
  match the candidate's tests and pass.

## Production-isolation controls (all runs)

- Production DB `~/.local/share/tribeira/recall.db` (787 MB) stat'd before and
  after **everything**: mtime unchanged (`PROD_DB_UNTOUCHED`).
- All databases, artifact roots and fixtures in `tempfile` directories; probe
  scripts in `/tmp/recall-refute-d802cd05-3351725/` (unique, disposable, no
  production paths).
- `HF_HUB_OFFLINE=1` (+`TRANSFORMERS_OFFLINE=1`) throughout; the only model
  used is the already-cached `~/.cache/tribeira/fastembed` MiniLM ONNX. No
  download, no provider call, no credentials involved or emitted, no service
  started/restarted, no network endpoints contacted.
- `RECALL_MEMORY_MCP_COMMAND` never set globally; MemorySource fakes run under
  scrubbed env. No production memory read or written. No pushes, no main
  changes, no new jobs.

## Non-blocking observations (inherited code, NOT part of c2dd5114's diff)

- **O-1 — `k` clamp vs docstring.** `search.py:30` clamps
  `k = max(1, min(int(k), 20))`, so `recall(k=0)` returns 1 result while the
  tool docstring promises "Returns <=k short snippets". Deterministic,
  reproduced at unit level (k=0 → 1; k=999 → 20). Degenerate request, defensive
  clamp — but the docstring over-promises at the boundary. Minor doc/contract
  nit for upstream; not a candidate defect.
- **O-2 — bare-list payload crashes the parser.** `memory_source.py:72`
  `payload.get("results", payload if isinstance(payload, list) else [])` calls
  `.get` on the parsed payload first, so a bare JSON array tool result raises
  `AttributeError: 'list' object has no attribute 'get'` (reproduced). The
  isinstance fallback can never rescue; only `{"results": [...]}` dicts parse.
  It raises rather than silently mis-parsing, and the real `tribeira-memory`
  shape is the dict form — robustness nit for upstream, not a candidate defect.
- **O-3 — unguarded memory source in indexing.** `indexer.py:91` calls
  `read_memories()` without try/except, so a failing/hung memory MCP aborts the
  whole index run after local indexing (bounded at 30 s by the client).
  Escape hatch exists (`--no-memory`). Design note for upstream.

## Explicitly unverified / limitations

- No retrieval-quality, latency, token-savings or model-choice claims: cosine
  ranking in my stdio probe compared a real query embedding against
  fake-vector-seeded documents, so only transport + wiring + BM25 behavior are
  proven. No bake-off, benchmark, or live-model evaluation was run.
- `MemorySource` is verified against my own fake stdio servers, not the real
  `tribeira-memory` service (production memory untouched by design).
- The real ONNX embed path is exercised for queries only (offline cache);
  no full production-scale indexing was run, and the CLI/TSGE whole-workspace
  gate was not run (already queued for the merge, per job scope).
- The 30 s timeout probe and stdio probes bound this verification; producer's
  claimed ~1.3 s suite runtime matched (1.16–1.39 s in my runs).

## Evidence artifacts

- Disposable probes (not committed, outside the repo):
  `/tmp/recall-refute-d802cd05-3351725/{probe_stdio.py,fakes_probe.py,probe_memory_source.py,probe_embedder_cli.py}`
  plus production-DB stat snapshots (`proddb_stat_before/after.txt`).
- Tested content SHA: `c2dd5114a9541ddaf0be59a9530f776c62337a81` (worktree
  HEAD, clean).
