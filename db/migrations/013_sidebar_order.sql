-- Personal presentation only. The business runtime cannot read or write users.
ALTER TABLE users ADD COLUMN sidebar_order jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK(jsonb_typeof(sidebar_order)='object');
