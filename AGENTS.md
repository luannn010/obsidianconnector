# Agent instructions

Claude Code and Codex both work in this repository and share project knowledge
through the `obsidian-local` MCP server. Follow the same rules in both.

## Project knowledge through ObsidianConnector

When a task needs project context, decisions, tasks, risks, changelog entries,
or other project knowledge:

1. Use the `project-to-obsidian` skill. The canonical copy is
   `.codex/skills/project-to-obsidian/SKILL.md`; Claude Code reads the mirror
   in `.claude/skills/project-to-obsidian/`.
2. Start with `get_project_sync_status` (`compact: true`, `changedOnly: true`).
   Stop if freshness is current and no actions are pending.
3. For orientation, lookup, verification, or catch-up, call
   `recall_project_knowledge` once with the intent and the last
   `knownStateHash`. Use `search_project_context` only for narrower discovery.
4. Use `expand_project_context` only for the returned refs needed for the task.
   Never recursively load the whole vault.
5. Keep retrieval bounded. Respect every returned budget, warning, omission,
   freshness value, hash, and continuation cursor.
6. Use `write_project_knowledge` for project-knowledge changes. Include source
   evidence for executable behavior, a short `message`, a `reason`, a stable
   `idempotencyKey`, and `expectedHash` for patches.
7. Run `get_project_sync_status` after writes. Treat stale documentation,
   conflicts, and unverified completion as follow-up work.
8. If embeddings or reranking are unavailable, use the exact/BM25 results and
   report the degraded-search warning.
9. Never put secrets, credentials, environment files, logs, dependencies, or
   build output into general retrieval or embeddings.

## Cross-agent handoff

At session start the activity hook may add a "Cross-agent handoff" block listing
the other agent's recent tasks on this worktree, files they changed, stale
documentation refs, and open blockers.

- Before editing a listed file, call `recall_project_knowledge` with intent
  `catch_up`.
- Record decisions, gotchas, and conventions with `write_project_knowledge` so
  the other agent sees them.
- Keep the skill copies identical: edit the canonical `.codex` copy, then run
  `scripts/sync-agent-skills.ps1`.

## Development

```text
npm run typecheck
npx eslint src tests
npx vitest run tests/unit
npm run build
```

Run Prettier only on files you changed. Diagnostics go to stderr; stdout is
reserved for MCP protocol messages.
