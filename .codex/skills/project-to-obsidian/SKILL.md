---
name: project-to-obsidian
description: Use when retrieving, updating, or publishing project knowledge through the SQL-backed obsidian-local MCP server.
---

# Project to Obsidian

## Authority and retrieval

- Git, tests, migrations, and configuration are authoritative for executable behavior.
- PostgreSQL `project_knowledge` is authoritative for normalized knowledge, history, delivery, contracts, mappings, and projections.
- Search indexes are rebuildable. Obsidian `Published/` is a generated human view; `Inbox/` is its editable intake boundary.
- At task startup call `get_project_snapshot` with the exact current worktree path, client task ID, agent, and concise task name. Keep its immutable snapshot ID and returned task reference for later calls.
- Use `search_project_context` to discover context. Exact paths, symbols, routes, tables, IDs, and worktree names use `auto` or `exact`; conceptual questions use `hybrid`.
- Use `expand_project_context` only for returned references that are needed. Do not recursively scan the repository or vault for routine context.
- Open the exact source file before editing executable code when freshness matters.

## Response contract

- Read returned records from MCP `structuredContent`; the text block is only a compact summary.
- Carry `snapshotId` from the snapshot into search and expansion. Carry `dbRevision` into optimistic writes.
- A writable canonical hit exposes `itemId`, `itemVersion`, and `stableKey`. Use `itemId` plus `itemVersion` for patch or append. A hit without them is source-derived evidence; create a canonical correction with its citation instead of guessing an item identity.
- Pass expansion handles in the `refs` array and expand no more than eight references. Use `full` with the current connector; the other accepted view names currently return the same chunk rather than relation-specific projections.
- Respect each response's complete `budget`, `warnings`, `omissions`, freshness, hashes, and continuation cursor.
- If hybrid embeddings or reranking are unavailable, use the returned exact/BM25 results and report the degraded warning.

## Writes and human publication

- Use `write_project_knowledge` for create, patch, append, and supersede operations. Batch related changes, include task/author provenance, and pass the snapshot project revision plus item versions.
- When a change describes executable behavior, attach `evidence` entries returned by the bound snapshot. Use exact `chunk:` refs and choose `path`, `symbol`, `endpoint`, `table`, `migration`, or `test`. Mark evidence required for API contracts, database dictionaries, architecture boundaries, permissions, and operational runbooks.
- Keep `delivery_status` separate from `verification_status`. Agent-reported completion remains unverified until supported by Git, tests, migrations, configuration, or explicit evidence.
- Use `get_project_sync_status` after writes to report index freshness, documentation freshness, active tasks, queued projections, conflicts, and changed items. Filter by the current task and worktree when possible.
- Treat `DOCS_STALE` as a required follow-up: retrieve the returned knowledge references, update them with evidence from the bound snapshot, and retry verified completion. Do not downgrade verification to bypass the gate.
- Manual edits to generated files are conflicts. Preserve them in `Inbox/Conflicts`; incorporate the intended change through a canonical knowledge write or Inbox import, then regenerate.
- A human may add an Inbox note with `kind` and `title` frontmatter. Add `target_id` to patch an existing record.

## Safety rules

- Bind retrieval to the task snapshot. Cross-worktree comparison must be explicit.
- Depend on Codex and Claude lifecycle hooks for Recent Agent Files. Never read or edit `.obsidian/workspace.json` as task evidence; `lastOpenFiles` is only Obsidian UI history.
- Do not invent endpoint examples, statuses, owners, mappings, or completion. Mark missing evidence as incomplete or `needs_review`.
- Keep secrets, credentials, environment files, logs, dependencies, and build output out of general retrieval and embeddings.

## Connector tool mapping

The routine profile contains exactly `get_project_snapshot`, `search_project_context`, `expand_project_context`, `write_project_knowledge`, and `get_project_sync_status`. Vault/file tools are available only in the `admin/legacy` profile for migration, repair, and explicit administration.
