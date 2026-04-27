-- Retire legacy agent_memory table now that journal entries live in memories.
DROP TABLE IF EXISTS agent_memory;
