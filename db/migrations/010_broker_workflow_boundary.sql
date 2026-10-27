-- Managed sales/receipts use trusted server operations. Older raw-SQL clients
-- must not delete a flock's managed sales before checking its broker history.
-- The SQL AST guard refuses set_config/SET, so a browser cannot set this marker.
CREATE FUNCTION protect_broker_workflow() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE protected boolean:=TG_TABLE_NAME='broker_payments';
BEGIN
 IF TG_TABLE_NAME='sales' THEN
  IF TG_OP='INSERT' THEN protected:=NEW.broker_managed=1;
  ELSIF TG_OP='DELETE' THEN protected:=OLD.broker_managed=1;
  ELSE protected:=OLD.broker_managed=1 OR NEW.broker_managed=1; END IF;
 END IF;
 IF protected AND COALESCE(current_setting('app.broker_workflow',true),'')<>'on' THEN
  RAISE EXCEPTION 'Use the broker account to change managed sales or receipts' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION protect_broker_workflow() FROM PUBLIC;
CREATE TRIGGER broker_workflow BEFORE INSERT OR UPDATE OR DELETE ON sales FOR EACH ROW EXECUTE FUNCTION protect_broker_workflow();
CREATE TRIGGER broker_workflow BEFORE INSERT OR UPDATE OR DELETE ON broker_payments FOR EACH ROW EXECUTE FUNCTION protect_broker_workflow();
