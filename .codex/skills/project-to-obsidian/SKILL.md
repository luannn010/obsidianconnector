---
name: project-to-obsidian
description: Retrieve and update versioned project knowledge through the compact obsidian-local MCP profile while keeping Obsidian as its generated human-readable view and Inbox.
---

# Project to Obsidian

## Authority and retrieval

- Git, tests, migrations, and configuration are authoritative for executable behavior.
- PostgreSQL `project_knowledge` is authoritative for normalized knowledge, history, delivery, contracts, mappings, and projections.
- Search indexes are rebuildable. Obsidian `Published/` is a generated human view; `Inbox/` is its editable intake boundary.
- At task startup call `get_project_snapshot` with the exact current worktree path. Keep its immutable snapshot ID for later calls.
- Use `search_project_context` to discover context. Exact paths, symbols, routes, tables, IDs, and worktree names use `auto` or `exact`; conceptual questions use `hybrid`.
- Use `expand_project_context` only for returned references that are needed. Do not recursively scan the repository or vault for routine context.
- Open the exact source file before editing executable code when freshness matters.

## Writes and human publication

- Use `write_project_knowledge` for create, patch, append, and supersede operations. Batch related changes, include task/author provenance, and pass the snapshot project revision plus item versions.
- Keep `delivery_status` separate from `verification_status`. Agent-reported completion remains unverified until supported by Git, tests, migrations, configuration, or explicit evidence.
- Use `get_project_sync_status` after writes to report index freshness, queued projections, conflicts, and changed items.
- Manual edits to generated files are conflicts. Preserve them in `Inbox/Conflicts`; incorporate the intended change through a canonical knowledge write or Inbox import, then regenerate.
- A human may add an Inbox note with `kind` and `title` frontmatter. Add `target_id` to patch an existing record.

## Safety rules

- Bind retrieval to the task snapshot. Cross-worktree comparison must be explicit.
- Do not invent endpoint examples, statuses, owners, mappings, or completion. Mark missing evidence as incomplete or `needs_review`.
- Keep secrets, credentials, environment files, logs, dependencies, and build output out of general retrieval and embeddings.

## Connector tool mapping

The routine profile contains exactly `get_project_snapshot`, `search_project_context`, `expand_project_context`, `write_project_knowledge`, and `get_project_sync_status`. Vault/file tools are available only in the `admin/legacy` profile for migration, repair, and explicit administration.
