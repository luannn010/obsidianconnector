# ObsidianConnector

Local, Windows-first MCP access to explicitly registered Obsidian vaults. The server uses STDIO only and exposes Markdown note operations to Codex and ChatGPT Desktop without granting arbitrary filesystem access.

## Requirements

- Node.js 20 or newer
- npm
- An Obsidian vault directory, if you want to register an existing vault

The admin profile retains the original local vault operations. The standard profile uses PostgreSQL-backed exact, BM25, and optional vector retrieval with generated Obsidian projections.

## Windows PowerShell setup

```powershell
cd 'C:\path\to\ObsidianConnector'
npm install
Copy-Item .env.example .env
New-Item -ItemType Directory -Force config | Out-Null
@'
{
  "vaults": {
    "personal": {
      "path": "C:\\Users\\USERNAME\\Documents\\Obsidian\\Personal",
      "readOnly": false,
      "dailyNotes": { "directory": "Daily", "dateFormat": "YYYY-MM-DD" },
      "codebaseIndex": {
        "manifest": "Codebase Index.md",
        "maxAgeDays": 30,
        "roles": {}
      }
    }
  }
}
'@ | Set-Content config\vaults.json
npm run typecheck
npm test
npm run build
```

The configuration path defaults to `config/vaults.json`. The local `.env` sets `OBSIDIAN_VAULT_ROOT=G:\\My Drive\\.obsidian`; only registered vaults beneath that directory are returned by `list_vaults`, and new vaults are created there. Set `$env:OBSIDIAN_MCP_CONFIG` or `$env:OBSIDIAN_VAULT_ROOT` to override these values for a local run. Use `register_vault` for an existing vault elsewhere, but it will remain hidden from `list_vaults` unless it is under the configured root.

## WSL/Linux setup

```bash
cd /path/to/ObsidianConnector
npm install
cp .env.example .env
mkdir -p config
npm run typecheck && npm test && npm run build
```

Use Linux paths in the configuration when launching the server from WSL/Linux. A Windows client should launch the Windows Node executable and use Windows vault paths.

## Secure vault model

The model can access only vaults in the registry. Use `list_vaults` first, then pass the returned vault name to other tools. Note paths must be relative Markdown paths. Absolute paths, `..` traversal, null bytes, symlink escapes, `.obsidian`, `.trash`, `node_modules`, hidden directories, and non-Markdown note paths are rejected. Read-only vaults reject all mutations.

Automated tests create temporary vaults and never modify your actual Obsidian vault.

## Codex CLI

Build the server, then register the generated JavaScript entry point:

```text
codex mcp add obsidian-local -- node ABSOLUTE_PATH_TO_PROJECT/dist/index.js
```

If the path contains spaces, quote the executable argument as required by your shell or Codex CLI version.

## Codex IDE

Use the IDE's MCP server configuration and select a local STDIO server. Set the command to `node`, set the argument to the absolute path ending in `dist/index.js`, and set `OBSIDIAN_MCP_CONFIG` in the server environment if the registry is not at `config/vaults.json`. Restart the IDE after changing the server configuration.

## ChatGPT Desktop

Add a local MCP/connector entry using the STDIO command and absolute `dist/index.js` path. The command is `node`; the argument is the server path. Add `OBSIDIAN_MCP_CONFIG` as an environment variable when using a custom registry. Do not configure an HTTP URL: this server intentionally has no HTTP transport.

## Tool reference and example prompts

Start with: “List my registered Obsidian vaults.” Then choose a returned vault name.

- `list_vaults`: “List every registered vault and show which are read-only.”
- `get_vault`: “Show the configuration for the `personal` vault.”
- `create_vault`: “Create and register a writable vault named `scratch` under the configured `G:\\My Drive\\.obsidian` parent directory.”
- `register_vault`: “Register this existing vault as `work` in read-only mode, with optional `codebaseRoles` for non-standard project-note layouts.”
- `unregister_vault`: “Unregister the `scratch` vault without deleting its files.”
- `list_directory`: “List the Markdown notes and safe child directories in `personal/Projects`.”
- `create_directory`: “Create the `Projects/2026` directory in the writable `personal` vault.”
- `list_notes`: “List all notes under `personal/Projects`.”
- `search_notes`: “Search `personal` for `quarterly review`, returning at most 10 excerpts.”
- `read_note`: “Read `personal/Projects/plan.md`.”
- `create_note`: “Create `personal/Projects/plan.md` with this content; do not overwrite it if it exists.”
- `update_note`: “Update that note only if its content hash is this expected SHA-256 value.”
- `append_note`: “Append this timestamped section to `personal/Projects/plan.md`.”
- `move_note`: “Move `personal/Projects/draft.md` to `personal/Projects/archive/draft.md` and reject collisions.”
- `delete_note`: “Move `personal/Projects/old.md` to the vault trash.”
- `get_frontmatter`: “Show the YAML frontmatter for `personal/Projects/plan.md`.”
- `update_frontmatter`: “Merge `status: done` and `updated: 2026-07-30` into that note's frontmatter.”
- `list_tags`: “List tags used under `personal/Projects`.”
- `list_backlinks`: “List notes linking to `personal/Projects/plan.md` with Obsidian wiki links.”
- `append_daily_note`: “Append this entry to today's configured daily note in `personal`.”
- `get_project_context`: “Read the configured codebase index from `personal` with bounded content and report verification gaps.”
- `verify_codebase_index`: “Verify the `personal` codebase index and show stale notes or missing evidence.”
- `get_project_activity`: “Extract current tasks, decisions, risks, changelog entries, and recent daily notes from `personal`.”

For a codebase index, create `Codebase Index.md` with frontmatter such as:

```yaml
---
roles:
  repository_map: Codebase/Repository Map.md
  ownership: Codebase/Ownership.md
  api_contracts: Codebase/API Contracts.md
---
```

Each role note should use `status`, `last_verified`, `repository_revision`, `owners`, and `related_paths`. Obsidian is the navigation and planning source of truth; Git and repository tests remain authoritative for implementation behavior.

Vaults with a different project-note layout can set `codebaseIndex.roles` in `config/vaults.json`, or pass `codebaseRoles` when registering/creating a vault. Configured roles take precedence over `Codebase Index.md` frontmatter, and both fall back to the legacy scaffold role names. `get_project_activity` reads `tasks`, `decisions`, `risks`, and `changelog` from those resolved role paths.

```json
{
  "codebaseIndex": {
    "manifest": "Codebase Index.md",
    "maxAgeDays": 30,
    "roles": {
      "tasks": "04 - Plans & Specs/Tasks.md",
      "decisions": "04 - Plans & Specs/Decisions.md",
      "risks": "01 - Business Plan/Risks.md",
      "changelog": "06 - Repository Reference/Changelog.md"
    }
  }
}
```

## Write safety

`create_note` refuses existing notes unless `overwrite: true`. `update_note` accepts an expected content hash to detect concurrent changes. Writes use a temporary file and rename. `delete_note` moves the note into `<vault>/.trash` with a collision-safe name. Daily notes are created when absent and appended without replacing existing content.

## Development

```text
npm run dev          # run TypeScript directly over STDIO
npm run start        # run dist/index.js
npm run build        # compile to dist/
npm test             # unit and integration tests using temporary vaults
npm run typecheck    # TypeScript compiler check
npm run lint         # ESLint
npm run format       # Prettier write
npm run format:check # Prettier verification
```

Diagnostics go to stderr. Stdout is reserved for MCP protocol messages.

## Verification and MCP Inspector

Run:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npx @modelcontextprotocol/inspector node ABSOLUTE_PATH_TO_PROJECT/dist/index.js
```

Use temporary test-vault configuration when inspecting write tools. Confirm the tool list, schemas, valid calls, validation errors, traversal rejection, symlink rejection, and stdout/stderr behavior.

## Troubleshooting

- **No registered vaults:** create `config/vaults.json`, set `OBSIDIAN_MCP_CONFIG`, or call `register_vault` with an existing directory.
- **New vault location:** `create_vault` always creates `<vault name>` under `G:\\My Drive\\.obsidian`; it does not accept an arbitrary path.
- **Vault directory does not exist:** check spelling and Windows escaping in JSON; `register_vault` does not create missing roots.
- **Access rejected:** use a registered vault name and a vault-relative `.md` path; do not use absolute paths or `..`.
- **Read-only error:** register the vault with `readOnly: false` only when mutations are intended.
- **Hash mismatch:** re-read the note and use the returned current `contentHash` before updating.
- **MCP connection failure:** run `npm run build`, use the absolute `dist/index.js` path, and ensure Node.js 20+ is available to the client.
- **Protocol or JSON errors:** do not add `console.log` statements; diagnostics must use stderr.
- **Inspector cannot start:** run the inspector against the built entry point and a temporary registry; do not point tests at the real vault.

## Low-token project knowledge profile

Set `OBSIDIAN_MCP_PROFILE=standard` and `PROJECT_KNOWLEDGE_DATABASE_URL` to expose exactly five routine tools: snapshot, search, expansion, batch write, and sync status. Set `OBSIDIAN_MCP_PROFILE=admin` for legacy vault/file administration.

```powershell
$env:PROJECT_KNOWLEDGE_DATABASE_URL='postgresql://knowledge_connector:PASSWORD@127.0.0.1:5432/playnode'
npm run knowledge:migrate
$env:PROJECT_KNOWLEDGE_REPOSITORY_PATH='C:\path\to\MC-Platform'
$env:PROJECT_KNOWLEDGE_VAULT_PATH='G:\My Drive\.obsidian\MC-Platform'
$env:PROJECT_KNOWLEDGE_WORKER_ONCE='true'
npm run knowledge:worker
```

The worker fingerprints branch, HEAD, porcelain status, and dirty state. It reuses an active immutable snapshot when these match, or indexes only changed/renamed/deleted files. Canonical knowledge writes synchronously update version history and BM25 content, then queue embedding and Markdown projection work. Embedding failure leaves exact and BM25 retrieval available.

The optional local retrieval service uses `BAAI/bge-small-en-v1.5` with 384-dimensional vectors and `cross-encoder/ms-marco-MiniLM-L-6-v2` for reranking. Start it with a private Bearer token, then configure the connector's embedding and reranker tokens with the same value when both clients use this service:

```powershell
$env:RETRIEVAL_MODEL_BEARER_TOKEN='replace-with-a-long-random-token'
docker compose -f services/retrieval-model/compose.yaml up -d --build
```

Model requests are bounded to two concurrent executions and the container is limited to 4 GiB by default. Set `RETRIEVAL_MODEL_MAX_CONCURRENCY` to another value from 1 through 8 or `RETRIEVAL_MODEL_MEMORY_LIMIT` to another Compose memory value before startup. Health, embedding, and `/v1/rerank` requests require Bearer authentication; health output contains model metadata but no secrets.

### Documentation freshness and Recent Agent Files

Migration `0002_task_traceability_and_doc_freshness` records Codex and Claude tasks, file activity rollups, versioned source evidence, and documentation freshness per worktree snapshot. `.obsidian/workspace.json` remains unmanaged because `lastOpenFiles` is Obsidian UI history and has no reliable agent, task, or worktree identity.

Build the connector and install the local runtime once:

```powershell
npm run build
.\scripts\install-activity-runtime.ps1 -RepositoryPath $PWD -ProjectPath 'C:\path\to\MC-Platform'
```

The installer stores its token in the protected Codex project-knowledge environment file, merges project-local Codex and Claude hooks, and registers two sign-in tasks. `ObsidianProjectKnowledgeActivity` accepts authenticated metadata on `127.0.0.1:8765` and spools temporary database outages. `ObsidianProjectKnowledgeWorker` incrementally indexes changed files, recalculates evidence freshness, and regenerates task views under `Published/02 - Delivery/`. Successful hooks write no output into model context.

Source-verified writes for API contracts, database documentation, architecture boundaries, permissions, and runbooks must include snapshot-bound evidence refs. A stale required record returns `DOCS_STALE` and prevents verified completion until an evidence-backed update makes it current. General and historical notes remain warnings.

Generated pages live under `Published/` during dual-run validation. Human edits belong in `Inbox/`; a generated-page edit is preserved in `Inbox/Conflicts` and reported as projection drift. Managed hashes use canonical JSON SHA-256 for records and normalized UTF-8/LF Markdown SHA-256 excluding volatile managed frontmatter.

The PostgreSQL role should have `USAGE` on `project_knowledge` and DML only for that schema, with no application-schema DML. Keep the pool small and use the configured statement timeout. Run the schema migration with a local database owner before switching the connector to the restricted role.
