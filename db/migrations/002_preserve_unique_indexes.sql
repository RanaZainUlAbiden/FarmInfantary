-- [Codex] The original schema generator dropped uniqueness, collation and
-- partial predicates. Preserve the original unique indexes, including the
-- category index installed later by initializeDatabase.
-- Existing duplicate rows cause this transaction to fail; never discard data.
DROP INDEX IF EXISTS idx_expense_categories_unique;
CREATE UNIQUE INDEX idx_expense_categories_unique
  ON expense_categories(farm_id, category_name COLLATE public.nocase);
DROP INDEX IF EXISTS idx_layer_health_source;
CREATE UNIQUE INDEX idx_layer_health_source ON layer_health(source_mortality_id)
  WHERE source_mortality_id IS NOT NULL;
CREATE UNIQUE INDEX idx_categories_farm_type_name
  ON categories(farm_id, category_type, category_name);
