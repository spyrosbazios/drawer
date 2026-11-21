/** Bump when tables or their stored data change: an index with another version is dropped and rebuilt from the files. */
export const SCHEMA_VERSION = 5;

export const SCHEMA = `
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  rev TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  title TEXT NOT NULL,
  mesh TEXT,
  outline TEXT NOT NULL,
  UNIQUE (project, path)
);
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  from_path TEXT NOT NULL,
  relation TEXT NOT NULL,
  target TEXT NOT NULL,
  to_project TEXT,
  to_path TEXT
);
CREATE INDEX links_from ON links (project, from_path);
CREATE INDEX links_to ON links (to_project, to_path);
CREATE TABLE facts (
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX facts_file ON facts (project, path);
CREATE TABLE projects (
  slug TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE part_status (
  project TEXT NOT NULL,
  part TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  failing TEXT NOT NULL,
  report_key TEXT NOT NULL,
  PRIMARY KEY (project, part)
);
CREATE TABLE part_evals (
  project TEXT NOT NULL,
  part TEXT NOT NULL,
  model_rev TEXT NOT NULL,
  context TEXT NOT NULL,
  report_key TEXT NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (project, part, model_rev, context)
);
CREATE TABLE assembly_status (
  project TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  report_key TEXT NOT NULL
);
CREATE VIRTUAL TABLE fts USING fts5(path, title, body, tokenize = 'unicode61 remove_diacritics 2');
`;
