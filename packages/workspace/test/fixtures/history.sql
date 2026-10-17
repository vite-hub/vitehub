CREATE TABLE workspace_history_workspaces (
  workspace TEXT PRIMARY KEY,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE workspace_history_refs (
  workspace TEXT NOT NULL,
  ref TEXT NOT NULL,
  head TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, ref)
);
CREATE TABLE workspace_history_revisions (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  ref TEXT NOT NULL,
  parent_id TEXT,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  message TEXT,
  metadata TEXT,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  entries TEXT NOT NULL,
  committed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX workspace_history_timeline ON workspace_history_revisions(workspace, ref, committed, sequence);
CREATE TABLE workspace_history_objects (
  workspace TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (workspace, digest)
);
CREATE TABLE workspace_history_metadata (
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace, key)
);
