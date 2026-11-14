-- Migration 0007: AI Usage Ledger & Approval-Gated Proposed Actions with Row-Level Security

CREATE TABLE IF NOT EXISTS ai_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  feature TEXT NOT NULL CHECK (feature IN ('copilot_ask', 'project_triage', 'sprint_plan')),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_cents INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_org_created
  ON ai_usage_ledger (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proposed_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type IN ('create_task', 'update_task', 'create_document')),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  executed_resource_id UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposed_actions_org_status
  ON proposed_actions (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proposed_actions_project
  ON proposed_actions (organization_id, project_id);

-- Enable and Force Row-Level Security (RLS)
ALTER TABLE ai_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_ledger FORCE ROW LEVEL SECURITY;

ALTER TABLE proposed_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_ledger_tenant_isolation ON ai_usage_ledger;
CREATE POLICY ai_usage_ledger_tenant_isolation ON ai_usage_ledger
  FOR ALL
  TO teamloom_app
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

DROP POLICY IF EXISTS proposed_actions_tenant_isolation ON proposed_actions;
CREATE POLICY proposed_actions_tenant_isolation ON proposed_actions
  FOR ALL
  TO teamloom_app
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_usage_ledger, proposed_actions TO teamloom_app;