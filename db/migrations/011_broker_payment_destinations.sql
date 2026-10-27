ALTER TABLE broker_payments ADD COLUMN destination text NOT NULL DEFAULT 'own' CHECK(destination IN ('own','supplier','customer'));
ALTER TABLE broker_payments ADD COLUMN supplier_id bigint;
ALTER TABLE broker_payments ADD COLUMN customer_id bigint;
ALTER TABLE broker_payments ADD COLUMN receipt_group text;
ALTER TABLE broker_payments ADD CONSTRAINT broker_payment_destination_identity CHECK
 ((destination='own' AND supplier_id IS NULL AND customer_id IS NULL) OR
  (destination='supplier' AND supplier_id IS NOT NULL AND customer_id IS NULL AND bank_id IS NULL AND method='other') OR
  (destination='customer' AND customer_id IS NOT NULL AND supplier_id IS NULL AND bank_id IS NOT NULL AND method='bank'));
CREATE INDEX broker_receipt_groups ON broker_payments(farm_id,receipt_group) WHERE receipt_group IS NOT NULL;
-- Mirror rows belong to the broker receipt, never to a manual ledger correction.
CREATE FUNCTION protect_broker_payment_mirror() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE protected boolean;
BEGIN
 IF TG_OP='INSERT' THEN protected:=NEW.reference_type='broker_payment';
 ELSIF TG_OP='DELETE' THEN protected:=OLD.reference_type='broker_payment';
 ELSE protected:=OLD.reference_type='broker_payment' OR NEW.reference_type='broker_payment'; END IF;
 IF protected AND COALESCE(current_setting('app.broker_workflow',true),'')<>'on' THEN
  RAISE EXCEPTION 'Reverse this payment from its broker account' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION protect_broker_payment_mirror() FROM PUBLIC;
CREATE TRIGGER broker_payment_mirror BEFORE INSERT OR UPDATE OR DELETE ON bank_ledger FOR EACH ROW EXECUTE FUNCTION protect_broker_payment_mirror();
CREATE TRIGGER broker_payment_mirror BEFORE INSERT OR UPDATE OR DELETE ON supplier_ledger FOR EACH ROW EXECUTE FUNCTION protect_broker_payment_mirror();
