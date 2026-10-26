-- [Codex] Private staff grant storage. No business SQL authority is enabled here.
-- Catalogue seed below is generated from the active sidebar, not hand-written.
CREATE TABLE permission_catalogue (
 permission_key text PRIMARY KEY CHECK (permission_key ~ '^(broiler|layer|distribution|owner)\.[a-z][a-z0-9-]+$'),
 module text NOT NULL CHECK (module IN ('broiler','layer','distribution','owner')),
 route text NOT NULL CHECK (route ~ '^[a-z][a-z0-9-]+$'),
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
 CHECK (permission_key=module||'.'||route),
 UNIQUE(module,route)
);
CREATE TABLE user_permissions (
 user_id bigint NOT NULL CHECK (user_id>0),
 farm_id bigint NOT NULL CHECK (farm_id>0),
 permission_key text NOT NULL,
 can_view integer NOT NULL DEFAULT 0 CHECK (can_view IN (0,1)),
 can_create integer NOT NULL DEFAULT 0 CHECK (can_create IN (0,1)),
 can_edit integer NOT NULL DEFAULT 0 CHECK (can_edit IN (0,1)),
 can_delete integer NOT NULL DEFAULT 0 CHECK (can_delete IN (0,1)),
 PRIMARY KEY(user_id,permission_key),
 CHECK (can_view=1 OR (can_create=0 AND can_edit=0 AND can_delete=0))
);
CREATE INDEX user_permissions_farm ON user_permissions(farm_id,user_id);
REVOKE ALL ON permission_catalogue,user_permissions FROM PUBLIC;

-- No foreign keys: validate administrative references explicitly instead.
-- Lock the target user so a concurrent identity change cannot escape validation.
CREATE FUNCTION validate_staff_permission() RETURNS trigger LANGUAGE plpgsql
 SET search_path FROM CURRENT AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.user_id,NEW.farm_id,NEW.permission_key)
    IS DISTINCT FROM ROW(OLD.user_id,OLD.farm_id,OLD.permission_key) THEN
  RAISE EXCEPTION 'Permission identity is immutable' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM users WHERE user_id=NEW.user_id AND farm_id=NEW.farm_id AND role='staff' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Permission target must be staff in that farm' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM permission_catalogue WHERE permission_key=NEW.permission_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown permission key' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER user_permissions_validate BEFORE INSERT OR UPDATE ON user_permissions
 FOR EACH ROW EXECUTE FUNCTION validate_staff_permission();

-- A grant change durably expires all existing device sessions, including after
-- re-grant. Old-farm orphan grants cannot revive after moving a user away/back.
CREATE FUNCTION revoke_changed_staff_permissions() RETURNS trigger LANGUAGE plpgsql
 SET search_path FROM CURRENT AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.can_view,NEW.can_create,NEW.can_edit,NEW.can_delete)
   IS NOT DISTINCT FROM ROW(OLD.can_view,OLD.can_create,OLD.can_edit,OLD.can_delete) THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN UPDATE users SET auth_version=auth_version+1 WHERE user_id=OLD.user_id;
 ELSE UPDATE users SET auth_version=auth_version+1 WHERE user_id=NEW.user_id; END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER user_permissions_revoke AFTER INSERT OR UPDATE OR DELETE ON user_permissions
 FOR EACH ROW EXECUTE FUNCTION revoke_changed_staff_permissions();

CREATE FUNCTION clear_staff_permissions_on_identity_change() RETURNS trigger LANGUAGE plpgsql
 SET search_path FROM CURRENT AS $$
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM user_permissions WHERE user_id=OLD.user_id;
 ELSIF ROW(NEW.farm_id,NEW.role) IS DISTINCT FROM ROW(OLD.farm_id,OLD.role) THEN
  DELETE FROM user_permissions WHERE user_id=NEW.user_id;
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER users_clear_permissions AFTER UPDATE OF farm_id,role OR DELETE ON users
 FOR EACH ROW EXECUTE FUNCTION clear_staff_permissions_on_identity_change();
REVOKE ALL ON FUNCTION validate_staff_permission(),revoke_changed_staff_permissions(),clear_staff_permissions_on_identity_change() FROM PUBLIC;

-- BEGIN GENERATED SIDEBAR CATALOGUE
INSERT INTO permission_catalogue(permission_key,module,route,label) VALUES
 ('broiler.chicks','broiler','chicks','Chicks'),
 ('broiler.expenses','broiler','expenses','Expenses'),
 ('broiler.farm-report','broiler','farm-report','Farm Report'),
 ('broiler.farm-units','broiler','farm-units','Farms'),
 ('broiler.feed','broiler','feed','Feed'),
 ('broiler.flock-health','broiler','flock-health','Flock Health'),
 ('broiler.flock-management','broiler','flock-management','Flocks'),
 ('broiler.income','broiler','income','Income'),
 ('broiler.labour','broiler','labour','Labour'),
 ('broiler.ledger','broiler','ledger','Ledger'),
 ('broiler.medicine','broiler','medicine','Medicine'),
 ('broiler.report','broiler','report','Report'),
 ('broiler.sale','broiler','sale','Sale'),
 ('broiler.vaccination','broiler','vaccination','Vaccination'),
 ('distribution.account-ledger','distribution','account-ledger','Account Ledger'),
 ('distribution.customer-management','distribution','customer-management','Customers'),
 ('distribution.distribution-report','distribution','distribution-report','Report'),
 ('distribution.expense-ledger','distribution','expense-ledger','Expense Ledger'),
 ('distribution.internal-settlement','distribution','internal-settlement','Internal Settlement'),
 ('distribution.inventory','distribution','inventory','Inventory'),
 ('distribution.labour-management','distribution','labour-management','Labour'),
 ('distribution.payment-voucher','distribution','payment-voucher','Payment Voucher'),
 ('distribution.purchase-orders','distribution','purchase-orders','Purchase'),
 ('distribution.purchase-returns','distribution','purchase-returns','Purchase Returns'),
 ('distribution.receive-voucher','distribution','receive-voucher','Receive Voucher'),
 ('distribution.sales-orders','distribution','sales-orders','Sales Orders'),
 ('distribution.sales-returns','distribution','sales-returns','Returns'),
 ('distribution.supplier-accounts','distribution','supplier-accounts','Supplier Accounts'),
 ('distribution.supplier-management','distribution','supplier-management','Suppliers'),
 ('layer.batch-management','layer','batch-management','Batches'),
 ('layer.egg-collection','layer','egg-collection','Egg Collection'),
 ('layer.egg-sales','layer','egg-sales','Egg Sales'),
 ('layer.farm-report','layer','farm-report','Farm Report'),
 ('layer.farm-units','layer','farm-units','Farms'),
 ('layer.feed','layer','feed','Feed'),
 ('layer.hen-sales','layer','hen-sales','Hen Sales'),
 ('layer.income','layer','income','Income'),
 ('layer.labour','layer','labour','Labour'),
 ('layer.layer-expenses','layer','layer-expenses','Expenses'),
 ('layer.layer-flock-health','layer','layer-flock-health','Flock Health'),
 ('layer.layer-ledger','layer','layer-ledger','Ledger'),
 ('layer.layer-report','layer','layer-report','Report'),
 ('layer.medicine','layer','medicine','Medicine'),
 ('layer.vaccination','layer','vaccination','Vaccination'),
 ('owner.assets','owner','assets','Assets'),
 ('owner.debt-payment','owner','debt-payment','Debt Payment'),
 ('owner.loans','owner','loans','Loans'),
 ('owner.overview','owner','overview','Dashboard'),
 ('owner.overview-bank-ledger','owner','overview-bank-ledger','Bank'),
 ('owner.personal-expenses','owner','personal-expenses','Personal Expenses');
-- END GENERATED SIDEBAR CATALOGUE
