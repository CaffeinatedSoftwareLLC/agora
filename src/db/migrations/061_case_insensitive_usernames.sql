-- Mentions resolve lower(username), so humans and bots share that namespace.
-- The migration runner supplies the transaction. Block writes until the scan
-- and index creation finish, so a new collision cannot slip between them.
LOCK TABLE users IN SHARE MODE;

DO $$
DECLARE
    collisions TEXT;
BEGIN
    SELECT string_agg(format('%L: %s', folded, members), E'\n' ORDER BY folded)
    INTO collisions
    FROM (
        SELECT lower(username) AS folded,
               string_agg(format('%L (id=%s)', username, btrim(id)), ', ' ORDER BY username, id) AS members
        FROM users
        GROUP BY lower(username)
        HAVING count(*) > 1
    ) AS duplicates;

    IF collisions IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot enforce case-insensitive usernames. Existing collisions:%', E'\n' || collisions
            USING HINT = 'Choose distinct usernames for the listed accounts, then retry the migration. No accounts were renamed.';
    END IF;
END $$;

CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));
