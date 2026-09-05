\if :{?knowledge_password}
\else
  \error knowledge_password psql variable is required
\endif

SELECT format('CREATE ROLE knowledge_connector LOGIN PASSWORD %L', :'knowledge_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_connector') \gexec
SELECT format('ALTER ROLE knowledge_connector PASSWORD %L', :'knowledge_password') \gexec
ALTER ROLE knowledge_connector SET statement_timeout='5s';
ALTER ROLE knowledge_connector SET search_path=project_knowledge,public;
REVOKE ALL ON SCHEMA public FROM knowledge_connector;
GRANT CONNECT ON DATABASE :DBNAME TO knowledge_connector;
GRANT USAGE ON SCHEMA project_knowledge TO knowledge_connector;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA project_knowledge TO knowledge_connector;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA project_knowledge TO knowledge_connector;
ALTER DEFAULT PRIVILEGES IN SCHEMA project_knowledge GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO knowledge_connector;
ALTER DEFAULT PRIVILEGES IN SCHEMA project_knowledge GRANT USAGE,SELECT ON SEQUENCES TO knowledge_connector;
