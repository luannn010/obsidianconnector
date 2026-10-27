@AGENTS.md

## Claude Code notes

- The `project-to-obsidian` skill is mirrored in
  `.claude/skills/project-to-obsidian/`. Do not edit the mirror directly; edit
  `.codex/skills/project-to-obsidian/` and run `scripts/sync-agent-skills.ps1`,
  which also refreshes `~/.claude/skills/project-to-obsidian`.
- Activity hooks for this repository live in `.claude/settings.local.json`
  (`dist/activity-hook.js --agent claude`).
