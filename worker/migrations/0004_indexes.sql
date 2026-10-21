CREATE INDEX ix_event_date ON event(local_date) WHERE deleted_at IS NULL;
CREATE INDEX ix_workout_date ON workout(local_date);
CREATE INDEX ix_workout_start ON workout(source, start_ts);
CREATE INDEX ix_sleep_end ON sleep_session(source, end_ts);
PRAGMA optimize;
