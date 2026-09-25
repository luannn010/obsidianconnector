---
name: project-to-obsidian
description: Use when retrieving, auditing, synchronizing, updating, or publishing project knowledge through the SQL-backed obsidian-local MCP server.
---

# Project to Obsidian

## Worker-backed source refresh

When the user requests a refresh, or compact status returns `REINDEX_SOURCE`, run the zero-AI queue command from the deployed worker checkout instead of reading changed files into the conversation. A refresh-only request starts with this command; do not call `get_project_snapshot` first:

```powershell
& 'C:\Users\luann\Documents\Obisidian COnnector\.worktrees\shared-workers\scripts\sync-project-knowledge.ps1' -ProjectKey <project-key> -WorktreePath '<exact-worktree-path>' -Wait
```

The command deduplicates `source_sync` by worktree, starts the Windows Docker worker, and returns the authoritative `sync_runs` receipt. Treat `snapshotState: reused` as success: snapshots are created only when HEAD, the content-aware dirty fingerprint, or parser revision changed. Task or prompt completion does not create a snapshot. The Windows container normally exits after 60 idle seconds.

Embedding jobs are already in PostgreSQL. A healthy Debian worker claims them without another request or conversational tokens. If the receipt has pending child jobs but no failures, report them as queued and make at most one compact status call; do not poll. Use `-LocalEmbeddingFallback` only when the Debian embedding heartbeat is stale.

## Local `.obsidian-local` mapping bootstrap

When the local filesystem ObsidianConnector is connected, initialize a new
project with `initialize_project` after selecting a registered vault. This
creates `.obsidian-local/config.json`, `.obsidian-local/mapping.yaml`, and
`.obsidian-local/README.md` in the project root.

Treat `.obsidian-local/mapping.yaml` as the portable source of truth for the
documentation tree. It supports nested `group` nodes, Markdown `note` nodes,
custom paths, and optional semantic aliases such as `tasks`, `decisions`,
`risks`, and `changelog`. After editing the mapping, call
`sync_project_config`. Synchronization updates retrieval roles and aliases
only; it never creates, moves, renames, or deletes vault notes.

Use `get_project_context` or `search_notes` after synchronization. If a custom
section has no semantic alias, retrieve it through the project context or
search tools rather than assuming a legacy role name.

## Compact sync loop

PostgreSQL `project_knowledge` is the canonical knowledge store. Git, tests, migrations, and configuration are authoritative for executable behavior. Obsidian `Published/` is generated; `Inbox/` is editable intake.

1. Call `get_project_sync_status` first with `compact: true` and `changedOnly: true`. Read `structuredContent`; the text block is only a summary.
2. If freshness is `current`, failed and pending jobs are zero, and no actions exist, stop. Do not fetch a snapshot or search.
3. If `summary.failedJobs` is greater than zero, report `topIssues` and ask for an explicit override before automatic repair.
4. Execute only `topSuggestedActions`, in returned order, after their `dependsOn` actions:
   - `REINDEX_SOURCE`: call `run_project_sync_action` with the exact suggested action or action id. When reindexing changes the fingerprint, make one new compact status call.
   - `UPDATE_KNOWLEDGE`: retrieve only the action's exact `changedPaths`. Use exact search and expand only returned `chunk:` handles or action `evidenceRefs`, up to eight refs. Patch the resolved `relatedItemIds`; do not run a broad search.
   - `VERIFY_EVIDENCE`: check only listed evidence refs and paths against Git, tests, migrations, or configuration. Attach authoritative evidence or leave the blocker unresolved.
   - `FINALIZE_PROJECTION`: call `finalize_projection` or `run_project_sync_action` instead of shelling out. In quick mode, do not poll projection-only work; use `compact: false` only when the user requests deep troubleshooting.
5. After semantic writes, call compact status once and report changed items, unresolved blockers, estimated writes/tokens, and the final `cacheKey`. Do not re-read unchanged context.

Treat `omitted` counts as a high-cost batch signal. Stop before expanding it and request deep mode or a narrower worktree/domain scope.

## Bounded retrieval and writes

When an action needs source context, call `get_project_snapshot` with the exact worktree path and client task ID. Omit `maxTokens` for the default 800-token snapshot; the snapshot maximum is 1,600. Carry `snapshotId` into search/expansion and `dbRevision` into writes.

Use `search_project_context` for discovery: exact paths, symbols, routes, tables, IDs, and worktrees use `exact` or `auto`; concepts use `hybrid`. The search maximum is 4,000 tokens. Use `expand_project_context` only for returned refs; the expansion maximum is 6,000. Respect budgets, warnings, omissions, freshness, hashes, and cursors.

Use `write_project_knowledge` for create, patch, append, and supersede. Batch related changes and use `itemId` plus `itemVersion` for updates. Executable claims require exact snapshot evidence. Keep delivery and verification status separate. `DOCS_STALE` requires evidence-backed repair; never downgrade verification to bypass it.

Manual edits under `Published/` are conflicts. Preserve them through `Inbox/Conflicts`, update canonical knowledge, then regenerate. Never use `.obsidian/workspace.json` as evidence. Exclude secrets, credentials, logs, dependencies, and build output.

The routine profile contains `get_project_snapshot`, `get_project_sync_status`, `search_project_context`, `expand_project_context`, `write_project_knowledge`, `finalize_projection`, and `run_project_sync_action`. Vault/file tools are admin-only.
