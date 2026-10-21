CREATE TABLE rollup_dirty (
  local_date TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);

CREATE TABLE rollup_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n INTEGER NOT NULL
);
INSERT INTO rollup_seq (id, n) VALUES (1, 0);
