-- 0010 — identity hints for the reviewer.
--
-- A brokerage statement prints the recipient's TIN masked ("XXX-XX-8214"), and a scanned
-- packet has no text layer at all, so the app often has nothing it can hash into a join key
-- (§7). What it usually does have is the last four and a name. Recording those lets the
-- confirm panel say "documents show •••-••-8214 for MARCUS D WILLIAMS; enter the full
-- number" instead of "nobody to propose". Never a full TIN; last four only.
ALTER TABLE bundles ADD COLUMN identity_hints jsonb;
