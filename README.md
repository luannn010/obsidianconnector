# ObsidianConnector

Local, Windows-first MCP access to explicitly registered Obsidian vaults. The server uses STDIO only and exposes Markdown note operations to Codex and ChatGPT Desktop without granting arbitrary filesystem access.

## Requirements

- Node.js 20 or newer
- npm
- An Obsidian vault directory, if you want to register an existing vault

The first version intentionally excludes HTTP, OAuth, tunnels, databases, web hosting, custom UI, semantic search, embeddings, synchronization, and attachment management.

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
