-- Backoff after a transient failure: an OLX 5xx, a timeout, an anti-bot 403. Such a
-- failure no longer disables the source — it only pushes its next poll out, further
-- with every failure in a row, so an outage costs few subrequests and the search
-- comes back on its own once OLX does. Unix seconds.
-- NULL means the source is due on the next tick.
ALTER TABLE sources ADD COLUMN next_run_at INTEGER;
