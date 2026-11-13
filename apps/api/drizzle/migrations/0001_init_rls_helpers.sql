-- Migration 0001: Initialize extensions, RLS tenant context helper functions, and permissions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Helper function: returns the current transaction's active organization_id (or NULL if unset)
CREATE OR REPLACE FUNCTION app_current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
$$;

-- Helper function: returns the current transaction's active user_id (or NULL if unset)
CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

-- Ensure restricted application role exists and has permissions on public schema
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'teamloom_app') THEN
    CREATE ROLE teamloom_app WITH LOGIN PASSWORD 'teamloom_app_local_pw' NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO teamloom_app;
GRANT EXECUTE ON FUNCTION app_current_organization_id() TO teamloom_app;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO teamloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO teamloom_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO teamloom_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO teamloom_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO teamloom_app;