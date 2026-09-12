---
name: project-setup
description: Use when initializing or repairing registration for a project that needs an Obsidian vault, shared project-knowledge database record, Git source snapshot, or Windows worker queue.
---

# Project setup

Use the repository's deterministic setup script. Keep credentials out of messages and command arguments.

## Workflow

1. Ask for the Obsidian vault path first, even when the current project path is known.
2. Infer the project path from the current workspace. Ask only when the workspace is missing or ambiguous.
3. Derive the project key from the vault directory name unless the user supplies one.
4. Run `scripts/setup-project.ps1 -WhatIf` and review its JSON before applying changes.
5. The script checks the user and repository environment files. If the database connection is absent, let the script request it with a secure prompt; never ask the user to paste a password into chat.
6. Run `scripts/setup-project.ps1 -Wait` with the confirmed paths. Respect its conflict errors instead of rebinding an existing project key.
7. Report the project key, vault, worktree ID, snapshot ID and created/reused state, pending child jobs, and failures from the receipt.

The setup is idempotent. It preserves existing notes and project configuration, creates an empty Git bootstrap commit only when no `HEAD` exists, and queues at most one live source job for the worktree.

For this connector repository, invoke:

```powershell
.\scripts\setup-project.ps1 `
  -ProjectPath '<project-path>' `
  -VaultPath '<vault-path>' `
  -ProjectKey '<project-key>' `
  -Wait
```
