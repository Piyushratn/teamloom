-- Migration 0004: Safe SECURITY DEFINER helper to resolve organization_id from an invite token_hash
-- before entering the transaction-scoped RLS context for that organization.

CREATE OR REPLACE FUNCTION lookup_invite_organization_by_hash(p_token_hash text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT organization_id
  FROM organization_invites
  WHERE token_hash = p_token_hash
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION lookup_invite_organization_by_hash(text) TO teamloom_app;