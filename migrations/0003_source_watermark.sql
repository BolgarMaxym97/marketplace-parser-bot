-- High-water mark of broadcast ads: the creation time of the newest ad already
-- delivered for this source, in unix seconds. OLX ranks a search by refresh time
-- and pins promoted ads on top, so an ad created long ago can enter the feed at
-- any moment; being absent from seen_ads does not make it new. Anything created
-- at or before this mark has already had its turn.
-- NULL means the source has not delivered anything yet.
ALTER TABLE sources ADD COLUMN last_created_at INTEGER;
