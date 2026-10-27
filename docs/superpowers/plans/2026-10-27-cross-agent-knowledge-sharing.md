# Cross-agent knowledge sharing (Claude ↔ Codex)

Goal: Claude Code and Codex share project knowledge through the obsidian-local
connector without rediscovering each other's work.

Done already: **S1** — SessionStart hook injects the other agent's recent tasks,
changed files, stale docs, and blockers as `additionalContext` (`c9a94ae`).

## Work split

Tasks A, B and C touch disjoint files and run in parallel (one Codex session
each, separate worktrees off `master`). Task D depends on A and C and runs after
they merge. Every task: TDD with vitest, then `npm run typecheck`, `npx eslint
src tests`, `npx vitest run tests/unit`, `npm run build`, Prettier only on
files the task touched, one commit on its own branch.

### Task A — S5: explicit, self-checking hook configuration
Files: `src/activity-hook.ts`, `src/activity/*.ts`, `src/activity-server.ts`,
`tests/unit/activity-*.test.ts`, new `src/activity-doctor.ts`, `package.json`
(script only).

- Remove every `'MC-Platform'` fallback in the activity path.
- Resolve the project when `projectKey` is absent: hook reads
  `PROJECT_KNOWLEDGE_PROJECT_KEY`, else `projectKey` from
  `<git root>/.obsidian-local/config.json` if present; daemon otherwise resolves
  by matching the cwd's git root against `project_knowledge.repositories.root_path`
  / registered `worktrees.path` (case-insensitive). Unknown project → record is
  ignored (not an error that spools forever), handoff returns empty.
- `GET /v1/status?cwd=` returns resolved project key plus last event time per
  agent; `npm run activity:doctor` prints it (token present, daemon reachable,
  project resolved, last claude/codex event).

### Task B — S3 + S4 + S8: one set of agent instructions, portable config
Files: `.claude/skills/project-to-obsidian/**` (new),
`.codex/skills/project-to-obsidian/**`, `AGENTS.md` (new), `CLAUDE.md` (new),
`scripts/sync-agent-skills.ps1` (new), `tests/unit/agent-instructions.test.ts`
(new), `.mcp.example.json` (new), `.gitignore`, `README.md`.

- `.codex/skills/project-to-obsidian` stays canonical; commit an identical copy
  under `.claude/skills/`. Test fails if the two trees differ.
- `scripts/sync-agent-skills.ps1` copies the canonical skill to `.claude/skills`
  and `~/.claude/skills` (with `-WhatIf` support).
- `AGENTS.md`: the README's "Project knowledge through ObsidianConnector" block
  plus a short "Cross-agent handoff" section (what the SessionStart context
  means; run `recall_project_knowledge` intent `catch_up` before touching listed
  files; write decisions/gotchas/conventions so the other agent sees them).
- `CLAUDE.md`: `@AGENTS.md` plus Claude-only notes (skill location).
- `.mcp.example.json`: launches `node dist/index.js` directly (no Codex cached
  `pwsh`); `.mcp.json` added to `.gitignore`; README notes it.

### Task C — S6 + S7: knowledge vocabulary and work claims
Files: `src/tools/knowledge-tools.ts`, `src/knowledge/pg-store.ts`,
`src/knowledge/types.ts`, `src/knowledge/migrations.ts` (append-only),
`tests/unit/pg-knowledge-store.test.ts`, `tests/unit/knowledge-*.test.ts`.

- Known kinds: `architecture`, `decision`, `constraint`, `convention`,
  `gotcha`, `blocker`, `risk`, `work_item`, `handoff`, `completed_work`,
  `active_work`, plus any kind already used by the code; `other:<slug>` escape
  hatch. Case-normalize; reject unknown kinds with a clear error listing them.
- `work_item` claims: `properties.claimedBy` (`codex|claude`) and
  `properties.claimExpiresAt` (ISO). A `patch` that sets a claim on an item with
  an unexpired claim by the other agent fails with `CLAIM_CONFLICT`. Snapshot /
  recall hits expose the active claim.
- `recall_project_knowledge` intent `catch_up` ranks `handoff`, `gotcha`,
  `decision` first.

### Task D — S2: durable handoff items (after A and C merge)
- On `session_end` (and `stop` when the task changed files) the daemon writes or
  appends a `handoff` knowledge item, stable key `handoff:<agent>:<sessionId>`,
  through the existing `writeProjectKnowledge` path (no direct SQL inserts),
  body generated from task rollups — no model tokens.

## Finish
Merge A, B, C (then D) into `master` with `--no-ff`, rebuild, run
`scripts/sync-agent-skills.ps1`, restart the `ObsidianProjectKnowledgeActivity`
scheduled task, then run `npm run activity:doctor` and a SessionStart hook
smoke test.
