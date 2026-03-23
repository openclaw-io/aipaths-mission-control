-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- New memories table (replaces agent_memory for new entries)
CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,
  type text NOT NULL DEFAULT 'journal'
    CHECK (type IN ('journal', 'strategic', 'report')),
  title text,
  content text NOT NULL,
  tags text[] DEFAULT '{}'::text[],
  date date DEFAULT CURRENT_DATE,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for vector similarity search
CREATE INDEX memories_embedding_idx ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Index for common filters
CREATE INDEX memories_agent_idx ON memories(agent);
CREATE INDEX memories_type_idx ON memories(type);
CREATE INDEX memories_date_idx ON memories(date DESC);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON memories
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Semantic search function
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  filter_agent text DEFAULT NULL,
  filter_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  agent text,
  type text,
  title text,
  content text,
  tags text[],
  date date,
  similarity float,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.agent,
    m.type,
    m.title,
    m.content,
    m.tags,
    m.date,
    1 - (m.embedding <=> query_embedding) AS similarity,
    m.created_at
  FROM memories m
  WHERE
    (filter_agent IS NULL OR m.agent = filter_agent)
    AND (filter_type IS NULL OR m.type = filter_type)
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
