-- Permanent farm deletion for the platform administrator.
--
-- The private auth login can neither DELETE a farm row nor touch business tables
-- (that boundary is attested at every startup), so removal happens inside ONE
-- SECURITY DEFINER function that login may EXECUTE. It runs in the caller's
-- transaction, so a failure leaves the farm completely untouched.
--
-- The search path includes the application schema because the existing broker protection
-- triggers read tables by bare name. That is safe here: the auth login is attested at every
-- startup to be unable to create objects in that schema or in public.
--
-- It sets the trusted markers the broker protections look for (the browser cannot:
-- the SQL guard refuses set_config) and removes the broker receipts, sales and
-- their ledger mirrors first, so those protections stay in force for every other
-- use. Every table with a farm_id column is cleared, which also covers tables added
-- later. audit_events is kept on purpose: it is the record that the farm existed
-- and who deleted it.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK
 (action IN ('farm.created','farm.updated','user.created','user.status','user.password','user.permissions','security.delete-code','farm.deleted'));
DO $install$
DECLARE target text:=current_schema();
BEGIN
 EXECUTE replace(replace($create$
  CREATE FUNCTION __SCHEMA_IDENT__.admin_delete_farm(target_farm bigint) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA_IDENT__ AS $body$
  DECLARE
   s constant text := __SCHEMA_LITERAL__;
   t text; n bigint; total bigint := 0;
  BEGIN
   IF target_farm IS NULL OR target_farm<=0 THEN RAISE EXCEPTION 'Choose a farm to delete.' USING ERRCODE='22023'; END IF;
   PERFORM set_config('app.farm_id',target_farm::text,true);
   PERFORM set_config('app.broker_workflow','on',true);
   EXECUTE format('SELECT count(*) FROM %I.farms WHERE farm_id=$1',s) INTO n USING target_farm;
   IF n=0 THEN RAISE EXCEPTION 'Farm not found.' USING ERRCODE='P0002'; END IF;
   -- Sessions are keyed by user, not farm, so they go while the users still exist.
   EXECUTE format('DELETE FROM %I.auth_sessions WHERE user_id IN (SELECT user_id FROM %I.users WHERE farm_id=$1)',s,s) USING target_farm;
   -- Broker history first: later deletes (flocks, customers, suppliers, bank accounts) refuse while it exists.
   FOREACH t IN ARRAY ARRAY['broker_payments','sales','bank_ledger','supplier_ledger'] LOOP
    EXECUTE format('DELETE FROM %I.%I WHERE farm_id=$1',s,t) USING target_farm;
    GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
   END LOOP;
   FOR t IN
    SELECT c.relname FROM pg_class c
     JOIN pg_namespace ns ON ns.oid=c.relnamespace
     JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='farm_id' AND NOT a.attisdropped
     WHERE ns.nspname=s AND c.relkind IN ('r','p')
      AND c.relname NOT IN ('farms','audit_events','broker_payments','sales','bank_ledger','supplier_ledger')
     ORDER BY c.relname
   LOOP
    EXECUTE format('DELETE FROM %I.%I WHERE farm_id=$1',s,t) USING target_farm;
    GET DIAGNOSTICS n=ROW_COUNT; total:=total+n;
   END LOOP;
   EXECUTE format('DELETE FROM %I.farms WHERE farm_id=$1',s) USING target_farm;
   RETURN total;
  END $body$;
 $create$,'__SCHEMA_IDENT__',quote_ident(target)),'__SCHEMA_LITERAL__',quote_literal(target));
 EXECUTE format('REVOKE ALL ON FUNCTION %I.admin_delete_farm(bigint) FROM PUBLIC',target);
END $install$;
