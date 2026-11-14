-- Migration 0006: Knowledge Chunks with pgvector (768-d HNSW) + Full-Text Search (GIN) + Row-Level Security

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('document', 'task')),
  source_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  embedding vector(768) NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, source_type, source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_org_source
  ON knowledge_chunks (organization_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_org_project
  ON knowledge_chunks (organization_id, project_id);

-- HNSW index for fast approximate nearest-neighbor cosine similarity search
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- GIN index for fast lexical full-text search
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search_tsv_gin
  ON knowledge_chunks USING gin (search_tsv);

-- Enable and Force Row-Level Security (RLS)
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_chunks_tenant_isolation ON knowledge_chunks;
CREATE POLICY knowledge_chunks_tenant_isolation ON knowledge_chunks
  FOR ALL
  TO teamloom_app
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE knowledge_chunks TO teamloom_app;