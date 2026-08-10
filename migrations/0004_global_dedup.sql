-- Deduplication is global, not per search: two searches whose filters overlap
-- return the same OLX ad, and a chat must not receive it twice. The lookup is
-- therefore by ad_id alone, which the (source_id, ad_id) primary key cannot
-- serve — its leading column is source_id.
CREATE INDEX idx_seen_ad ON seen_ads (ad_id);
