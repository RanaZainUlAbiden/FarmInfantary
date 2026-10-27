-- Preserve broker books even when an older flock-delete client races a sale.
CREATE INDEX broker_receipts_by_sale ON broker_payments(farm_id,sale_id) WHERE reversed=0;
DO $install$
DECLARE target text:=current_schema();
BEGIN
 EXECUTE format($create$
  CREATE FUNCTION %I.protect_broker_flock_history() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog AS $body$
  BEGIN
   IF EXISTS(SELECT 1 FROM %I.sales s WHERE s.flock_id=OLD.flock_id AND s.farm_id=OLD.farm_id
     AND s.broker_managed=1 AND COALESCE(s.module_type,'broiler')='broiler') THEN
    RAISE EXCEPTION 'Correct broker sales and receipts before removing this flock' USING ERRCODE='23514';
   END IF;
   RETURN OLD;
  END $body$;
 $create$,target,target);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.protect_broker_flock_history() FROM PUBLIC',target);
 EXECUTE format('CREATE TRIGGER protect_broker_flock_history BEFORE DELETE ON %I.flocks FOR EACH ROW EXECUTE FUNCTION %I.protect_broker_flock_history()',target,target);
END $install$;
