# Local Obsidian MCP Server Design

## Goal

Build a Windows-first, local-only TypeScript MCP server that lets Codex and ChatGPT Desktop safely inspect and manage Markdown notes in one or more explicitly registered Obsidian vaults over STDIO.

## Scope and operating assumptions

- Windows is the first documented and tested platform; path handling uses Node's cross-platform APIs so WSL/Linux setup can be documented and supported where practical.
- Multiple vaults are supported. The model can call `list_vaults` and select a registered vault by name; it cannot supply arbitrary filesystem roots.
- The initial server manages Markdown notes and directories only. Attachments, semantic search, embeddings, Git synchronization, cloud synchronization, and Obsidian UI automation are out of scope.
- The actual user vault path is not hard-coded into the project. It is supplied by local configuration or the `register_vault`/`create_vault` workflow.

## Architecture

The server is a layered STDIO application:

```text
MCP client
  -> src/index.ts (STDIO transport, stderr diagnostics)
  -> src/server.ts (MCP server and tool registration)
  -> Zod tool schemas
  -> vault registry and security boundary
  -> focused filesystem/search/frontmatter services
  -> structured result with vault, relative path, and content hash
```

`src/config` owns configuration loading and validation. `src/security` is the only boundary allowed to turn a user-provided vault-relative path into a filesystem path. `src/services` contains testable domain operations. `src/tools` adapts service results and errors to MCP tool responses. No tool accesses `fs` directly.

## Configuration and vault registry

The default configuration file is `config/vaults.json`; `OBSIDIAN_MCP_CONFIG` overrides its location. The shape is:

```json
{
  "vaults": {
    "personal": {
      "path": "C:\\Users\\USERNAME\\Documents\\Obsidian\\Personal",
      "readOnly": false,
      "dailyNotes": {
        "directory": "Daily",
        "dateFormat": "YYYY-MM-DD"
      }
    }
  }
}
```

The registry validates unique names, existing/canonicalizable roots, and daily-note settings. `list_vaults` returns names, paths, read-only state, and daily-note configuration; it does not expose unrelated environment data. `register_vault` adds an existing root, `unregister_vault` removes only its registration, and `create_vault` creates a new directory under an explicitly supplied path before registering it. Registry writes are atomic.

## Security boundary

For every operation the server will:

1. Resolve the named registered vault.
2. Reject null bytes, absolute note paths, traversal segments, and non-Markdown extensions where a note is required.
3. Canonicalize the vault root and candidate path.
4. Reject candidates outside the canonical vault root, including symlink-based escapes for existing paths and parent directories.
5. Reject `.obsidian`, `.trash`, `node_modules`, and hidden directories by default.
6. Enforce read-only mode before every mutating operation.

Only registered vault roots are accessible. Errors are concise and do not disclose credentials, environment variables, or unrelated local paths.

## Tools and write semantics

The required tools are grouped into vault, directory, file, and Obsidian-specific handlers. Every tool has an explicit Zod schema, `openWorldHint: false`, concise model-readable text, and structured content. Read operations set `readOnlyHint: true`; mutation operations do not; `delete_note` is marked destructive.

- File reads and searches operate only on Markdown notes.
- `create_note` refuses an existing note unless `overwrite` is explicitly true.
- `update_note` accepts an optional expected SHA-256 hash and fails on mismatch.
- `append_note` and `append_daily_note` preserve existing content and never overwrite it.
- `move_note` rejects an existing destination unless explicitly allowed.
- `delete_note` moves a note to `<vault>/.trash` with a collision-safe name instead of permanently deleting it.
- All writes use a temporary file in the same directory followed by rename, and return the vault name, relative path, and resulting content hash.

## Search and frontmatter

Search walks registered-vault content while ignoring configured excluded directories and hidden directories by default. It matches filenames, Markdown body text, tags, and YAML frontmatter, applies a configurable result limit, and returns short excerpts rather than entire notes.

Frontmatter uses `gray-matter` (or an equivalent maintained parser). `get_frontmatter` returns parsed properties. `update_frontmatter` merges selected properties and serializes valid YAML while preserving the note body. Common properties such as `tags`, `aliases`, `status`, `created`, and `updated` are supported without imposing a rigid schema.

## Daily notes

Each vault may configure a daily-note directory and date format; defaults are `Daily` and `YYYY-MM-DD`. `append_daily_note` creates the directory and note when absent, then appends content without replacing existing content. Date formatting is isolated behind a small service so it can be unit-tested.

## Testing and verification

Vitest unit tests cover schemas, configuration, path security, hashes, atomic writes, frontmatter merge, search matching, and date formatting. Integration tests create temporary vaults and exercise every tool category without touching the user's real vault. Tests explicitly cover traversal, absolute paths, null bytes, symlink escape, `.obsidian`, read-only vaults, overwrite/hash conflicts, trash moves, and destination collisions.

The verification sequence is formatting/lint, typecheck, all unit and integration tests, production build, server startup, representative valid/invalid MCP requests, and MCP Inspector inspection. STDIO diagnostics go only to stderr.

## Client documentation

`README.md` will document Windows PowerShell setup, WSL/Linux setup, ChatGPT Desktop configuration, Codex CLI registration, Codex IDE configuration, examples for major tools, troubleshooting, and the exact generated command:

```text
codex mcp add obsidian-local -- node ABSOLUTE_PATH_TO_PROJECT/dist/index.js
```

The implementation will print no protocol-breaking logs to stdout.
