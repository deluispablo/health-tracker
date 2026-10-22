ALTER TABLE tracker ADD COLUMN surface TEXT CHECK (surface IN ('face','tile'));
ALTER TABLE tracker ADD COLUMN sort INTEGER;

INSERT OR IGNORE INTO tracker (id, name, unit, value_type, default_value, min_value, max_value, created_at)
VALUES ('water', 'Agua', 'ml', 'amount', 250, 50, 2000, unixepoch()),
       ('melatonin', 'Melatonina', 'mg', 'amount', 1, 0.1, 10, unixepoch()),
       ('protein', 'Batido de proteína', 'g', 'amount', 30, 5, 100, unixepoch()),
       ('creatine', 'Creatina', 'g', 'amount', 5, 1, 20, unixepoch());

UPDATE tracker SET surface = 'face', sort = 0 WHERE id = 'caffeine';
UPDATE tracker SET surface = 'face', sort = 1 WHERE id = 'cigarettes';
UPDATE tracker SET surface = 'face', sort = 2 WHERE id = 'alcohol';
UPDATE tracker SET surface = 'face', sort = 3 WHERE id = 'mood_genial';
UPDATE tracker SET surface = 'face', sort = 4 WHERE id = 'mood_bien';
UPDATE tracker SET surface = 'face', sort = 5 WHERE id = 'mood_tranquilo';
UPDATE tracker SET surface = 'face', sort = 6 WHERE id = 'mood_cansado';
UPDATE tracker SET surface = 'face', sort = 7 WHERE id = 'mood_estresado';
UPDATE tracker SET surface = 'face', sort = 8 WHERE id = 'mood_ansioso';
UPDATE tracker SET surface = 'face', sort = 9 WHERE id = 'mood_triste';
UPDATE tracker SET surface = 'face', sort = 10 WHERE id = 'mood_enfadado';
UPDATE tracker SET surface = 'face', sort = 11 WHERE id = 'water';
UPDATE tracker SET surface = 'tile', sort = 12 WHERE id = 'melatonin';
UPDATE tracker SET surface = 'tile', sort = 13 WHERE id = 'protein';
UPDATE tracker SET surface = 'tile', sort = 14 WHERE id = 'creatine';
