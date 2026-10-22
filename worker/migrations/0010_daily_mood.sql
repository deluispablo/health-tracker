DROP VIEW IF EXISTS v_daily;
CREATE VIEW v_daily AS SELECT s.*,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'cigarettes') AS cigarettes,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'alcohol') AS alcohol_g,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'caffeine') AS caffeine_mg,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_genial') AS mood_genial,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_bien') AS mood_bien,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_tranquilo') AS mood_tranquilo,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_cansado') AS mood_cansado,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_estresado') AS mood_estresado,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_ansioso') AS mood_ansioso,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_triste') AS mood_triste,
  (SELECT total FROM tracker_daily t WHERE t.local_date = s.local_date AND t.tracker_id = 'mood_enfadado') AS mood_enfadado
FROM daily_summary s;
