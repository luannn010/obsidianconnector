// Independent epoch rows avoid taking a project-wide lock while different
// worktrees index their chunks. Source epochs are per worktree, so retaining
// more historical snapshots does not grow the validator scan. Epochs commit
// atomically with the indexed data and are never removed before their project.
export const retrievalEpochMigration = {
  id: '0015_retrieval_epochs',
  sql: String.raw`
CREATE TABLE IF NOT EXISTS project_knowledge.retrieval_epochs (
  project_id uuid NOT NULL REFERENCES project_knowledge.projects(project_id) ON DELETE CASCADE,
  source_table text NOT NULL,
  scope_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(project_id,source_table,scope_id)
);

CREATE OR REPLACE FUNCTION project_knowledge.advance_retrieval_epochs()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  rows_sql text;
  scope_expression text;
  changed_expression text := 'n IS DISTINCT FROM o';
BEGIN
  scope_expression := CASE TG_TABLE_NAME
    WHEN 'search_chunks' THEN 'COALESCE(item_id,worktree_id,project_id)'
    WHEN 'source_snapshots' THEN 'worktree_id'
    WHEN 'documentation_freshness' THEN 'worktree_id'
    WHEN 'knowledge_versions' THEN 'item_id'
    ELSE 'id' END;
  IF TG_TABLE_NAME='worktrees' THEN
    changed_expression := 'ROW(n.project_id,n.repository_id,n.path,n.branch,n.head_commit,n.dirty_hash,n.dirty_paths,n.registered)
      IS DISTINCT FROM ROW(o.project_id,o.repository_id,o.path,o.branch,o.head_commit,o.dirty_hash,o.dirty_paths,o.registered)';
  END IF;
  IF TG_OP='INSERT' THEN
    rows_sql := format('SELECT project_id,%s AS scope_id FROM new_rows',scope_expression);
  ELSIF TG_OP='DELETE' THEN
    rows_sql := format('SELECT project_id,%s AS scope_id FROM old_rows',scope_expression);
  ELSE
    -- Worktree polling updates last_seen_at even if its searchable state is
    -- unchanged. Such heartbeats must not invalidate every recall cache.
    rows_sql := format('SELECT project_id,%s AS scope_id FROM new_rows
      WHERE id IN (SELECT n.id FROM new_rows n JOIN old_rows o USING(id) WHERE %s)
      UNION ALL SELECT project_id,%s AS scope_id FROM old_rows
      WHERE id IN (SELECT o.id FROM old_rows o JOIN new_rows n USING(id) WHERE %s)',
      scope_expression,changed_expression,scope_expression,changed_expression);
  END IF;
  -- Include both scopes if an UPDATE moves a row. Sorting establishes a common
  -- lock order when a batch touches several items or source snapshots.
  EXECUTE format('INSERT INTO project_knowledge.retrieval_epochs(project_id,source_table,scope_id,revision)
    SELECT DISTINCT project_id, %L,scope_id,1
    FROM (%s) changed
    WHERE EXISTS (SELECT 1 FROM project_knowledge.projects p WHERE p.project_id=changed.project_id)
    ORDER BY 1,2,3
    ON CONFLICT(project_id,source_table,scope_id) DO UPDATE
      SET revision=retrieval_epochs.revision+1', TG_TABLE_NAME, rows_sql);
  RETURN NULL;
END
$fn$;

DO $triggers$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['search_chunks','source_snapshots','worktrees',
      'documentation_freshness','knowledge_items','knowledge_versions'] LOOP
    EXECUTE format('CREATE TRIGGER retrieval_epochs_insert AFTER INSERT ON project_knowledge.%I
      REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
      EXECUTE FUNCTION project_knowledge.advance_retrieval_epochs()',relation);
    EXECUTE format('CREATE TRIGGER retrieval_epochs_update AFTER UPDATE ON project_knowledge.%I
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
      EXECUTE FUNCTION project_knowledge.advance_retrieval_epochs()',relation);
    EXECUTE format('CREATE TRIGGER retrieval_epochs_delete AFTER DELETE ON project_knowledge.%I
      REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
      EXECUTE FUNCTION project_knowledge.advance_retrieval_epochs()',relation);
  END LOOP;
END
$triggers$;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_connector') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON project_knowledge.retrieval_epochs TO knowledge_connector;
  END IF;
END
$grant$;
`,
};
