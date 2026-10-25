# Local project maps (opt-in pilot)

This integration gives Claude, GPT/Codex and GLM/OpenCode tjob sessions the same local shell query interface. It does not change models, credentials, caps, production agents, evaluation gates, or the Python/BPMN codegraph in tripam-agents. Ordinary source tools work when maps are disabled, missing, stale or broken.

The pilot pins **Graphify / graphifyy 0.9.95**, upstream tag commit `92741d162b2094ffc2fed58cfbd8ee823e9da62c`: [official source](https://github.com/Graphify-Labs/graphify/tree/92741d162b2094ffc2fed58cfbd8ee823e9da62c). Its license is Apache-2.0, with upstream MIT material and NOTICE; installed distribution license files remain in the private venv. Dependencies include networkx, numpy, RapidFuzz, PyYAML, tree-sitter and the upstream language grammars. Exact distribution versions and wheel SHA-256 hashes are in `scripts/graphify/requirements.lock`. This lock targets **CPython 3.12 on Linux x86_64**; other platforms require a separately reviewed wheel lock.

Only `graphify.extract.extract(paths, root=..., cache_root=..., parallel=False)` is called. The reviewed adapter never invokes Graphify's assistant installer, CLI build pipeline, semantic extraction, MCP, upload, cloud or subagent integrations. Python audit guards reject socket and subprocess operations during extraction; the child receives no provider credentials and runs with `-I` in a temporary directory. No indexed source is imported or executed. Setup uses download traffic; runtime indexing/querying needs no provider key or model request.

## Setup and explicit repository selection

From this repository:

```sh
npm run graphify:setup
npm run test:graphify
```

Setup creates a dedicated versioned installation under `~/.local/share/cli-graphify/`, then atomically switches its `current` symlink. It uses a private venv and hash-checked binary wheels, without changing PATH, AGENTS.md, CLAUDE.md, global assistant settings or hooks. Run setup again after updating this integration; existing installations are retained for rollback. Do not move a venv to another workstation; run setup there.

Merge an explicit entry into `~/.config/cli/graphify.json`, preserving other entries. The key is the main checkout path (parent of `git rev-parse --path-format=absolute --git-common-dir`), not a worktree or workspace directory:

```json
{
  "repositories": {
    "/home/busu/Tribeira/tribeiracli": {
      "enabled": true,
      "roots": ["src", "server", "scripts"],
      "includeUntracked": false,
      "outputBytes": 6000,
      "extractionTimeoutSeconds": 45
    }
  }
}
```

All repositories are disabled by default. Start with CLI only. Add tripam-api or tripam-agents only after reviewing their tracked source directories and data boundaries; neither is indexed by setup. A worktree uses its main repository's policy. Roots must be explicit relative source files/directories, without hidden or parent components; `.` and workspace-wide recursive scans are refused.

```sh
python3 -I ~/.local/share/cli-graphify/current/project-map.py prepare --repo "$PWD"
python3 -I ~/.local/share/cli-graphify/current/project-map.py status --repo "$PWD"
python3 -I ~/.local/share/cli-graphify/current/project-map.py query 'createJobsService dependencies' --repo "$PWD"
```

Run from a repository/worktree root or give its exact root with `--repo`. Outputs are JSON with a state and provenance. Queries are deterministic symbol/path term matching with adjacent static edges; there is no natural-language model call. Read `source_file` and `source_location`, then inspect exact source. `EXTRACTED` records syntax and `INFERRED` records static resolution; neither proves a dynamic runtime relationship.

## Selection, freshness and limits

Only Git-tracked `.java`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.py` files under selected roots enter the snapshot. `includeUntracked: true` explicitly adds current nonignored source files under those same roots and exclusions. Otherwise a new untracked file is intentionally absent; stage it or opt into this policy before relying on its map. Deleted tracked files disappear. Repository-local Graphify config, manifests and tsconfig files are not copied, so alias/package resolution can be incomplete. Use exact source tools for unresolved imports.

The filter rejects hidden components (including `.git`, `.jobs`, environment files and assistant settings), dependencies, venvs, builds, coverage, scratch/temp/data/customer directories and credential-related names. Symlink files and directories are never followed; every opened path component uses `O_NOFOLLOW`. Media and documents are not accepted. Limits are 1 MB per source file, 4,000 files and 64 MB of source/graph data. Review roots before enabling a repository: sensitive data in an ordinary innocently named source file cannot be identified by a filename policy.

Artifacts live under `~/.cache/cli-graphify/<repository-id>/<worktree-id>/`, outside Git. Their identities include repository common directory, worktree path, HEAD, branch, selected filenames/content hashes, policy, wrapper/adapter digest, schema and dependency lock. This conservative pilot keeps separate artifacts even for clean identical commits in different worktrees. Each status/query rehashes selected source, and queries revalidate after graph loading. It refuses stale evidence after edits, additions allowed by policy, deletions or branch changes; run `prepare` again. No filesystem tool can freeze an editor's changes after the response, so still verify exact source before edits.

Preparation uses a nonblocking OS lock per worktree and atomic artifact/status writes. Another preparer returns `preparing`; retry later. Extraction uses a private copied snapshot; source changes during the build cause an error. Failure/timeout never authorizes serving the old state. The extraction timeout is clamped to 1–45 seconds; tjob bounds preparation to 60 seconds. The child has a 1.5 GB address-space limit and a 64 MB file-size limit. A forcibly killed process can leave a private temporary snapshot; cleanup is safe when no preparations are running.

Query JSON is limited to 1,024–12,000 bytes (`outputBytes`, default 6,000), up to 12 matches and 24 adjacent edges. `truncated` indicates any omitted results; narrow the terms. Small budgets may leave only provenance. Source paths are relative to the exact worktree in provenance. Edges keep upstream confidence tags. No full graph report is injected into prompts.

## Jobs and interactive sessions

After worktree creation, tjob optionally prepares the map while the job is still `preparing`. It adds a short shell command and source-verification guidance to the initial task for all three backends. No guidance is added for disabled repositories or an absent installation. Missing/broken tools never fail the job. After source edits, the assistant can explicitly refresh with `prepare`. Recovery and later messages use the existing session context and normal job lifecycle.

The inspected OpenCode runner spawns the configured executable on the host with `--dir <worktree>` and the inherited environment; this workstation's executable is `~/.opencode/bin/opencode`, not a container launcher. Claude and Codex also have host shell access in these jobs. Absolute wrapper/venv paths therefore avoid PATH differences, and no filesystem permissions are broadened. If another workstation wraps OpenCode in a container, install this integration **inside that existing isolation** and use paths it already exposes; do not grant broader mounts. That environment needs a separate compatibility check before enabling it. MCP is unnecessary for the inspected runtime.

For interactive Claude Code/Codex sessions, run `guidance` to get the same optional shell guidance, or explicitly add a small project skill:

```sh
python3 -I scripts/graphify/interactive.py --repo /path/to/repo --assistant claude
python3 -I scripts/graphify/interactive.py --repo /path/to/repo --assistant codex
```

These commands exclusively create `.claude/skills/cli-local-project-map/SKILL.md` or `.agents/skills/cli-local-project-map/SKILL.md`; existing files and symlink paths are refused. Review before committing the additive guidance. They never edit AGENTS.md/CLAUDE.md or existing skills. No mandatory query, read-denial hook or extraction subagent is installed.

## Measurement and repeatable validation

```sh
npm run test:graphify
npm run graphify:benchmark -- --output /tmp/graphify-replay.json
npx tsx --tsconfig server/tsconfig.json --test server/modules/orchestrator/tests/project-map.test.ts
```

The offline harness creates a synthetic Git repository, replays a local edit and a cross-file investigation with/without maps on the same base, inspects the same exact source, and records preparation separately. It uses static fixture assertions rather than executing indexed project code. Records include initial guidance bytes, exploration operations/output, exact source reads, elapsed time and intended-outcome assertions. Model settings, whole-session input/output/cache tokens and credit conversions are `null`, because no model runs. It is a compatibility test, not evidence of efficiency or a completed coding-agent trial.

Runtime `metrics.jsonl` records command, state, elapsed milliseconds, output bytes, truncation and timestamp; it omits query text and source contents. It rotates at approximately 1 MB, retaining one previous file. Artifacts contain source identifiers; keep cache directories private.

For a live pilot, manually assign matched tasks through existing authorized routes; do not launch autonomous extra jobs or accounts. Pair one local fix and one cross-file investigation on the same base revision, backend/model/effort and permissions, with map policy enabled versus disabled. Record the full session usage from existing provider usage reports (input/output/cache), initial guidance, exploration reads, graph commands, preparation time, task elapsed time, actual final tests and whether the intended fix was achieved. Record unknown credit conversions as unknown. Keep observations separate from offline tool replay, and do not estimate savings from repository-size/index-size ratios. Keep defaults opt-in until matched whole-session measurements justify a change.

## Disable, troubleshooting and removal

Set a repository's `enabled` to false (or remove only its entry) to disable it without restarting the server. This affects future preparation/query calls; existing session text remains, but the wrapper returns `disabled`. For `missing`/`stale`, run prepare; for `preparing`, wait/retry. For `error`, check the config JSON, explicit roots, platform, private installation and budgets, then rerun setup/tests/prepare. Excluded or unresolved symbols need ordinary source inspection. Installation/model/API configuration is never repaired automatically.

Remove interactive guidance with the same command plus `--remove`. It only removes an exact, unmodified copy produced by this helper; modified guidance requires manual review. Preserve parent assistant directories and unrelated files.

After disabling the selected repository and waiting for its preparations, delete its exact repository cache directory from the cache path above to remove its indexes and metrics. To remove all integration artifacts, disable/remove only the integration's config entries, remove its exact generated skills, and delete the dedicated `~/.cache/cli-graphify/` and `~/.local/share/cli-graphify/` directories. Remove `~/.config/cli/graphify.json` only if it contains no other entries. No global Graphify uninstall or assistant reset is needed.

The server must load the new jobs-service code through the normal deployment before automatic tjob guidance is active. Do not manually restart a CLI server hosting jobs. Interactive use is available immediately after setup and explicit repository enablement.
