INSERT OR IGNORE INTO tracker (id, name, unit, value_type, default_value, min_value, max_value, created_at)
VALUES ('mood_genial', 'Ánimo: genial', 'u', 'count', 1, 1, 1, unixepoch()),
       ('mood_bien', 'Ánimo: bien', 'u', 'count', 1, 1, 1, unixepoch()),
       ('mood_tranquilo', 'Ánimo: tranquilo', 'u', 'count', 1, 1, 1, unixepoch()),
       ('mood_cansado', 'Ánimo: cansado', 'u', 'count', 1, 1, 1, unixepoch()),
       ('mood_estresado', 'Ánimo: estresado', 'u', 'count', 1, 1, 1, unixepoch()),
       ('mood_ansioso', 'Ánimo: ansioso', 'u', 'count', 1, 1, 1, unixepoch()),
       ('mood_triste', 'Ánimo: triste', 'u', 'count', 1, 1, 1, unixepoch()),
       ('mood_enfadado', 'Ánimo: enfadado', 'u', 'count', 1, 1, 1, unixepoch());
