# Local Obsidian MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with TDD checkpoints. Steps use checkbox syntax for tracking.

**Goal:** Build a Windows-first local TypeScript MCP STDIO server that safely manages Markdown notes in multiple explicitly registered Obsidian vaults.

**Architecture:** A thin MCP adapter layer validates tool input and maps service results to structured responses. Configuration, vault registration, path security, filesystem writes, search, frontmatter, and daily notes are separate services; all note paths pass through one canonical security boundary.

**Tech Stack:** Node.js 20+, TypeScript, `@modelcontextprotocol/sdk`, Zod, Vitest, gray-matter, ESLint, Prettier, npm.

## Global Constraints

- STDIO only; no HTTP server, OAuth, tunnel, database, web hosting, or custom UI.
- Multiple vaults are supported only through the local registry; no arbitrary filesystem access.
- Never modify a real vault in automated tests; use temporary vaults.
- Reject absolute paths, traversal, null bytes, symlink escapes, `.obsidian`, `.trash`, `node_modules`, and hidden directories by default.
- Restrict note operations to Markdown files.
- Send diagnostics to stderr; stdout is reserved for MCP protocol messages.
- All tools set `openWorldHint: false`; read tools set `readOnlyHint: true`; `delete_note` is destructive.
- Use atomic writes and return affected vault, relative path, and SHA-256 content hash after writes.

## File Map

- Create `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.env.example`.
- Create `src/index.ts`, `src/server.ts`, `src/types/index.ts`.
- Create `src/config/schema.ts`, `src/config/registry.ts`.
- Create `src/security/path-security.ts`, `src/security/errors.ts`.
- Create `src/services/filesystem-service.ts`, `src/services/search-service.ts`, `src/services/frontmatter-service.ts`, `src/services/daily-note-service.ts`.
- Create `src/tools/vault-tools.ts`, `src/tools/directory-tools.ts`, `src/tools/file-tools.ts`, `src/tools/obsidian-tools.ts`, `src/tools/tool-utils.ts`.
- Create `tests/unit/config.test.ts`, `tests/unit/path-security.test.ts`, `tests/unit/filesystem-service.test.ts`, `tests/unit/search-service.test.ts`, `tests/unit/frontmatter-service.test.ts`, `tests/unit/daily-note-service.test.ts`.
- Create `tests/integration/server.integration.test.ts`, `tests/helpers/temp-vault.ts`.
- Create `examples/vaults.example.json`, `README.md`.

---

### Task 1: Bootstrap the TypeScript project

**Files:** package manifests/configuration files listed above; `tests/unit/smoke.test.ts`.

- [ ] Write a smoke test importing a tiny exported `projectVersion` constant from `src/types/index.ts` and asserting it is a string.
- [ ] Run `npm test -- tests/unit/smoke.test.ts`; expect failure because the project is not scaffolded.
- [ ] Create npm scripts: `build`, `test`, `test:watch`, `lint`, `format`, `format:check`, `typecheck`, `dev`, and `start`.
- [ ] Add runtime dependencies `@modelcontextprotocol/sdk`, `zod`, `gray-matter`, and `yaml`; add development dependencies `typescript`, `tsx`, `vitest`, `@types/node`, `eslint`, `@eslint/js`, `typescript-eslint`, and `prettier`.
- [ ] Add `src/types/index.ts` with the version constant and shared result/error types.
- [ ] Run the smoke test, typecheck, lint, and format check; all must pass.

### Task 2: Configuration and registered-vault registry

**Files:** `src/config/schema.ts`, `src/config/registry.ts`, `tests/unit/config.test.ts`.

- [ ] Write tests for default config path, `OBSIDIAN_MCP_CONFIG` override, valid multi-vault parsing, invalid duplicate/empty names, daily-note defaults, and atomic registry persistence.
- [ ] Run the focused tests and confirm they fail for missing modules/functions.
- [ ] Implement Zod schemas and a `VaultRegistry` with `load()`, `list()`, `get(name)`, `register()`, `unregister()`, and `create()`; use a temporary sibling file plus rename for config writes.
- [ ] Ensure `create()` creates the requested root and registers it, while `register()` requires an existing directory.
- [ ] Run focused tests and then the full unit suite.

### Task 3: Canonical path security

**Files:** `src/security/path-security.ts`, `src/security/errors.ts`, `tests/unit/path-security.test.ts`.

- [ ] Write tests for valid relative Markdown paths, absolute-path rejection, `..` rejection, null-byte rejection, excluded directories, non-Markdown rejection, missing-parent resolution, and symlink escape rejection.
- [ ] Run focused tests and confirm the expected missing-implementation failures.
- [ ] Implement `resolveVaultPath(root, relativePath, options)` using `path.resolve`, `fs.realpath`, parent realpath checks, Windows case-insensitive containment, and explicit segment validation.
- [ ] Expose typed security errors that tool adapters can map to safe concise messages without leaking unrelated absolute paths.
- [ ] Run focused tests, including Windows symlink behavior when available, and the full unit suite.

### Task 4: Atomic Markdown filesystem operations

**Files:** `src/services/filesystem-service.ts`, `tests/unit/filesystem-service.test.ts`, `tests/helpers/temp-vault.ts`.

- [ ] Write tests for listing directories/notes, create-without-overwrite, explicit overwrite, expected-hash update conflicts, append, collision-safe trash deletion, move destination conflicts, read-only enforcement, and returned SHA-256 hashes.
- [ ] Run focused tests and confirm failure before implementation.
- [ ] Implement `FilesystemService` around an injected `VaultRegistry` and `PathSecurity`, with atomic UTF-8 writes and Markdown-only note operations.
- [ ] Ignore `.obsidian`, `.trash`, `node_modules`, hidden directories, and non-Markdown files in traversals.
- [ ] Run focused tests and full unit tests.

### Task 5: Search, frontmatter, and daily notes

**Files:** `src/services/search-service.ts`, `src/services/frontmatter-service.ts`, `src/services/daily-note-service.ts`, corresponding unit tests.

- [ ] Write tests for filename/content/tag/frontmatter search with limits and excerpts; frontmatter extraction/merge preserving body; daily-note defaults, configurable directory/date format, creation, and append-only behavior.
- [ ] Run focused tests and confirm red failures.
- [ ] Implement bounded recursive search, gray-matter parse/stringify with body preservation, and a date-format adapter supporting `YYYY-MM-DD` plus configured patterns needed by the registry.
- [ ] Run focused tests and full unit tests.

### Task 6: MCP tool adapters and server registration

**Files:** `src/tools/tool-utils.ts`, all four tool modules, `src/server.ts`, `src/index.ts`, `tests/integration/server.integration.test.ts`.

- [ ] Write integration tests that instantiate the server against a temporary config/vault and exercise representative valid and invalid calls for every required tool name.
- [ ] Run the integration tests and confirm failure because handlers are absent.
- [ ] Implement all required tools: `list_vaults`, `get_vault`, `create_vault`, `register_vault`, `unregister_vault`; `list_directory`, `create_directory`; all 11 file tools; and the five Obsidian-specific tools.
- [ ] Give every input an explicit Zod schema, set annotations consistently, return concise text and JSON-serializable `structuredContent`, and centralize safe error mapping.
- [ ] Keep `src/index.ts` limited to config loading, server construction, STDIO transport startup, and stderr diagnostics.
- [ ] Run integration tests, typecheck, lint, and the complete test suite.

### Task 7: Documentation and client configuration

**Files:** `README.md`, `.env.example`, `examples/vaults.example.json`.

- [ ] Write documentation checks as a small test or scripted assertion that the README contains every required tool name, Windows PowerShell setup, WSL/Linux setup, ChatGPT Desktop, Codex CLI, Codex IDE, troubleshooting, and the exact registration command.
- [ ] Run the documentation check and confirm it fails before content exists.
- [ ] Document secure registration, multiple-vault listing/selection, examples for every major tool, read-only behavior, test-vault guidance, and stdout/stderr constraints.
- [ ] Run the documentation check and full formatting/lint checks.

### Task 8: Full verification and MCP Inspector evidence

**Files:** `tests/integration/server.integration.test.ts`; no production changes unless a failing verification exposes a defect.

- [ ] Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` from a clean working tree state.
- [ ] Start `node dist/index.js` with a temporary config and verify stdout contains only MCP protocol output while diagnostics, if any, are on stderr.
- [ ] Run representative valid/invalid MCP requests, including traversal and symlink escape cases, against temporary vaults.
- [ ] Run MCP Inspector against `dist/index.js`, inspect the complete tool list and representative schemas/results, and record the exact command using the actual absolute `dist/index.js` path.
- [ ] Re-run all verification commands after any fix and inspect `git diff`/`git status` before reporting completion.
