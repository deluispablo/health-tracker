INSERT OR IGNORE INTO tracker (id, name, unit, value_type, default_value, min_value, max_value, created_at)
VALUES ('cigarettes', 'Cigarrillos', 'u', 'count', 1, 1, 20, unixepoch()),
       ('alcohol', 'Alcohol', 'g', 'amount', 13, 1, 200, unixepoch()),
       ('caffeine', 'Cafeína', 'mg', 'amount', 80, 1, 1000, unixepoch());
