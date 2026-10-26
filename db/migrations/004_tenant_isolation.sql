-- [Codex] All 59 tenant tables, including the farms root. Activation is a
-- retired desktop license store: no tenant attribution or runtime access.
-- Backfill ownership before installing policies/triggers. An unresolved or
-- conflicting owner aborts the whole migration; never delete or guess rows.
DO $$
DECLARE r record; target text := current_schema();
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('balance','flocks','flock_id','flock_id','module'),
    ('chick_entries','flocks','flock_id','flock_id','module'),
    ('chick_traders','flocks','flock_id','flock_id','module'),
    ('expenses','flocks','flock_id','flock_id','module'),
    ('feed_entries','flocks','flock_id','flock_id','module'),
    ('feed_traders','flocks','flock_id','flock_id','module'),
    ('income','flocks','flock_id','flock_id','module'),
    ('labour_payments','flocks','flock_id','flock_id','module'),
    ('medicine_entries','flocks','flock_id','flock_id','module'),
    ('medicine_traders','flocks','flock_id','flock_id','module'),
    ('sales','flocks','flock_id','flock_id','module'),
    ('brokers','flocks','flock_id','flock_id','plain'),
    ('flock_health','flocks','flock_id','flock_id','plain'),
    ('ledger_entries','flocks','flock_id','flock_id','plain'),
    ('ledgers','flocks','flock_id','flock_id','plain'),
    ('egg_collection','batches','batch_id','batch_id','plain'),
    ('egg_sales','batches','batch_id','batch_id','plain'),
    ('hen_sales','batches','batch_id','batch_id','plain'),
    ('layer_health','batches','batch_id','batch_id','plain'),
    ('layer_ledger_entries','batches','batch_id','batch_id','plain'),
    ('layer_mortality','batches','batch_id','batch_id','plain'),
    ('batch_transactions','product_batches','batch_id','batch_id','plain'),
    ('bank_ledger','bank_accounts','bank_id','bank_id','plain'),
    ('bill_items','bills','bill_id','bill_id','plain'),
    ('customer_ledger','customers','customer_id','customer_id','plain'),
    ('customer_payments','customers','customer_id','customer_id','plain'),
    ('internal_transfers','bills','bill_id','bill_id','plain'),
    ('sales_return_items','sales_returns','return_id','return_id','plain'),
    ('supplier_ledger','suppliers','supplier_id','supplier_id','plain')
  ) AS owners(child,parent,child_key,parent_key,kind)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN farm_id bigint',target,r.child);
    IF r.kind='module' THEN
      EXECUTE format('UPDATE %I.%I c SET farm_id=p.farm_id FROM %I.flocks p
        WHERE c.flock_id=p.flock_id AND COALESCE(c.module_type,''broiler'')=''broiler''',target,r.child,target);
      EXECUTE format('UPDATE %I.%I c SET farm_id=p.farm_id FROM %I.batches p
        WHERE c.flock_id=p.batch_id AND c.module_type=''layer''',target,r.child,target);
    ELSE
      EXECUTE format('UPDATE %I.%I c SET farm_id=p.farm_id FROM %I.%I p WHERE c.%I=p.%I',
        target,r.child,target,r.parent,r.child_key,r.parent_key);
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE vaccinations ADD COLUMN farm_id bigint;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM vaccinations v JOIN flocks f ON f.flock_id=v.flock_id
    JOIN batches b ON b.batch_id=v.batch_id WHERE f.farm_id<>b.farm_id) THEN
    RAISE EXCEPTION 'Tenant migration refused: conflicting vaccination ownership';
  END IF;
END;
$$;
UPDATE vaccinations v SET farm_id=COALESCE(
  (SELECT f.farm_id FROM flocks f WHERE f.flock_id=v.flock_id),
  (SELECT b.farm_id FROM batches b WHERE b.batch_id=v.batch_id));

-- Session context is the authority for every new business row. Parent deletion
-- cannot remove/alter its ownership. No foreign keys/cascades or parent-existence
-- checks: orphan rows remain supported under D6. Reject mismatched supplied IDs.
CREATE FUNCTION stamp_tenant_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE tenant bigint := NULLIF(current_setting('app.farm_id',true),'')::bigint;
BEGIN
  IF tenant IS NULL OR tenant<=0 THEN
    RAISE EXCEPTION 'A farm context is required' USING ERRCODE='42501';
  END IF;
  IF NEW.farm_id IS NOT NULL AND NEW.farm_id<>tenant THEN
    RAISE EXCEPTION 'Farm ownership cannot be changed' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND NEW.farm_id IS DISTINCT FROM OLD.farm_id THEN
    RAISE EXCEPTION 'Farm ownership cannot be changed' USING ERRCODE='42501';
  END IF;
  NEW.farm_id := tenant;
  RETURN NEW;
END;
$$;

DO $$
DECLARE name text; target text := current_schema(); invalid boolean;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'app_settings','asset_payments','assets','balance','bank_accounts','bank_ledger',
    'batch_transactions','batches','bill_items','bills','brokers','categories',
    'chick_entries','chick_traders','customer_ledger','customer_payments','customers',
    'debt_records','egg_collection','egg_sales','expense_categories','expense_ledger',
    'expenses','farm_units','farms','feed_entries','feed_traders','flock_health','flocks',
    'hen_sales','income','internal_settlements','internal_transfers','labour',
    'labour_payments','layer_health','layer_ledger_entries','layer_ledgers',
    'layer_mortality','ledger_entries','ledgers','loan_payments','loans',
    'medicine_entries','medicine_traders','payment_vouchers','personal_expenses',
    'product_batches','products','purchase_orders','purchase_returns','receive_vouchers',
    'sales','sales_orders','sales_return_items','sales_returns','supplier_ledger',
    'suppliers','vaccinations']
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE farm_id IS NULL OR farm_id<=0)',target,name) INTO invalid;
    IF invalid THEN RAISE EXCEPTION 'Tenant migration refused: unresolved ownership in %',name; END IF;
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN farm_id SET NOT NULL',target,name);
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT tenant_farm_positive CHECK(farm_id>0)',target,name);
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='farm_id'
      WHERE n.nspname=target AND c.relname=name AND i.indisvalid AND i.indkey[0]=a.attnum) THEN
      EXECUTE format('CREATE INDEX %I ON %I.%I(farm_id)','tenant_'||name||'_farm',target,name);
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',target,name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',target,name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING
      (farm_id=NULLIF(current_setting(''app.farm_id'',true),'''')::bigint)
      WITH CHECK (farm_id=NULLIF(current_setting(''app.farm_id'',true),'''')::bigint)',target,name);
    IF name<>'farms' THEN
      EXECUTE format('CREATE TRIGGER tenant_identity BEFORE INSERT OR UPDATE ON %I.%I
        FOR EACH ROW EXECUTE FUNCTION %I.stamp_tenant_identity()',target,name,target);
    END IF;
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC',target,name);
  END LOOP;
END;
$$;
ALTER TABLE activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON activation,users,auth_sessions,auth_login_limits FROM PUBLIC;
REVOKE ALL ON FUNCTION stamp_tenant_identity() FROM PUBLIC;

-- Auth needs tenant NAME/STATUS metadata before a farm session exists. A private
-- SECURITY DEFINER accessor sets exactly one farm context, reads only metadata,
-- restores context and exposes no business rows. No owner/RLS bypass policy.
-- Every relation is qualified; pg_temp and public cannot shadow its dependencies.
DO $install$
DECLARE target text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION %I.auth_farm_metadata(requested_farm bigint)
    RETURNS TABLE(farm_id bigint,farm_name text,business_type text,status text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
    DECLARE previous text := current_setting('app.farm_id',true);
    BEGIN
      IF requested_farm IS NULL OR requested_farm<=0 THEN RETURN; END IF;
      PERFORM set_config('app.farm_id',requested_farm::text,true);
      RETURN QUERY EXECUTE %L USING requested_farm;
      PERFORM set_config('app.farm_id',COALESCE(previous,''),true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('app.farm_id',COALESCE(previous,''),true);
      RAISE;
    END;
    $body$;
  $create$,target,format('SELECT f.farm_id,f.farm_name,f.business_type,f.status FROM %I.farms f WHERE f.farm_id=$1',target));
  EXECUTE format('REVOKE ALL ON FUNCTION %I.auth_farm_metadata(bigint) FROM PUBLIC',target);
END;
$install$;
