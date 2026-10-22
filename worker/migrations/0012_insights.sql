CREATE TABLE finding (
  id INTEGER PRIMARY KEY, saved_at INTEGER NOT NULL, statement TEXT NOT NULL,
  ref TEXT NOT NULL, ref_hash TEXT NOT NULL UNIQUE, result TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired'))
);
CREATE TABLE finding_check (
  finding_id INTEGER NOT NULL REFERENCES finding(id), checked_at INTEGER NOT NULL,
  verdict TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (finding_id, checked_at)
);
CREATE TABLE analysis_log (ts INTEGER NOT NULL, tool TEXT NOT NULL, tests INTEGER NOT NULL);
CREATE INDEX analysis_log_ts ON analysis_log(ts);
