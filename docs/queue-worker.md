# Debian embedding queue worker

The Debian service reads only PostgreSQL queue and chunk rows and calls the existing embedding gateway. It does not mount a source repository or Obsidian vault. Windows remains responsible for source scanning and note publishing.

Run the migration and deployment previews first:

```powershell
.\scripts\migrate-project-knowledge.ps1 -WhatIf
.\scripts\deploy-queue-worker.ps1 -WhatIf
```

Apply them in the same order. The deployment builds a content-addressed release, starts it with host networking, waits for a matching database heartbeat, and switches the `current` link only after health succeeds. A failed heartbeat starts the previous Compose release.

After Debian reports healthy, set `PROJECT_KNOWLEDGE_PROCESS_EMBEDDINGS=false` in `%USERPROFILE%\.codex\project-knowledge.env` for the Windows worker. To use the documented local fallback, stop the Debian service and set the value to `true`; the Windows worker then uses the same `EmbeddingQueueProcessor` and advisory locking still prevents duplicate local workers.

Run source synchronization without a model call:

```powershell
.\scripts\sync-project-knowledge.ps1 `
  -ProjectKey MC-Platform `
  -WorktreePath 'C:\Users\luann\Documents\MC-Platform' `
  -Wait
```

The command hashes modified and untracked file contents, scans only the requested worktree, publishes from Windows, and completes its `sync_runs` receipt only when the final source fingerprint still matches the initial one. Use `-LocalEmbeddingFallback` only during a planned Debian outage.

The queue worker marks obsolete jobs `superseded` with a structured reason. Its daily cleanup permanently removes only superseded snapshots older than seven days that have no source evidence, task, file activity, note projection, or domain synchronization references.
