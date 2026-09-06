# ObsidianConnector

Local, Windows-first MCP access to explicitly registered Obsidian vaults. The server uses STDIO only and exposes Markdown note operations to Codex and ChatGPT Desktop without granting arbitrary filesystem access.

## Requirements

- Node.js 20 or newer
- npm
- An Obsidian vault directory, if you want to register an existing vault

The first version intentionally excludes HTTP, OAuth, tunnels, databases, web hosting, custom UI, semantic search, embeddings, synchronization, and attachment management.

## How token savings work

The connector saves tokens by keeping irrelevant vault content out of the model context. The model sends a small retrieval request, the MCP server searches the vault locally, and only the best matching paths, metadata, and excerpts are returned. The model does not need to receive every note just to find the one paragraph that answers the question.

Local indexing and searching do not consume model tokens. Only the MCP request, the returned results, and any note content that you explicitly read become part of the model context.

### Current implementation

The current server already reduces context with bounded filesystem retrieval:

- `search_notes` searches locally and returns short excerpts. It defaults to 20 results and caps the limit at 100.
- `get_project_context` reads configured project notes within a 30,000-character default budget and a 100,000-character maximum.
- `get_project_activity` limits daily notes to 10 by default and bounds their content to 20,000 characters.
- `read_note` reads one requested note. Use `search_notes` first when you do not know which note contains the answer.

### Example calculation

Token counts vary by model and language, so use `characters / 4` only as a rough English-text estimate. The percentage is calculated as:

```text
estimated saving = 1 - (tokens returned by retrieval / tokens in the full-vault prompt)
```

For example:

| Retrieval approach          | Example context                                           |                                                Rough estimate |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------: |
| Full-vault prompt           | 1,000 notes × 2,000 characters                            |                         2,000,000 characters ≈ 500,000 tokens |
| Current `search_notes` flow | 20 short excerpts of about 200 characters                 |                               4,000 characters ≈ 1,000 tokens |
| Target hybrid flow          | 20 candidates, reranked to 5, then one relevant note read | commonly 2,000–10,000 tokens, depending on the selected notes |

In this example, the current search response is about 99.8% smaller than the full-vault prompt. That is an illustration, not a guaranteed benchmark: a short vault, a broad query, or a request to read a large note will produce smaller savings.

### How effective it is

This approach is most effective when the vault is large, the question is focused, and the answer is contained in a small number of notes. It reduces prompt size, lowers repeated context across turns, and leaves the model more room for reasoning and the final answer. It does not reduce the tokens needed to generate the final answer, and it cannot save tokens when you intentionally request the entire vault or a very large note.

The best practical pattern is:

```text
search locally → rank the matching notes → return small excerpts → read only the selected note(s)
```

## Retrieval architecture

The repository currently implements the local MCP server and bounded filesystem search. It does not yet implement PostgreSQL, BM25, pgvector, embeddings, or reranking. The following is the recommended target architecture when the vault grows beyond simple local search.

### Components

| Component                            | Responsibility                                                                                          | Token-saving effect                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| MCP server                           | Exposes safe tools such as vault registration, search, context retrieval, and note reads to the agent   | Returns structured, bounded results instead of exposing the filesystem or full vault            |
| SQL database, recommended PostgreSQL | Stores note metadata, chunks, hashes, timestamps, source paths, index status, and project relationships | Makes retrieval incremental and avoids repeatedly scanning and returning unchanged content      |
| BM25 search                          | Performs exact lexical search for names, identifiers, error messages, and domain terms                  | Finds precise matches without sending the whole corpus to the model                             |
| `pgvector`                           | Stores local embedding vectors and performs semantic nearest-neighbor search                            | Finds conceptually related notes even when the query uses different words                       |
| Local embedder                       | Creates embeddings on the user’s machine during indexing and for each query                             | Avoids sending note content to a hosted embedding API and supports private, repeatable indexing |
| Reranker                             | Scores the top BM25/vector candidates together and selects the most useful passages                     | Shrinks a broad candidate set to a small high-quality context before the model sees it          |

### Target request flow

```text
Obsidian Markdown files
        │
        ├─ parse, chunk, hash, and exclude secrets
        │
        ├─ BM25 index ───────────────┐
        └─ local embeddings → pgvector
                                   │
Agent → MCP server → hybrid candidate retrieval → reranker
                                                    │
                              small excerpts + paths + citations → model
```

BM25 and vector search should be combined rather than treated as substitutes. BM25 is strong for exact project terms such as class names, ticket IDs, and error messages. Vector search is strong for meaning-based questions. The reranker resolves disagreements between those candidate lists before context is returned.

For privacy, the indexer should exclude credentials, environment files, logs, dependencies, build output, and other sensitive or generated directories. Search indexes are rebuildable; the Markdown vault remains the human-readable source.

## Registering a vault and project structure

Register a vault before asking the model to use it. You can add it to `config/vaults.json` manually or call the MCP tool:

```text
Register the existing vault at C:\Users\USERNAME\Documents\Obsidian\Personal
as `personal`, in writable mode.
```

Then use the safe discovery flow:

```text
1. list_vaults
2. choose the returned vault name, such as `personal`
3. initialize_project with the new project's workspace path
4. get_project_context or search_notes
5. read only the note(s) needed to answer the question
```

Registering a vault records and validates its path; it does not create or move project notes. `create_vault` creates the vault directory and registers it. `initialize_project` creates the project-local `.obsidian-local` configuration and mapping files, then synchronizes the mapping to the local vault registry.

The generated project folder is:

```text
your-project/
└── .obsidian-local/
    ├── config.json
    ├── mapping.yaml
    └── README.md
```

`.obsidian-local/config.json` and `mapping.yaml` are portable project configuration and can be committed. Machine-specific vault paths remain in the ignored `config/vaults.json`. The generated README explains how to edit and synchronize the mapping.

The recommended project format is:

```text
Personal/
├── Codebase Index.md
├── 00 - Project Home.md
├── 01 - Brief.md
├── 02 - Goals & Success Criteria.md
├── 03 - Requirements.md
├── 04 - Decisions.md
├── 05 - Plans.md
├── 06 - Tasks.md
├── 07 - Research.md
├── 08 - Meeting Notes.md
├── 09 - Resources.md
├── 10 - Risks & Issues.md
├── 11 - Changelog.md
└── Daily/
    ├── 2026-09-06.md
    └── 2026-09-05.md
```

This tree is a default convention, not a hard-coded requirement. To customize it, edit `.obsidian-local/mapping.yaml` and run `sync_project_config`. Users can add, remove, rename, reorder, and nest documentation sections without changing the MCP server code.

For example:

```yaml
schemaVersion: 1
vault: personal

tree:
  - id: planning
    title: Planning
    type: group
    children:
      - id: task_list
        title: Tasks
        type: note
        path: Planning/Tasks.md
        alias: tasks
      - id: decisions
        title: Decisions
        type: note
        path: Planning/Decisions.md
        alias: decisions
  - id: architecture
    title: Architecture
    type: note
    path: Technical/Architecture.md
```

Groups organize the tree and do not represent notes. Note paths must be vault-relative Markdown paths. Synchronization changes retrieval configuration only; it never creates, moves, renames, or deletes vault notes.

## Skills needed for this MCP

MCP tools provide capabilities; agent skills provide the rules for using those capabilities consistently. A practical skill set is:

1. **Vault safety and registration** — list registered vaults, use vault names rather than arbitrary paths, respect read-only mode, and keep paths vault-relative.
2. **Bounded retrieval** — search first, expand only the returned references, cap result counts, and avoid loading the entire vault.
3. **Project knowledge read/write** — map notes to roles such as tasks, decisions, risks, and changelog; write through the canonical knowledge interface when one exists.
4. **Index maintenance** — parse Markdown, chunk notes, hash content, update BM25 records, generate local embeddings, update pgvector rows, and remove stale chunks after a note changes.
5. **Hybrid ranking** — combine lexical BM25 and vector candidates, rerank them, and return paths, excerpts, scores, and citations.
6. **Verification and synchronization** — distinguish agent-reported completion from verified completion, record source evidence, and report stale or conflicting notes.
7. **Privacy and exclusions** — keep secrets, credentials, environment files, logs, dependencies, and generated output out of retrieval and embeddings.

This repository includes an agent skill at [`.codex/skills/project-to-obsidian/SKILL.md`](.codex/skills/project-to-obsidian/SKILL.md). Its intended flow is:

```text
get_project_snapshot
        ↓
search_project_context
        ↓
expand_project_context (only the needed references)
        ↓
write_project_knowledge (when a change is needed)
        ↓
get_project_sync_status
```

If hybrid embeddings or reranking are unavailable, the skill should fall back to exact/BM25 results and clearly report that degraded mode.

## Adding the skill flow to `AGENTS.md`

Add the following block to the repository’s root `AGENTS.md` so agents follow the same retrieval and writing workflow. On Windows, `AGENTS.md` and `agents.md` refer to the same filename, but `AGENTS.md` is the conventional spelling.

```markdown
## Project knowledge through ObsidianConnector

When a task needs project context, decisions, tasks, risks, changelog entries,
or other project knowledge:

1. Use the `project-to-obsidian` skill from
   `.codex/skills/project-to-obsidian/SKILL.md`.
2. Start with `get_project_snapshot` for the exact current worktree and task.
3. Use `search_project_context` before opening notes. Use `exact` or `auto` for
   paths, symbols, routes, tables, IDs, and worktree names; use `hybrid` for
   conceptual questions.
4. Use `expand_project_context` only for the returned references needed for the
   task. Never recursively load the whole vault.
5. Keep retrieval bounded. Respect every returned budget, warning, omission,
   freshness value, hash, and continuation cursor.
6. Use `write_project_knowledge` for project-knowledge changes. Include source
   evidence for executable behavior and carry the snapshot revision and item
   versions for optimistic writes.
7. Run `get_project_sync_status` after writes. Treat stale documentation,
   conflicts, and unverified completion as follow-up work.
8. If embeddings or reranking are unavailable, use the exact/BM25 results and
   report the degraded-search warning.
9. Never put secrets, credentials, environment files, logs, dependencies, or
   build output into general retrieval or embeddings.
```

The exact tool names in this block assume the SQL-backed project-knowledge connector described above. The current local filesystem server exposes the vault and note tools listed in the [tool reference](#tool-reference-and-example-prompts); add the project-knowledge tools when that backend is available.

## What you need to set up

You need:

- Windows with Node.js 20 or newer and npm (WSL/Linux is also supported).
- One or more local Obsidian vault directories.
- A registered-vault file at `config/vaults.json`, or a custom path supplied through `OBSIDIAN_MCP_CONFIG`.
- A local MCP client such as Codex CLI, Codex IDE, or ChatGPT Desktop.

You do not need an API key, an HTTP server, a database, a cloud service, or an Obsidian plugin. The connector runs as a local STDIO process, and the model can access only the vaults you explicitly register.

Minimum setup:

1. Install Node.js 20+ and npm.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env`.
4. Create `config/vaults.json` and add each vault path you want to expose. Use valid JSON escaping for Windows paths, for example `C:\\Users\\USERNAME\\Documents\\Obsidian\\Personal`.
5. Build the server with `npm run build`.
6. Register `dist/index.js` as a local STDIO MCP server in your client. The client command is `node`, with the absolute path to `dist/index.js` as its argument.
7. Start with the prompt: “List my registered Obsidian vaults.”

For a ready-to-edit registry example, see [`examples/vaults.example.json`](examples/vaults.example.json). The detailed client-specific commands are below.

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
- `initialize_project`: “Initialize `.obsidian-local` for the current workspace using the registered `personal` vault.”
- `sync_project_config`: “Synchronize the edited `.obsidian-local/mapping.yaml` into the `personal` vault mapping without changing vault notes.”
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

After synchronization, the registry stores a flattened compatibility view of the tree. For example, a nested `planning.task_list` note with the `tasks` alias becomes:

```json
{
  "codebaseIndex": {
    "roles": {
      "planning.task_list": "Planning/Tasks.md"
    },
    "aliases": {
      "tasks": "planning.task_list"
    }
  }
}
```

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
