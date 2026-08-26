-- A search added with /add-for-me feeds private chats only: it is one person's
-- own watchlist, not something a shared group should be woken by. Existing
-- searches keep the old behaviour, which is why the default is 0.
--
-- The flag narrows the broadcast targets, not the ads. Deduplication stays global
-- (see 0004), so an ad matched by both a private-only search and an ordinary one
-- goes wherever the search that claims it first sends it.
ALTER TABLE sources ADD COLUMN private_only INTEGER NOT NULL DEFAULT 0;
