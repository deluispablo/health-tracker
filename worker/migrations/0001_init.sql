-- D1 / SQLite. Times: epoch s UTC + local offset in minutes.
CREATE TABLE metric_def (
  metric TEXT PRIMARY KEY,
  unit TEXT NOT NULL, agg TEXT NOT NULL CHECK (agg IN ('avg','sum','last')),
  gh_type TEXT, description TEXT
);

CREATE TABLE metric_minute (
  metric TEXT NOT NULL, ts INTEGER NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  value REAL NOT NULL, vmin REAL, vmax REAL, n INTEGER,
  source TEXT NOT NULL DEFAULT 'gh',
  PRIMARY KEY (metric, source, ts)
) WITHOUT ROWID;

CREATE TABLE metric_hour (
  metric TEXT NOT NULL, ts INTEGER NOT NULL, tz_offset_min INTEGER NOT NULL,
  value REAL NOT NULL, vmin REAL, vmax REAL, n INTEGER,
  source TEXT NOT NULL DEFAULT 'gh', PRIMARY KEY (metric, source, ts)
) WITHOUT ROWID;

CREATE TABLE metric_daily (
  metric TEXT NOT NULL, local_date TEXT NOT NULL,
  value REAL NOT NULL, source TEXT NOT NULL DEFAULT 'gh', source_id TEXT,
  updated_at INTEGER NOT NULL, PRIMARY KEY (metric, source, local_date)
) WITHOUT ROWID;

CREATE TABLE sleep_session (
  source_id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'gh',
  start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, tz_offset_min INTEGER NOT NULL,
  local_date TEXT NOT NULL,              -- wake date (night D->D+1 = D+1)
  is_nap INTEGER NOT NULL DEFAULT 0,
  minutes_asleep INTEGER, minutes_in_bed INTEGER, efficiency INTEGER,
  deep_min INTEGER, rem_min INTEGER, light_min INTEGER, awake_min INTEGER,
  latency_min INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX ix_sleep_date ON sleep_session(local_date);
CREATE TABLE sleep_stage (
  session_id TEXT NOT NULL REFERENCES sleep_session(source_id) ON DELETE CASCADE,
  start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('LIGHT','DEEP','REM','AWAKE')),
  PRIMARY KEY (session_id, start_ts)
) WITHOUT ROWID;

CREATE TABLE workout (
  source_id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'gh', type TEXT NOT NULL,
  start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, tz_offset_min INTEGER NOT NULL,
  local_date TEXT NOT NULL, duration_min REAL, avg_hr REAL, max_hr REAL,
  kcal REAL, azm INTEGER, distance_m REAL, updated_at INTEGER NOT NULL
);

CREATE TABLE tracker (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, unit TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('count','amount','scale')),
  default_value REAL, min_value REAL, max_value REAL,
  created_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE event (
  id TEXT PRIMARY KEY,
  tracker_id TEXT NOT NULL REFERENCES tracker(id),
  ts INTEGER NOT NULL, tz_offset_min INTEGER NOT NULL, local_date TEXT NOT NULL,
  value REAL NOT NULL, note TEXT,         -- note is UNTRUSTED text (prompt injection)
  origin TEXT NOT NULL CHECK (origin IN ('mcp','artifact','import')),
  created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX ix_event_tracker_date ON event(tracker_id, local_date) WHERE deleted_at IS NULL;

CREATE TABLE daily_summary (
  local_date TEXT PRIMARY KEY,
  rhr REAL, hrv_rmssd REAL, ln_rmssd REAL, resp_rate REAL, spo2_avg REAL, skin_temp_dev REAL,
  sleep_min INTEGER, sleep_eff INTEGER, deep_min INTEGER, rem_min INTEGER, sleep_latency_min INTEGER,
  bedtime_local TEXT, waketime_local TEXT,
  steps INTEGER, azm INTEGER, workout_min REAL, hr_wear_min INTEGER,
  z_ln_rmssd REAL, z_rhr REAL, z_sleep REAL, readiness_proxy REAL,
  computed_at INTEGER NOT NULL
);
CREATE TABLE tracker_daily (
  local_date TEXT NOT NULL, tracker_id TEXT NOT NULL,
  total REAL NOT NULL, n INTEGER NOT NULL, evening_total REAL NOT NULL,
  first_ts INTEGER, last_ts INTEGER, PRIMARY KEY (local_date, tracker_id)
) WITHOUT ROWID;

CREATE TABLE sync_pending (
  data_type TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  operation TEXT NOT NULL, received_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (data_type, start_ts, end_ts, operation)
) WITHOUT ROWID;
CREATE TABLE sync_state (data_type TEXT PRIMARY KEY, synced_until INTEGER, last_ok_at INTEGER, last_error TEXT);
CREATE TABLE secret_blob (name TEXT PRIMARY KEY, iv BLOB NOT NULL, ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT, args_json TEXT, rows INTEGER, ms INTEGER, ok INTEGER, error TEXT
);

INSERT INTO metric_def(metric, unit, agg) VALUES
  ('hr','bpm','avg'), ('steps','count','sum'), ('hrv_rmssd','ms','avg'), ('rhr','bpm','last'),
  ('spo2','%','avg'), ('resp_rate','brpm','avg'), ('skin_temp_dev','°C','last'), ('azm','min','sum'),
  ('vo2max','ml/kg/min','last');

-- Read-only views for the SQL tool.
CREATE VIEW v_daily AS SELECT s.*,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'cigarettes') AS cigarettes,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'alcohol') AS alcohol_g,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'caffeine') AS caffeine_mg
FROM daily_summary s;
CREATE VIEW v_events AS SELECT * FROM event WHERE deleted_at IS NULL;
CREATE VIEW v_sleep AS SELECT * FROM sleep_session;
CREATE VIEW v_workouts AS SELECT * FROM workout;
