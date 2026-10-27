-- Preserve named recipients and account ownership referenced by receipt history.
-- No foreign keys: only broker-owned history restricts these existing entities.
CREATE FUNCTION protect_broker_destination_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='suppliers' THEN
  IF EXISTS(SELECT 1 FROM broker_payments WHERE supplier_id=OLD.supplier_id) THEN
   RAISE EXCEPTION 'This supplier has broker receipt history; keep the supplier for reconciliation' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='customers' THEN
  IF EXISTS(SELECT 1 FROM broker_payments WHERE customer_id=OLD.customer_id) THEN
   RAISE EXCEPTION 'This customer has broker receipt history; keep the customer for reconciliation' USING ERRCODE='23514';
  END IF;
 ELSE
  IF TG_OP='UPDATE' AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM broker_payments WHERE bank_id=OLD.bank_id) THEN
   RAISE EXCEPTION 'This account has broker receipt history; its owner and history must be retained' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION protect_broker_destination_history() FROM PUBLIC;
CREATE TRIGGER broker_destination_history BEFORE DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION protect_broker_destination_history();
CREATE TRIGGER broker_destination_history BEFORE DELETE ON customers FOR EACH ROW EXECUTE FUNCTION protect_broker_destination_history();
CREATE TRIGGER broker_destination_history BEFORE DELETE OR UPDATE OF customer_id ON bank_accounts FOR EACH ROW EXECUTE FUNCTION protect_broker_destination_history();
