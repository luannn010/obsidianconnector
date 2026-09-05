---
name: project-to-obsidian
description: Organize project conversations into a matching Obsidian vault and maintain its codebase navigation index, verification metadata, tasks, decisions, plans, research, and daily entries.
---

# Project to Obsidian

Turn project conversations into durable, linked Markdown notes in the correct Obsidian vault.

## Identity and vault selection

- Treat each ChatGPT project as its own Obsidian vault.
- Preserve the exact ChatGPT project name as `project_name`.
- Convert the project name to lower camelCase for `project_key` and the vault folder name. Example: `My New Project` -> `myNewProject`.
- Use the registered vault whose name matches `project_key`.
- New vaults must be created under `G:\\My Drive\\.obsidian`; the vault folder is `G:\\My Drive\\.obsidian\\<project_key>`.
- Use `list_vaults` as the source of truth; it lists only registered vaults beneath `OBSIDIAN_VAULT_ROOT`.
- If the vault is missing, or a matching folder exists but is not registered, ask for confirmation before creating or registering it.
- If connector tools are unavailable, explain that the local Obsidian MCP connector must be connected and provide proposed Markdown instead of claiming it was written.

## Codebase index

For repositories, treat Obsidian as the navigation and planning source of truth, while Git and repository tests remain authoritative for implementation behavior. Use `get_project_context` first, then `verify_codebase_index` before implementation work.

The configured manifest defaults to `Codebase Index.md`. Its frontmatter maps stable roles to notes:

```yaml
---
roles:
  repository_map: Codebase/Repository Map.md
  ownership: Codebase/Ownership.md
  api_contracts: Codebase/API Contracts.md
---
```

Role notes should include `status`, `last_verified`, `repository_revision`, `owners`, and `related_paths`. After code changes, inspect the referenced source files and tests, then update the affected note with the new revision and verification date using `update_note` or `update_frontmatter`.

## Standard vault layout

Use [note-templates.md](references/note-templates.md). Create only missing folders/files when initializing a project; never overwrite existing notes.

```text
00 - Project Home.md
01 - Brief.md
02 - Goals & Success Criteria.md
03 - Requirements.md
04 - Decisions.md
05 - Plans.md
06 - Tasks.md
07 - Research.md
08 - Meeting Notes.md
09 - Resources.md
10 - Risks & Issues.md
11 - Changelog.md
Daily/
Inbox/
Archive/
Templates/
```

## Capture workflow

1. Identify the ChatGPT project and derive `project_key`.
2. Call `list_vaults`; confirm the selected vault before writing.
3. Classify useful material into the appropriate project note.
4. Read target notes before modifying them and preserve existing headings.
5. Use `create_note` for missing notes, `append_note` for additive captures, and `update_note` only for an intentional rewrite. Use `expectedHash` after a read when updating.
6. Maintain links from `00 - Project Home.md` to project notes.
7. Update `11 - Changelog.md` when notes are created or materially changed.
8. Report the vault, files, and actions taken, including anything placed in `Inbox/`.

## Safety rules

- Never write to another project vault because it appears convenient.
- Never overwrite an existing note unless explicitly requested.
- Use vault-relative Markdown paths only; never use absolute note paths or traversal.
- Treat deletion as moving to the connector's vault trash.
- Do not invent decisions, requirements, owners, dates, or commitments. Mark inferences or place them in `Inbox/`.
- Ask before creating a vault, registering an existing folder, changing vault metadata, or making destructive changes.

## Connector tool mapping

Use `get_project_context` first when understanding a project. Use `verify_codebase_index` to surface stale or missing index evidence, and `get_project_activity` when answering what is currently being worked on or what should happen next. Other tools by intent are `list_vaults`, `get_vault`, `create_vault`, `register_vault`, `list_directory`, `create_directory`, `list_notes`, `read_note`, `create_note`, `update_note`, `append_note`, `search_notes`, `get_frontmatter`, `update_frontmatter`, `list_tags`, `list_backlinks`, and `append_daily_note`. Use `move_note` or `delete_note` only when explicitly requested.

Read [note-templates.md](references/note-templates.md) when deciding where content belongs or when initializing a vault.

## ChatGPT Desktop use

This workflow can be used by any client connected to the same local Obsidian MCP server. ChatGPT Desktop must have the server configured with the built connector entry point and the same `config/vaults.json`; the skill file itself is automatically discoverable by Codex, while ChatGPT can follow the workflow when it has the connector tools available. If ChatGPT does not expose those tools, it can still draft the notes but cannot write to the local vault.
