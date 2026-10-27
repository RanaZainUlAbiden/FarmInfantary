# FarmInfantary UI behavior contract

This is the authentication migration contract. Other legacy forms/tables have
not been certified by this rollout. Visual ownership: `DESIGN.md` and the mapped
runtime styles. No new business policy is defined here.

## Business context sources

| Concern | Authoritative source | UI consequence |
|---|---|---|
| Identity/session | docs/AUTHENTICATION.md and server/src/auth | Cookie restore before protected screens; no stored identity |
| Account creation/access | docs/DECISIONS.md D7/D8/D14 | No public signup or account enumeration; administration stays separate |
| SQL authority | docs/SQL_GUARD.md | Farm admins can enter business screens; staff/platform users get a signed-in access page |
| Tenancy | docs/TENANT_ISOLATION.md | Reset selections/drafts on account change; request context is a precondition, never authority |
| Online-only behavior | docs/DECISIONS.md D9 | Bounded requests, visible connection failure, no automatic write replay |

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | AuthService and auth screen classes in src/styles.scss | This contract and server auth validation | sign-in | browser states and verify_browser_sessions.mjs |
| Scrollbar | src/styles.scss global --fi-scroll-* baseline | DESIGN.md | legacy geometry exceptions | CSS/browser inspection |
| Toast | Auth inline error/status regions | This contract | persistent error or transient loading | live-region/browser inspection |
| CRUD | Dedicated account API via AuthService | Server role/session policy | business-type update | guarded HTTP PG verifier |
| Select/Listbox | Native select in the shared admin workspace | D7/D8/D12 and admin API enums | business type and status; platform-owned popup | keyboard/browser verification |
| Admin Form | Shared AdminComponent and PasswordField | Admin API validation; D7/D11/D12 | farm create/edit, staff create, status/password/grants | admin HTTP PG/browser checks |
| Admin CRUD | AdminApi, dedicated routes, same root/team component | D7/D8/D11/D12 | explicit save, return to people list | verify_admin_pg.mjs |
| Dialog | Shared DeleteCodeDialog with native HTML dialog | Server delete-code API and existing confirmation flow | showModal owns focus/inert background/Escape | browser keyboard/modal verification |
| Date | Native input type date in BrokersComponent | Local TEXT business dates; browser owns calendar locale and popup | sale and receipt date | broker API validation and browser form |

There is no date picker in the changed screens. Admin tables use captions,
headers and row-header account names; grant checkboxes edit flags, not bulk row
selection. Native selects own popup geometry. Server pagination uses bounded
keyset pages with explicit Load more controls; permission catalogue has a fixed
known current set. Staff access remains explicitly unavailable in the release UI.

The standalone root `/admin` workflow and farm-admin `/team` workflow share a
single workspace. Super admins cannot enter business SQL; farm admins cannot
enter platform admin routes. Create farm/owner is atomic with zero seats and no
delegation by default. User-visible audit times are PKT. Grant/status/password
changes end device sessions. Quota decreases below usage remain legal (D12).
Admin changes use explicit expected versions, display stale errors and require
an explicit reload to discard edits. No write replays after failures; passwords
clear after attempts/navigation and are not persisted. All operations have bounded
requests, disabled mutation controls, persistent error/status regions and inline
validation associated with the error region. First-invalid fields receive focus.
Account module assignment belongs only to super-admin platform account forms.
The owner Farms screen contains no module selector or save action. Retired owner
mutation requests return 403; direct platform requests enforce the super-admin
role. See docs/MODULE_COMBINATIONS.md for the assigned-bundle contract.

## Flow ledger

Account module choices are exactly Broiler + Distribution, Layers + Distribution,
and All three modules, available only in super-admin platform creation/editing.
Distribution and owner Overview are available in every combination. A removed
core module cannot be selected through the tab controls; remembered tabs and
deep links reconcile to an enabled workspace. Farm/batch/flock selections stay
separate between core modules; vaccination and report context follows the same
active-module helper. Existing standalone saved values remain readable without
rewriting data: Broiler/Layer map to their matching pair and Distribution maps to
All three. New mutations accept only the three canonical bundle values. These
workspace choices do not replace role/tenant authorization or enable staff SQL.

Sidebar order belongs to the signed-in user, independently for Broiler, Layer and
Distribution. LayoutComponent restores it from the private account API before
enabling reordering. Only known current links are restored; new links append in
their default order, and Layer Add Batch has a separate presentation key. The
six-dot handle supports pointer dragging with scroll near list edges, arrow keys,
and explicit Move up/down buttons. Escape/pointer cancellation or release outside
the list restores the original order. Reordering keeps the current route open.
Only the final drop writes; a pending save blocks another move. Status is live,
and failed saves retain the arrangement with explicit Retry saving; failed reads
retain navigation with Retry loading. Late identity responses are discarded.
Order is server stored and survives logout/device changes. It grants no access,
cannot create routes, and never changes another user's layout. Overview and fixed
export/security/sign-out actions retain their established positions.

Broker register and flock sale share `BrokersComponent`. Distribution lists
farm-wide brokers; Broiler Sale opens the same broker with a fixed selected
flock scope. Server totals cover the full scope independently of 30-row pages.
Search and broker selection use URL parameters; pending search is cancelled on
selection and stale reads are ignored. Broker activation preserves history.
The register totals cover all matching records, independently of page size;
broker detail breaks balances down by physical farm and flock. Distribution
shows the account-wide scope; Broiler Sales restricts both figures and detail
to the current flock. Sale/receipt rows also identify the physical farm.

SalesOrdersComponent owns Internal Transfer's native module → physical farm →
flock/batch controls. Module/farm changes clear the old target and loading
disables target selection; late responses are ignored. Edit restoration derives
the real physical farm, preserving explicit legacy unassigned targets. The actual
target owner is checked before the bill resolves its own-farm customer. Native
labels name each selector; failures retain the bill and clear stale targets.

Forms use native labeled dates/selects, the shared BankPicker receipt variant,
novalidate and persistent live errors/status. Sales and payments stay in the
broker detail after explicit save. Failed writes retain input and save IDs;
there is no automatic replay. Cash, bank and other receipts are distinct; zero
received means unpaid. Each later payment identifies one sale. Server validation
and row locks prevent overpayment; duplicate save IDs cannot create a second
movement. Other method requires a reference. Corrections retain reversed receipt
history and require device delete proof plus the shared native modal confirmation.
An unpaid sale can be deleted; paid sales require reversal of recorded receipts.
Legacy history edits retain their original broker. New receipt accounting never
counts receipts as a second sale or silently settles Distribution bills.

Canonical broker owners: form/CRUD/state `BrokersComponent` and dedicated broker
API; date/method popup native browser; account picker shared BankPicker;
confirmation shared ConfirmDialog native modal variant; errors/status persistent
inline live regions; scrollbar global tokens. Verification is the broker PG/API
suite, actual cash service checks, production build and in-app browser flows.

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Sign in | submit credentials | fixed-size disabled action | requested internal business route or access page | signed-in account/layout | generic credentials/rate/network text; preserve username, clear password | first invalid field; new route heading | server auth API |
| Restore | protected navigation/reload | checking status, no business mount | same allowed deep link | server-derived farm/user | sign-in with retry | form available after check | session /me |
| Sign out | sign-out button | clear private UI immediately, revoke server cookie | sign-in | signed-out form | retry sign-out; block automatic restoration until confirmed | sign-in route | auth logout and D9 |
| Session changed | 401, stale context or cross-tab event | invalidate epoch; no replay | sign-in with safe return route | persistent reason | explicit authentication | sign-in route | auth/session and tenancy |
| Account modules | super-admin account create/edit | disabled platform save | same platform account | persistent saved message; affected farm sessions end | retain draft on failure; explicit reload on conflict | existing platform form | docs/MODULE_COMBINATIONS.md; admin API |

## Recovery and privacy

Business HTTP operations use the shared HttpPlatformApi admission queue: at most
four active posts and 128 waiting requests, with a 45-second transport deadline.
Queueing is in memory for the current active page/session, not offline sync.
Payloads are captured at invocation; writes are never automatically retried.
Identity changes discard queued work and invalidate late in-flight results.
The server's resource, authorization and transaction boundaries remain mandatory.

At widths up to 768px, LayoutComponent owns the compact navigation rail/drawer;
named native buttons support keyboard activation. Choosing a menu item closes the
drawer. Inventory actions wrap instead of being clipped by the sidebar.

Identity is memory-only. Session storage may hold a non-authoritative UI-cache
owner and pending sign-out intent; these can only discard/deny state. A fresh
server identity is required before restoring preferences. Cached financial drafts
and selections are cleared on logout or identity changes. Late responses and
transaction BEGIN tokens from an older identity are discarded. No request is
automatically replayed after authentication, especially writes. Cross-tab events
invalidate local identity without accepting any identity from storage.

Credentials use real labels, current-password autocomplete and an accessible
show/hide button. Forms use novalidate and inline, associated errors. Enter submits
normally; composition-confirmation Enter must not submit. A validated internal
return URL is navigation convenience and never authorization.

## Rollout and verification

Broker Receive payment opens shared FormDialog and requires a destination before
showing entry fields. Own offers cash, house bank or a referenced other method;
supplier offers searchable names/payables and direct settlement; customer offers
searchable names followed by only that customer's deposit bank accounts. The
effect on balances is stated before saving. Recipient search pages 30 rows,
debounces input and discards stale results. Errors preserve the draft and focus
the modal error region. Saving disables duplicate actions and Escape; cancellation
restores focus. Enter during composition does not submit. No automatic write retry.
Broker-level receipts allocate oldest eligible sales first, with optional selected
flock or sale scope; receipt rows show each allocation and original receipt total.
Reversal confirms and reverses the complete receipt, including other flocks.

Production build verification must inspect the actual generated HTML: screen
stylesheets cannot require inline event handlers blocked by the deployed CSP.
Verify computed card/field/button styles on the public HTTPS sign-in route,
including a narrow view. Shared branding uses supplied logo/favicon assets and
the name FarmInfantary; tenant-owned farm names remain data, not product branding.

Owner data download has one canonical sidebar action. It disables during the
request, reports preparation/success/failure in a persistent status region and
does not replay. Browser restore is not exposed. Server-account entitlement owns
access status; legacy desktop license methods are compatibility adapters only.
The native delete dialog owns focus trapping, Escape, background inertness and
focus restoration. Code verification is a separate step from the existing final
delete confirmation. All API data and writes bypass the static-shell cache.

The premium static manifest is deliberately scoped to migrated auth/admin screens
and shared password/delete-code controls; it is not an application-wide conformance
claim. The full business regression suite remains mandatory. Browser evidence
covers loading, sign-in failure/success, password reveal, deep-link/reload,
sign-out, role access and expiry at a narrow in-app viewport. Source-state tests
cover offline/stale/cross-tab transitions and guards/interceptors without a DOM.
