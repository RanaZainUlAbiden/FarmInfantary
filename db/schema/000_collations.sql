-- FarmInfantary — collations
-- Applied BEFORE 001_tables.sql.
--
-- SQLite ships a built-in `NOCASE` collation and the app uses it in 10 places
-- for case-insensitive comparison and ordering of names:
--
--     WHERE farm_id = ? AND category_name = ? COLLATE NOCASE
--     ORDER BY c.category_name COLLATE NOCASE ASC
--
-- PostgreSQL has no such collation, and without it those statements fail
-- outright:
--
--     ERROR: collation "nocase" for encoding "UTF8" does not exist
--
-- Rather than rewrite 10 queries into LOWER(a) = LOWER(b) — which changes
-- their meaning subtly for non-ASCII names and loses index usability — define
-- the collation PostgreSQL is missing. The app's SQL then works unchanged,
-- which is the whole premise of this conversion.
--
-- `deterministic = false` is what permits two different byte sequences to
-- compare equal; a deterministic collation cannot do case-insensitive
-- equality. ICU level-2 strength ignores case and variant differences while
-- still distinguishing accents.
--
-- Created in `public` so every schema that has public on its search_path —
-- including the per-script scratch schemas the verify suite builds — resolves
-- it. Unquoted `COLLATE NOCASE` in the app folds to `nocase`, so the name
-- matches as written.

CREATE COLLATION IF NOT EXISTS public.nocase (
  provider      = icu,
  locale        = 'und-u-ks-level2',
  deterministic = false
);
