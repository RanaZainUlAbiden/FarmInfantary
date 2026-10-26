-- [Codex] No inherited/default delete code is accepted or returned to clients.
CREATE TABLE farm_security (
 farm_id bigint PRIMARY KEY CHECK (farm_id>0),
 delete_code_hash text NOT NULL CHECK (delete_code_hash LIKE '$argon2id$%')
);
CREATE TABLE auth_delete_grants (
 session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
 user_id bigint NOT NULL CHECK (user_id>0),
 farm_id bigint NOT NULL CHECK (farm_id>0),
 auth_version bigint NOT NULL CHECK (auth_version>0),
 expires_at bigint NOT NULL
);
CREATE INDEX auth_delete_grants_expiry ON auth_delete_grants(expires_at);
REVOKE ALL ON farm_security,auth_delete_grants FROM PUBLIC;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK
 (action IN ('farm.created','farm.updated','user.created','user.status','user.password','user.permissions','security.delete-code'));
