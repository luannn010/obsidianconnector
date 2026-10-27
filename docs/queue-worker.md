# Shared project-knowledge workers

One `linux/amd64` image runs with capabilities selected by environment variables. Debian runs `scheduler,embedding,maintenance` continuously. Docker Desktop starts `source-sync,publish` on demand with the projects mount read-only and the Obsidian vault mount read-write. PostgreSQL is the queue and canonical coordination store; queue payloads contain identifiers rather than file contents.

Build and deploy with dry runs first:

```powershell
$build = .\scripts\build-shared-worker-image.ps1 -WhatIf
.\scripts\migrate-project-knowledge.ps1 -WhatIf
.\scripts\deploy-queue-worker.ps1 -Image '<registry image@sha256 digest>' -Release '<content hash>' -WhatIf
```

Apply the migration, build and push the image, then deploy the returned digest:

```powershell
.\scripts\migrate-project-knowledge.ps1
$image = .\scripts\build-shared-worker-image.ps1 | ConvertFrom-Json
.\scripts\deploy-queue-worker.ps1 -Image $image.image -Release $image.release
$env:PROJECT_KNOWLEDGE_WORKER_IMAGE = $image.image
```

The Debian profile uses host networking, a 512 MB memory limit, a 384 MB Node heap, and embedding batches of 16. The scheduler holds a dedicated PostgreSQL advisory lock, so processing replicas can be scaled while only one instance creates hourly requests. Leases and `FOR UPDATE SKIP LOCKED` prevent simultaneous claims. Expired portable work returns to its original capability; source jobs continue waiting for Windows.

Run an on-demand source synchronization:

```powershell
.\scripts\sync-project-knowledge.ps1 `
  -ProjectKey MC-Platform `
  -WorktreePath 'C:\Users\luann\Documents\MC-Platform' `
  -Wait
```

The command inserts or reuses one live `source_sync` job for the worktree, starts the Windows Compose worker, and waits for the PostgreSQL receipt. The receipt includes the final content-aware fingerprint, snapshot ID, whether the snapshot was created or reused, child queue counts, assigned worker, projection state, pending count, and failures. Completion is recorded only when the final source fingerprint matches the requested source.

If compact status reports only pending projection work, finalize generated vault notes without a model call:

```powershell
.\scripts\finalize-project-projection.ps1 `
  -ProjectKey MC-Platform `
  -WorktreePath 'C:\Users\luann\Documents\MC-Platform' `
  -Wait
```

The finalizer runs the status-first projection path in deep mode, publishes managed `Published/` notes from PostgreSQL state, waits up to five minutes by default, and exits nonzero when failed jobs, projection conflicts, stale projections, or pending jobs remain.

The Windows profile does not enable embedding while a fresh Debian embedding heartbeat exists. A Windows fallback instance may include `embedding`; it begins portable work only after the Debian heartbeat becomes stale. Embedding content is coalesced by project and content hash, so one model response fans out to matching current chunks.

Maintenance keeps retired jobs auditable as `superseded`. It deletes only superseded snapshots older than seven days that have no source evidence, task, file activity, note projection, or domain synchronization references. Separately, the daily payload cleanup removes the chunks, symbols, and unreferenced files of superseded snapshots older than two days (`PROJECT_KNOWLEDGE_SNAPSHOT_PAYLOAD_RETENTION_DAYS`) for every project while keeping the snapshot rows and evidence-referenced chunks. Embedding vectors are cached by normalized content hash in `embedding_cache`, so re-indexed or copied content is not embedded again.
