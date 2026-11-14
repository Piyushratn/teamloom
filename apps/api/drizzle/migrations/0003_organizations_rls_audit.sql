-- Migration 0003: Organizations, Memberships, Invites, Append-Only Audit Logs, and Row-Level Security

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ai_kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_ai_budget_usd_cents INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations (slug);
CREATE INDEX IF NOT EXISTS idx_organizations_owner_id ON organizations (owner_id);

CREATE TABLE IF NOT EXISTS organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  guest_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON organization_members (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON organization_members (user_id);

CREATE TABLE IF NOT EXISTS organization_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  guest_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_org_id ON organization_invites (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_token_hash ON organization_invites (token_hash);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action ON audit_logs (organization_id, action);

-- Enforce strict append-only behavior on audit_logs via trigger
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'audit_logs table is strictly append-only; UPDATE and DELETE are forbidden'; END; $$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_mutation();

-- Enable and Force Row-Level Security (RLS) on tenant-scoped tables
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;

ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invites FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- RLS Policy for organization_members:
-- Tenant context matches organization_id OR user is querying their own memberships across orgs
DROP POLICY IF EXISTS organization_members_tenant_isolation ON organization_members;
CREATE POLICY organization_members_tenant_isolation ON organization_members
  FOR ALL
  TO teamloom_app
  USING (
    organization_id = app_current_organization_id()
    OR user_id = app_current_user_id()
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
  );

-- RLS Policy for organization_invites: strictly isolated to app_current_organization_id()
DROP POLICY IF EXISTS organization_invites_tenant_isolation ON organization_invites;
CREATE POLICY organization_invites_tenant_isolation ON organization_invites
  FOR ALL
  TO teamloom_app
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- RLS Policy for audit_logs: strictly isolated to app_current_organization_id()
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  FOR ALL
  TO teamloom_app
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- Grant permissions to teamloom_app (note: audit_logs only gets SELECT and INSERT!)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE organizations, organization_members, organization_invites TO teamloom_app;
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM teamloom_app;
GRANT SELECT, INSERT ON TABLE audit_logs TO teamloom_app;