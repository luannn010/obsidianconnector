export interface KnowledgeMigration {
  id: string;
  sql: string;
}

export const knowledgeMigrations: KnowledgeMigration[] = [
  {
    id: '0001_project_knowledge_core',
    sql: String.raw`
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
CREATE SCHEMA IF NOT EXISTS project_knowledge;

CREATE TABLE IF NOT EXISTS project_knowledge.schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_knowledge.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  project_key text NOT NULL UNIQUE, name text NOT NULL, db_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_knowledge.repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  name text NOT NULL, root_path text NOT NULL, default_branch text, UNIQUE(project_id, root_path)
);
CREATE TABLE IF NOT EXISTS project_knowledge.worktrees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  repository_id uuid NOT NULL REFERENCES project_knowledge.repositories(id), path text NOT NULL,
  branch text, head_commit text NOT NULL, dirty_hash text, registered boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, path)
);
CREATE TABLE IF NOT EXISTS project_knowledge.source_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  worktree_id uuid NOT NULL REFERENCES project_knowledge.worktrees(id), head_commit text NOT NULL,
  dirty_hash text, dirty_paths text[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('building','active','failed','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS source_snapshots_one_active_worktree
  ON project_knowledge.source_snapshots(worktree_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS source_snapshots_active_lookup
  ON project_knowledge.source_snapshots(project_id,worktree_id,activated_at DESC) WHERE state='active';
CREATE INDEX IF NOT EXISTS worktrees_repository_project
  ON project_knowledge.worktrees(repository_id,project_id);
CREATE TABLE IF NOT EXISTS project_knowledge.knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  kind text NOT NULL, stable_key text NOT NULL, title text NOT NULL, current_version integer NOT NULL DEFAULT 1,
  delivery_status text, verification_status text NOT NULL DEFAULT 'unverified',
  domain text, service text, superseded_by uuid REFERENCES project_knowledge.knowledge_items(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, stable_key)
);
CREATE TABLE IF NOT EXISTS project_knowledge.knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid NOT NULL REFERENCES project_knowledge.knowledge_items(id), version integer NOT NULL,
  body_markdown text NOT NULL DEFAULT '', properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical_hash text NOT NULL, actor text NOT NULL, task_id text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(item_id, version)
);
CREATE TABLE IF NOT EXISTS project_knowledge.knowledge_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  source_item_id uuid NOT NULL REFERENCES project_knowledge.knowledge_items(id),
  target_item_id uuid NOT NULL REFERENCES project_knowledge.knowledge_items(id), relation_type text NOT NULL,
  UNIQUE(source_item_id, target_item_id, relation_type)
);
CREATE TABLE IF NOT EXISTS project_knowledge.source_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid NOT NULL REFERENCES project_knowledge.knowledge_items(id), snapshot_id uuid REFERENCES project_knowledge.source_snapshots(id),
  evidence_type text NOT NULL, source_path text NOT NULL, source_ref text, source_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS project_knowledge.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid NOT NULL UNIQUE REFERENCES project_knowledge.knowledge_items(id), status text NOT NULL,
  verification_status text NOT NULL DEFAULT 'unverified', owner text, blocker text
);
CREATE TABLE IF NOT EXISTS project_knowledge.status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  work_item_id uuid NOT NULL REFERENCES project_knowledge.work_items(id), from_status text, to_status text NOT NULL,
  actor text NOT NULL, task_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_knowledge.worktree_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  worktree_id uuid NOT NULL REFERENCES project_knowledge.worktrees(id), work_item_id uuid NOT NULL REFERENCES project_knowledge.work_items(id),
  UNIQUE(worktree_id, work_item_id)
);
CREATE TABLE IF NOT EXISTS project_knowledge.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid REFERENCES project_knowledge.knowledge_items(id), name text NOT NULL, deployable boolean NOT NULL DEFAULT false,
  owner text, UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS project_knowledge.domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid REFERENCES project_knowledge.knowledge_items(id), name text NOT NULL, service_id uuid REFERENCES project_knowledge.services(id),
  UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS project_knowledge.domain_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  domain_id uuid NOT NULL REFERENCES project_knowledge.domains(id), name text NOT NULL, object_type text NOT NULL, properties jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS project_knowledge.object_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  source_object_id uuid NOT NULL REFERENCES project_knowledge.domain_objects(id), target_object_id uuid NOT NULL REFERENCES project_knowledge.domain_objects(id),
  relation_type text NOT NULL, label text
);
CREATE TABLE IF NOT EXISTS project_knowledge.sequence_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid REFERENCES project_knowledge.knowledge_items(id), domain_id uuid NOT NULL REFERENCES project_knowledge.domains(id),
  name text NOT NULL, implementation_status text NOT NULL DEFAULT 'planned'
);
CREATE TABLE IF NOT EXISTS project_knowledge.sequence_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  flow_id uuid NOT NULL REFERENCES project_knowledge.sequence_flows(id), participant_order integer NOT NULL, alias text NOT NULL, label text NOT NULL
);
CREATE TABLE IF NOT EXISTS project_knowledge.sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  flow_id uuid NOT NULL REFERENCES project_knowledge.sequence_flows(id), step_order integer NOT NULL,
  source_alias text NOT NULL, target_alias text NOT NULL, message text NOT NULL, response boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS project_knowledge.api_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  service_key text NOT NULL, title text NOT NULL, base_path text, UNIQUE(project_id, service_key)
);
CREATE TABLE IF NOT EXISTS project_knowledge.api_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid REFERENCES project_knowledge.knowledge_items(id), api_service_id uuid NOT NULL REFERENCES project_knowledge.api_services(id),
  method text NOT NULL, route text NOT NULL, description text NOT NULL, auth jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_contract jsonb NOT NULL DEFAULT '{}'::jsonb, response_contracts jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb, idempotency text, side_effects text,
  implementation_status text NOT NULL, verified_git_revision text, UNIQUE(project_id, api_service_id, method, route)
);
CREATE TABLE IF NOT EXISTS project_knowledge.api_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  endpoint_id uuid NOT NULL REFERENCES project_knowledge.api_endpoints(id), example_type text NOT NULL,
  status_code integer, title text NOT NULL, payload jsonb NOT NULL, evidence_id uuid REFERENCES project_knowledge.source_evidence(id)
);
CREATE TABLE IF NOT EXISTS project_knowledge.api_schema_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  api_service_id uuid NOT NULL REFERENCES project_knowledge.api_services(id), name text NOT NULL, schema_json jsonb NOT NULL,
  UNIQUE(api_service_id, name)
);
CREATE TABLE IF NOT EXISTS project_knowledge.documented_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  name text NOT NULL, description text, UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS project_knowledge.documented_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  schema_id uuid NOT NULL REFERENCES project_knowledge.documented_schemas(id), name text NOT NULL, description text,
  owning_service text, migration_path text, UNIQUE(project_id, schema_id, name)
);
CREATE TABLE IF NOT EXISTS project_knowledge.documented_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  table_id uuid NOT NULL REFERENCES project_knowledge.documented_tables(id), name text NOT NULL, data_type text NOT NULL,
  nullable boolean NOT NULL, default_expression text, ordinal integer NOT NULL, UNIQUE(table_id, name)
);
CREATE TABLE IF NOT EXISTS project_knowledge.documented_constraints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  table_id uuid NOT NULL REFERENCES project_knowledge.documented_tables(id), name text NOT NULL, constraint_type text NOT NULL, definition text NOT NULL
);
CREATE TABLE IF NOT EXISTS project_knowledge.documented_indexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  table_id uuid NOT NULL REFERENCES project_knowledge.documented_tables(id), name text NOT NULL, definition text NOT NULL
);
CREATE TABLE IF NOT EXISTS project_knowledge.documented_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  source_table_id uuid NOT NULL REFERENCES project_knowledge.documented_tables(id), target_table_id uuid NOT NULL REFERENCES project_knowledge.documented_tables(id),
  source_columns text[] NOT NULL, target_columns text[] NOT NULL, relationship_type text NOT NULL
);
CREATE TABLE IF NOT EXISTS project_knowledge.documented_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  path text NOT NULL, source_hash text NOT NULL, migration_order integer, UNIQUE(project_id, path)
);
CREATE TABLE IF NOT EXISTS project_knowledge.physical_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  domain text, service text, object_name text, code_symbol text, schema_name text NOT NULL, table_name text NOT NULL,
  column_name text, access_mode text NOT NULL CHECK (access_mode IN ('owner','read','write','read_write'))
);
CREATE TABLE IF NOT EXISTS project_knowledge.code_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  snapshot_id uuid NOT NULL REFERENCES project_knowledge.source_snapshots(id), repo_relative_path text NOT NULL,
  language text, source_hash text NOT NULL, deleted boolean NOT NULL DEFAULT false, UNIQUE(snapshot_id, repo_relative_path)
);
CREATE TABLE IF NOT EXISTS project_knowledge.code_symbols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  snapshot_id uuid NOT NULL REFERENCES project_knowledge.source_snapshots(id), file_id uuid NOT NULL REFERENCES project_knowledge.code_files(id),
  qualified_name text NOT NULL, symbol_kind text NOT NULL, signature text, start_line integer, end_line integer,
  UNIQUE(snapshot_id, qualified_name, file_id)
);
CREATE TABLE IF NOT EXISTS project_knowledge.embedding_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  model_name text NOT NULL, model_revision text NOT NULL, dimensions integer NOT NULL, active boolean NOT NULL DEFAULT false,
  UNIQUE(project_id, model_name, model_revision)
);
CREATE TABLE IF NOT EXISTS project_knowledge.search_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  item_id uuid REFERENCES project_knowledge.knowledge_items(id), snapshot_id uuid REFERENCES project_knowledge.source_snapshots(id),
  parent_ref text, kind text NOT NULL, domain text, service text, worktree_id uuid REFERENCES project_knowledge.worktrees(id),
  title text NOT NULL, content text NOT NULL, content_hash text NOT NULL, token_count integer NOT NULL,
  embedding vector(384), embedding_model_id uuid REFERENCES project_knowledge.embedding_models(id), active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE project_knowledge.search_chunks ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS search_chunks_snapshot ON project_knowledge.search_chunks (project_id, snapshot_id);
CREATE INDEX IF NOT EXISTS search_chunks_exact_path ON project_knowledge.search_chunks(project_id,lower(metadata->>'path')) WHERE active;
CREATE INDEX IF NOT EXISTS search_chunks_exact_symbol ON project_knowledge.search_chunks(project_id,lower(metadata->>'symbol')) WHERE active;
CREATE INDEX IF NOT EXISTS search_chunks_active_item ON project_knowledge.search_chunks(project_id,item_id) WHERE active;
CREATE INDEX IF NOT EXISTS search_chunks_exact_title ON project_knowledge.search_chunks(project_id,lower(title)) WHERE active;
CREATE INDEX IF NOT EXISTS search_chunks_exact_endpoint ON project_knowledge.search_chunks(project_id,lower(metadata->>'endpoint')) WHERE active;
CREATE INDEX IF NOT EXISTS search_chunks_exact_schema_table ON project_knowledge.search_chunks(project_id,lower(metadata->>'schema_table')) WHERE active;
CREATE INDEX IF NOT EXISTS search_chunks_parent_ref ON project_knowledge.search_chunks(project_id,parent_ref) WHERE active;
CREATE INDEX IF NOT EXISTS search_chunks_embedding_hnsw ON project_knowledge.search_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS search_chunks_content_bm25 ON project_knowledge.search_chunks
  USING bm25 (id, content, title, project_id, active, snapshot_id, kind, domain, service, worktree_id)
  WITH (key_field='id');
CREATE TABLE IF NOT EXISTS project_knowledge.note_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  view_id text NOT NULL, relative_path text NOT NULL, db_revision bigint NOT NULL, canonical_hash text NOT NULL,
  projection_hash text NOT NULL, observed_hash text, last_published_hash text,
  state text NOT NULL CHECK (state IN ('current','pending','drifted','missing','failed')),
  error_message text, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, view_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS note_projections_output_path
  ON project_knowledge.note_projections(project_id,relative_path);
CREATE INDEX IF NOT EXISTS note_projections_state_path
  ON project_knowledge.note_projections(project_id,state,relative_path);
CREATE TABLE IF NOT EXISTS project_knowledge.outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  job_type text NOT NULL, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_jobs_claimable
  ON project_knowledge.outbox_jobs(job_type,available_at,created_at)
  WHERE state IN ('pending','failed');
CREATE TABLE IF NOT EXISTS project_knowledge.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, status text NOT NULL, summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS project_knowledge.inbox_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  relative_path text NOT NULL, source_hash text NOT NULL, state text NOT NULL, item_id uuid REFERENCES project_knowledge.knowledge_items(id),
  error_message text, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_imports_source ON project_knowledge.inbox_imports(project_id,relative_path,source_hash);
CREATE TABLE IF NOT EXISTS project_knowledge.projection_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  projection_id uuid NOT NULL REFERENCES project_knowledge.note_projections(id), expected_hash text NOT NULL, observed_hash text NOT NULL,
  preserved_path text NOT NULL, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projection_conflicts_unresolved
  ON project_knowledge.projection_conflicts(project_id,created_at)
  WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS project_knowledge.legacy_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id),
  original_path text NOT NULL, archive_path text, raw_hash text NOT NULL, size_bytes bigint NOT NULL, modified_at timestamptz,
  frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb, outbound_links text[] NOT NULL DEFAULT '{}', body_markdown text,
  content_omitted_reason text, imported_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, original_path)
);
`,
  },
];
