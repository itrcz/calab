-- ADR-0077: phone and global nickname in the profile. users.username is one namespace with
-- the bot usernames (a bot's account carries its bots.username), so the unique index alone
-- keeps a person from taking a bot's name and a new bot from taking a person's.
-- +goose Up
SET LOCAL lock_timeout = '10s';
ALTER TABLE users
    ADD COLUMN username citext CHECK (username::text ~ '^[a-z0-9_]{3,32}$'),
    ADD COLUMN phone text CHECK (char_length(phone) BETWEEN 1 AND 32 AND phone ~ '^\+?[0-9() -]+$');
UPDATE users u SET username = lower(b.username::text) FROM bots b WHERE b.user_id = u.id;
CREATE UNIQUE INDEX users_username_key ON users (username);

-- +goose Down
DROP INDEX users_username_key;
ALTER TABLE users DROP COLUMN phone, DROP COLUMN username;
