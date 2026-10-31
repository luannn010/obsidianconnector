export const workerMaintenanceMigration = {
  id: '0016_worker_maintenance_schedule',
  sql: String.raw`
CREATE TABLE IF NOT EXISTS project_knowledge.worker_maintenance_schedule (
  task_key text PRIMARY KEY,
  next_run_at timestamptz NOT NULL,
  lease_owner uuid,
  lease_expires_at timestamptz
);
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_connector') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE project_knowledge.worker_maintenance_schedule TO knowledge_connector;
  END IF;
END
$grant$;
`,
};
