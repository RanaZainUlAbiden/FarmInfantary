# tools/

## permission-table-map

Derives `server/src/guard/permission-tables.ts` by instrumenting the app and
recording which tables each screen actually reads and writes.

**Do not hand-write that map.** Write sets are wider than they look — recording
a sale touches `bank_ledger` and `customer_ledger` — and a missed table means
either a broken screen or a permission hole.

Two properties the output must have:

- **Complete.** A table in no permission's set is unreachable by every
  non-admin. That is the correct default, and a test should assert every tenant
  table appears in at least one mapping.
- **Reviewed as a security artefact.** It decides what staff can reach.
