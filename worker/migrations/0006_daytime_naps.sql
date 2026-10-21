UPDATE rollup_seq SET n = n + 1
WHERE id = 1 AND EXISTS (
  SELECT 1 FROM sleep_session
  WHERE is_nap = 0 AND minutes_in_bed < 180
    AND CAST(strftime('%H', start_ts + tz_offset_min * 60, 'unixepoch') AS INTEGER) BETWEEN 9 AND 19
);

-- Mark the affected dates before reclassification removes them from the predicate.
INSERT INTO rollup_dirty (local_date, version)
SELECT DISTINCT local_date, (SELECT n FROM rollup_seq WHERE id = 1)
FROM sleep_session
WHERE is_nap = 0 AND minutes_in_bed < 180
  AND CAST(strftime('%H', start_ts + tz_offset_min * 60, 'unixepoch') AS INTEGER) BETWEEN 9 AND 19
  AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  AND date(local_date, '+0 days') = local_date AND local_date BETWEEN '2000-01-01' AND '2099-12-31'
ON CONFLICT(local_date) DO UPDATE SET version = excluded.version;

UPDATE sleep_session SET is_nap = 1
WHERE is_nap = 0 AND minutes_in_bed < 180
  AND CAST(strftime('%H', start_ts + tz_offset_min * 60, 'unixepoch') AS INTEGER) BETWEEN 9 AND 19;
