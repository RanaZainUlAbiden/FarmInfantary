# Decisions

Each entry records what was decided and, more importantly, **why** — so nobody
re-opens it six months from now without the context.

---

## D1 · Keep raw SQL over the wire

**Decided.** The browser sends SQL to the server; a guard validates every
statement.

The desktop app has no ORM and no repository layer by design — components build
raw SQL and ship it over IPC. Rewriting that into REST endpoints means
re-deriving all the business logic currently embedded in component SQL: many
months, high regression risk, and the verify scripts (which read that SQL as
text) would all need rewriting too.

**Cost:** the guard becomes the most security-critical component in the system,
and stays that way for the life of the project. Mitigated by RLS as an
independent backstop.

**Revisit when:** the app is stable in production. Migrating the highest-value
write paths — bills, settlements, vouchers, bank movements — to real endpoints
shrinks what the guard protects over time.

---

## D2 · PostgreSQL, single shared database

**Decided.** One instance, all tenants, isolated by row-level security.

Driven by D3 (concurrent staff). Per-tenant SQLite files would have given
*structural* isolation — a connection physically containing one tenant's data —
but cannot support concurrent writers well.

**Cost:** tenancy must now be enforced on every statement, through joins,
subqueries and CTEs. This is the hardest combination of the available choices.
It is why `farm_id` is denormalised onto every table and why RLS is mandatory
rather than defence-in-depth theatre.

---

## D3 · Multiple staff per account, concurrently

**Decided.** Several people work in one farm account at the same time.

This is what rules out the desktop persistence model entirely: every write did
`db.export()` + `writeFileSync` of the whole database, and transaction state was
module-global on a single shared connection.

**Consequence:** the entire access-control subsystem (D7) exists because of this
answer. It has no desktop equivalent — `farms` *is* the login today.

---

## D4 · Money is `double precision`, never `numeric`

**Decided.** Map SQLite `REAL` to `double precision`.

`node-postgres` returns `numeric` and `bigint` as **strings** to avoid precision
loss. The app does `row.amount + x` in hundreds of places. With `numeric`, every
one of those becomes string concatenation — wrong totals, no error, no stack
trace, in an accounting system.

**Cost:** floating-point money, exactly as today. Not a regression; the desktop
app has always used `REAL`.

**Revisit when:** someone wants exact decimal money. That is a deliberate
project needing a custom pg type parser and an audit of every arithmetic site —
not a type change.

---

## D5 · Dates stay `TEXT`

**Decided.** Keep `'YYYY-MM-DD'` strings.

They compare lexicographically, and PostgreSQL `TEXT` comparison is identical,
so behaviour is preserved for free. A real `date` type changes comparison and
timezone semantics across the whole app.

There is precedent: `toISOString()` once converted to UTC, pushing any local
time before 05:00 onto the **previous** day in PKT — batches filed a day early,
expiries a day short, FIFO picking the wrong batch. Both the renderer and
`electron/database.js` carry hand-written local-date helpers because of it.

**Revisit when:** never, unless there is a concrete need. The upside is small
and the downside is already documented in production.

---

## D6 · No foreign key constraints

**Decided.** Create the schema without FK constraints.

~50 `FOREIGN KEY` clauses exist, but `PRAGMA foreign_keys` is never enabled, so
nothing has ever cascaded. The app deletes child rows manually in a deliberate
order, and orphan rows legitimately exist throughout the data.

PostgreSQL enforces FKs by default. Creating them as declared would break dozens
of working delete paths and may block the initial import outright.

**Revisit when:** someone wants real referential integrity. That is a separate
project with its own data cleanup — not part of the conversion.

---

## D7 · Three-tier access control

**Decided.** `super_admin` → `farm_admin` → `staff`.

Super admin creates farms and users, sets what staff can access, sets a per-farm
staff seat quota, and may delegate staff creation to a farm admin.

**Key constraint:** permissions are enforced in the SQL guard **by table**, not
by hiding sidebar items. Because the client ships SQL, a staff member denied a
screen can still POST a query against its tables. The menu is convenience; the
guard is the control.

**Consequence:** the permission → table mapping is security-critical
infrastructure. It must be derived by instrumenting what screens actually write
(`tools/`), not hand-written — write sets are wider than they look, since
recording a sale touches the bank and customer ledgers.

---

## D8 · Super admin bypasses the SQL pipe entirely

**Decided.** Admin operations go through dedicated endpoints.

A super admin has no `farm_id` and must see across accounts, which would need an
RLS bypass. Rather than punch a hole in the policy protecting every tenant, the
admin console gets its own endpoints. It only does farm and user administration,
so it needs no access to business tables at all.

**Result:** no authenticated path through the SQL endpoints can ever read across
accounts. The tenant policy has no exceptions.

---

## D9 · Online only — no offline support

**Decided.** The web app requires connectivity. The desktop app did not.

Offline writes are incompatible with this architecture: a write made offline
cannot be tenancy-checked or permission-checked when it is made, and conflict
resolution on ledgers and bills is genuinely dangerous — two people settling the
same bill offline produces money that will not reconcile.

**What we build instead:** resilience, not sync. A PWA shell so the app loads
instantly and survives brief drops, retry on transient failures, and an explicit
"not saved" state so nobody walks away believing a sale was recorded.

**Open:** stable internet at the farm office must be confirmed with the client
before Phase 2. If it is genuinely unreliable, that is a business decision to
take then — not a surprise at launch.

---

## D10 · Restore is per-farm and never overwrites

**Decided.** Three parts:

1. **Per-farm export** — a downloadable snapshot of one farm's rows. Easy once
   `farm_id` is on every table, and genuinely useful.
2. **Per-farm import into a new empty farm** — never over an existing one. This
   removes the destructive case entirely. Still needs id remapping across ~60
   tables, because ids are database-wide sequences. Budget for it.
3. **Whole-database restore stays a DBA procedure** from `pg_dump`, not a
   product feature.

The desktop app overwrote one local file belonging to one user. On a shared
server, the same operation destroys every other account's data. That blast
radius is unacceptable for an in-app button.

---

## D14 · No data migration — this is a fresh application

**Decided.** Existing desktop installations do not carry their data across.
Accounts are created new on the web.

**Supersedes** the migration half of D11 and removes `db/import/` from Phase 1
entirely.

**What this removes:**

- The SQLite to PostgreSQL importer, and with it the id-remapping problem across
  60 tables with database-wide sequences.
- The need for a production dump to validate that import.
- The requirement that the importer handle a database *behind* the schema.

**What it does NOT remove:** the type and dialect rules. `numeric` would still
turn addition into concatenation on data typed fresh; two-argument `MAX` is
still a syntax error; `CAST` still rounds. Those are properties of the target,
not of the migration.

**What it narrows:** the oracle (`scripts/verify/oracle.mjs`) was built to diff
totals before and after a migration. With no migration there is no "before" from
production. It stays useful — it compares the same fixtures through sql.js and
PostgreSQL, and guards against drift between code versions — but its original
purpose is gone, and nobody should expect it to prove a data migration that will
not happen.

**Cost, stated plainly:** existing Talha Farm users re-enter their data. That is
a business decision, taken deliberately.

---

## D11 · First super admin is seeded out of band

**Decided.** A one-time bootstrap command at first deploy, credentials supplied
by environment. Held by DevInfantary, who already control licensing.

No existing row is a platform owner, so the super admin cannot be derived from
data.

**Account creation.** Superseded in part by D14: there are no existing accounts
to migrate. The super admin creates each farm and its `farm_admin` from scratch.
`staff_seat_limit` still defaults to **0** and `can_admin_add_staff` to
**false**, so a new farm starts with one admin and no staff until seats are
deliberately granted.

---

## D12 · Seat quota answers

**Decided.**

- **A suspended staff member frees their seat.** The trigger counts only
  `status = 'active'`.
- **A quota may be lowered below current usage.** It is allowed, and blocks new
  creation until usage falls — so a super admin is never stuck.

---

## D13 · Keep `Talha Farm/` in the repository

**Decided.** Commit the desktop app's source; gitignore its build artefacts.

It is not documentation. The Phase 0 and Phase 1 verify scripts read
`Talha Farm/electron/database.js` as **text** to build their test schema, so it
is a build input. Freeze it once Phase 1 passes.
