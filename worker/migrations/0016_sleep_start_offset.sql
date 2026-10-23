-- Sleep start keeps its own UTC offset: a night crossing a DST change starts in one offset and ends in another.
-- Existing rows only stored the end offset; copying it keeps their current reading, and NULL falls back to it.
ALTER TABLE sleep_session ADD COLUMN start_tz_offset_min INTEGER;
UPDATE sleep_session SET start_tz_offset_min = tz_offset_min WHERE start_tz_offset_min IS NULL;
