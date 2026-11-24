-- The default Agent Invocation journal file that @vite-hub/agent 0.4.1 wrote at .vitehub/data/agent-invocations.sqlite.
-- Written with the published 0.4.1 package (openDefaultLibsqlJournal and its store), then dumped as SQL. Do not edit.
CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        search TEXT,
        search_version INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        capability_ids TEXT,
        updated_at TEXT NOT NULL DEFAULT '',
        record TEXT NOT NULL
      );
CREATE TABLE vitehub_agent_invocations_claims (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL
      );
CREATE TABLE vitehub_agent_invocations_observations (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_sequence INTEGER NOT NULL,
        observation TEXT NOT NULL
      );
INSERT INTO vitehub_agent_invocations (sequence, id, status, agent_name, search, search_version, summary, capability_ids, updated_at, record) VALUES (1, 'inv-041-completed', 'completed', 'support', '[["id","inv-041-completed","agentname","support","traceid","trace-1","status","completed","createdat","2026-11-01t10:00:00.000z","updatedat","2026-11-01t10:01:00.000z","input","prompt","where is my order?","completedat"],["agent.tool.call","2026-11-01t10:00:00.000z","run","tool.name","orders.lookup","vitehub.observation.id","obs-1","vitehub.observation.appended",true]]', 3, '{"id":"inv-041-completed","agentName":"support","traceId":"trace-1","status":"completed","createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:01:00.000Z","input":{"prompt":"Where is my order?"},"completedAt":"2026-11-01T10:01:00.000Z"}', NULL, '2026-11-01T10:01:00.000Z', '{"id":"inv-041-completed","agentName":"support","traceId":"trace-1","status":"completed","createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:01:00.000Z","observations":[{"attributes":{"tool.name":"orders.lookup","vitehub.observation.id":"obs-1","vitehub.observation.appended":true},"name":"agent.tool.call","timestamp":"2026-11-01T10:00:00.000Z","type":"run","sequence":1}],"input":{"prompt":"Where is my order?"},"completedAt":"2026-11-01T10:01:00.000Z"}');
INSERT INTO vitehub_agent_invocations (sequence, id, status, agent_name, search, search_version, summary, capability_ids, updated_at, record) VALUES (2, 'inv-041-failed', 'failed', 'billing', '[["id","inv-041-failed","agentname","billing","traceid","trace-2","status","failed","createdat","2026-11-01t10:02:00.000z","updatedat","2026-11-01t10:03:00.000z","error","message","card declined","failedat"],[]]', 3, '{"id":"inv-041-failed","agentName":"billing","traceId":"trace-2","status":"failed","createdAt":"2026-11-01T10:02:00.000Z","updatedAt":"2026-11-01T10:03:00.000Z","error":{"message":"card declined"},"failedAt":"2026-11-01T10:03:00.000Z"}', NULL, '2026-11-01T10:03:00.000Z', '{"id":"inv-041-failed","agentName":"billing","traceId":"trace-2","status":"failed","createdAt":"2026-11-01T10:02:00.000Z","updatedAt":"2026-11-01T10:03:00.000Z","observations":[],"error":{"message":"card declined"},"failedAt":"2026-11-01T10:03:00.000Z"}');
CREATE TRIGGER vitehub_agent_invocations_capability_ids_update_v2
        AFTER UPDATE OF record ON vitehub_agent_invocations
        WHEN NEW.capability_ids IS NOT NULL
        BEGIN
          UPDATE vitehub_agent_invocations SET capability_ids = NULL WHERE sequence = NEW.sequence;
        END;
CREATE TRIGGER vitehub_agent_invocations_legacy_updated_at_insert
        AFTER INSERT ON vitehub_agent_invocations
        WHEN NEW.updated_at = '' OR NEW.updated_at IS NULL
        BEGIN
          UPDATE vitehub_agent_invocations SET updated_at = COALESCE(json_extract(NEW.record, '$.updatedAt'), '') WHERE sequence = NEW.sequence;
        END;
CREATE TRIGGER vitehub_agent_invocations_legacy_lifecycle_update_v2
        AFTER UPDATE OF record ON vitehub_agent_invocations
        WHEN NEW.updated_at IS OLD.updated_at
        BEGIN
          UPDATE vitehub_agent_invocations SET
            status = COALESCE(json_extract(NEW.record, '$.status'), NEW.status),
            updated_at = COALESCE(json_extract(NEW.record, '$.updatedAt'), '')
          WHERE sequence = NEW.sequence;
        END;
CREATE TRIGGER vitehub_agent_invocations_stale_legacy_search_update_v2
        AFTER UPDATE OF search, record ON vitehub_agent_invocations
        WHEN NEW.search_version = OLD.search_version AND NEW.search_version <> 0
        BEGIN
          UPDATE vitehub_agent_invocations SET search_version = 0 WHERE sequence = NEW.sequence;
        END;
CREATE TRIGGER vitehub_agent_invocations_legacy_summary_insert
        AFTER INSERT ON vitehub_agent_invocations
        WHEN NEW.summary IS NULL
        BEGIN
          UPDATE vitehub_agent_invocations SET summary = CASE WHEN json_valid(NEW.record)
            THEN json_remove(NEW.record, '$.observations') END WHERE sequence = NEW.sequence;
        END;
CREATE TRIGGER vitehub_agent_invocations_legacy_summary_update
        AFTER UPDATE OF record ON vitehub_agent_invocations
        WHEN NEW.summary IS OLD.summary
        BEGIN
          UPDATE vitehub_agent_invocations SET summary = CASE WHEN json_valid(NEW.record)
            THEN json_remove(NEW.record, '$.observations') END WHERE sequence = NEW.sequence;
        END;
CREATE INDEX vitehub_agent_invocations_missing_updated_at_sequence
        ON vitehub_agent_invocations (sequence) WHERE updated_at = '' OR updated_at IS NULL;
CREATE INDEX vitehub_agent_invocations_status_sequence ON vitehub_agent_invocations (status, sequence DESC);
CREATE INDEX vitehub_agent_invocations_status_updated_at ON vitehub_agent_invocations (status, updated_at);
CREATE INDEX vitehub_agent_invocations_agent_name_sequence ON vitehub_agent_invocations (agent_name, sequence DESC);
CREATE INDEX vitehub_agent_invocations_legacy_agent_name_sequence
        ON vitehub_agent_invocations (json_extract(record, '$.agentName'), sequence DESC)
        WHERE agent_name IS NULL OR agent_name = '';
CREATE INDEX vitehub_agent_invocations_agent_name_capability_ids
        ON vitehub_agent_invocations (agent_name, capability_ids) WHERE capability_ids IS NOT NULL;
CREATE INDEX vitehub_agent_invocations_sequence_capability_ids
        ON vitehub_agent_invocations (sequence DESC, capability_ids, status, agent_name, updated_at);
CREATE INDEX vitehub_agent_invocations_triggered_by_agent_name
        ON vitehub_agent_invocations (CASE WHEN json_type(CASE WHEN json_valid(summary) THEN summary ELSE record END, '$.annotations.triggeredBy') = 'text'
    THEN json_extract(CASE WHEN json_valid(summary) THEN summary ELSE record END, '$.annotations.triggeredBy') END, agent_name);
CREATE TRIGGER vitehub_agent_invocations_refresh_legacy_claim
        AFTER UPDATE OF expires_at ON vitehub_agent_invocations_claims
        WHEN NEW.claimed_at = OLD.claimed_at AND NEW.claim_token = OLD.claim_token
        BEGIN
          UPDATE vitehub_agent_invocations_claims
          SET claimed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), claim_token = lower(hex(randomblob(16)))
          WHERE id = NEW.id;
        END;
CREATE INDEX vitehub_agent_invocations_observations_invocation
        ON vitehub_agent_invocations_observations (invocation_sequence, position);
CREATE INDEX vitehub_agent_invocations_observations_invocation_name
        ON vitehub_agent_invocations_observations (invocation_sequence, json_extract(observation, '$.name'), position);
CREATE INDEX vitehub_agent_invocations_observations_invocation_sequence
        ON vitehub_agent_invocations_observations (invocation_sequence, json_extract(observation, '$.sequence'));
CREATE TRIGGER vitehub_agent_invocations_observations_delete
        AFTER DELETE ON vitehub_agent_invocations
        BEGIN
          DELETE FROM vitehub_agent_invocations_observations WHERE invocation_sequence = OLD.sequence;
        END;
