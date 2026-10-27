# Broker accounts and Broiler Sales — Codex, 2026-10-27

Distribution → Brokers is the farm-wide broker register. Add/edit a broker,
record contact notes, deactivate/reactivate it, and see sales, received and
pending totals. Broker identity is shared across flocks; balances remain within
the signed-in farm. The register and account entries load in 30-row pages.
The register's total sales/paid/outstanding figures cover the full matching set,
independent of the current page. Each broker account breaks those figures down
by physical farm and flock; sale and receipt rows carry both names. In Broiler
Sales, both register figures and broker detail cover the selected flock.
Distribution covers all farms and flocks within the signed-in account.

Distribution Sales Orders → Own Farm now selects module, then physical farm,
then only that farm's active flocks/batches. Changing farm/module clears the old
target. Saved transfers restore the actual farm from their target; legacy
unassigned targets have an explicit option. Stale responses cannot replace a
new selection. Actual target ownership is rechecked before resolving the
own-farm customer, so a mismatched selection cannot book another farm.

Broiler → farm → flock → Sale now starts with broker search. Open a broker to
record sales and receipts for **that flock only**. Bird weight is loaded minus
empty weight, multiplied by the rate; new sale amounts are rounded to two decimal
places. Empty weight may be zero. Enter zero received for credit, any smaller
amount for part payment, or use Paid in full. Later receipts identify a sale and
may use cash, a named house bank account or another method with a reference.
Different methods can be recorded as separate receipts against the same sale.
Overpayment and receipts dated before the sale are refused.

Sale revenue, cash received and bank received are separate facts. Daily income
mirrors include the full sale exactly once. Only cash receipts increase cash in
hand; only bank receipts create a bank-ledger deposit. Other methods count as
received with their reference but do not pretend to be cash or bank deposits.
Receipt dates determine cash cut-offs. Reversed receipts are retained and excluded
from received totals. New broker receipts do not automatically settle Distribution
feed bills; use the existing Internal Settlement screen for that separate action.

Corrections require device delete authorization and a native modal confirmation.
Reverse receipts before deleting a paid sale; reversal restores outstanding and
rebuilds its bank balance, refusing an overdraw. Unpaid managed sales can then be
deleted and their daily income rebuilt. Existing pre-update sales retain their
history edit/print path; the broker is fixed there. Managed sale history directs
payment questions to the broker ledger. Paid legacy cash/bank rows retain their
original paid status; legacy credit starts unpaid. Migration does not invent
historical receipt dates or bank deposits. Same-name legacy brokers within a farm
are linked to one canonical identity; alias rows and sale name snapshots remain.

## Server and database boundary

Dedicated `/api/brokers` operations require a current farm administrator, origin
and session-context validation and the attested restricted runtime connection.
Staff/platform users remain denied. Tenant identity comes from the session, with
FORCE RLS on the receipt table. Broker, flock, sale and house-bank references are
validated within that tenant. The API rejects extra/spoofed fields, unknown
methods, invalid dates, non-finite/negative amounts and stale broker edits.

Broker row locks serialize receipts; sale IDs/save fingerprints prevent duplicate
movements or reuse of a save token for different content. Sale, initial receipt,
bank entry and income mirror commit together. Receipt/reversal updates are atomic.
The account is revalidated before commit. Statements are bounded and requests
are rate limited. No write is automatically replayed after a transport failure.

Migrations 008–010 add the farm-wide broker fields, stable sale links, payment
table, tenant policy/stamping, narrow existing-runtime grants, catalogue entry,
receipt index and protected workflow triggers. No foreign keys, numeric money
types, date-type conversions or legacy data deletions are introduced. The SQL
guard still rejects staff and client `SET`/`set_config`. Only the trusted server
transaction sets the local broker-workflow marker. This prevents old/raw clients
from altering managed sales/receipts or bypassing the flock history check through
an older cascade. No metadata/auth role receives business access.

## Validation and release

The dedicated restricted-role PostgreSQL/HTTP suite covers 14 broker scenarios:
legacy mapping/module isolation, owner-only access, duplicate/stale names, credit,
partial cash and later bank/other receipts, exact replay, overpayment, concurrent
payments, foreign tenant references, inactive brokers, raw-workflow denial,
flock history, farm/flock aggregates and device-authorized reversal/deletion.
Eight PostgreSQL scenarios execute the actual internal transfer selection methods,
including filtering, restoration, legacy rows, late responses and failures.
Cash service extension
checks exercise actual drawer/farm/cut-off/module SQL while retaining all 25
inherited port assertion sets unchanged. Full-schema tenancy has 26 scenarios.

Browser evidence uses a disposable farm: broker create/search/open, invalid form
recovery, a 50,000 sale with 20,000 cash then 15,000 bank (15,000 pending), reload,
mobile 390px overflow ownership and correction confirmation. The shared artifact
tracks completed work with `[Codex]`. Local evidence is under
`qa-results/brokers-20261027/` and `qa-results/broker-*` logs.

The premium static audit's remaining 29 actionless-button reports are generic
HTML false positives for Angular `(click)` bindings. An Angular compiler pass
resolves all 41 buttons in the flagged templates to real click/submit behavior.
Native date ownership and textarea geometry findings were corrected. Runtime
browser checks, rather than the generic static report, verify these controls.

Review is Codex self-review under the user's D17 direction, not independent
approval. The unfinished staff-access PR is separate and is not included here.

Release validation: **88/88 scripts, approximately 9,927 reported checks**,
**83/83 backend tests**, production Angular/shell build and all 506 static app SQL
statements prepared against PostgreSQL. The final targeted broker suite has 14
passing scenarios. All 25 inherited business assertion sets remain unchanged.
The refined browser flow shows two farms with separate outstanding amounts
(30,000 and 9,000; total 39,000), and an unpaid 550 transfer saved/reopened with
the selected Farm B and its flock. No production business records were used.

Before deployment, create/verify an encrypted persistent backup, apply 008–010
through a private temporary operator job, attest both roles, remove that job's
privileged material, update the exact reviewed release digest and deploy through
GitHub main. Existing running owner sessions are preserved. Old binaries cannot
pass their runtime attestation against the new receipt grants: deploy compatible
code promptly after migration. Roll back only to a compatible reviewed release;
never delete production data or rewrite migration history.
