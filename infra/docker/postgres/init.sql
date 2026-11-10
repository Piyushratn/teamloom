-- Enable required extensions for UUIDs, cryptography, and vector search
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Create non-superuser role for application connections so Row-Level Security (RLS) is strictly enforced
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'teamloom_app') THEN
    CREATE ROLE teamloom_app WITH LOGIN PASSWORD 'teamloom_app_local_pw' NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE teamloom_dev TO teamloom_app;
GRANT USAGE ON SCHEMA public TO teamloom_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO teamloom_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO teamloom_app;