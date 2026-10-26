# FarmInfantary branding and production CSS — 2026-10-26

The reported unstyled sign-in page was a real production defect. Angular's
critical-CSS optimizer emitted a print-only stylesheet with an inline onload
handler. The deployed CSP correctly blocked that handler, leaving global auth
layout styles inactive. Public-browser inspection reproduced `display:block`
and `media=print` before the fix. Local screenshots without CSP had missed it.

Production optimization now disables only critical-CSS inlining. Script and CSS
minification remain enabled and the script CSP remains unchanged. The generated
stylesheet loads normally without an inline event handler. The new
`scripts/check-production-shell.mjs` validates the actual build output and runs
after every root build and inside both frontend Docker build paths.

The user-supplied `public/logo.png` and `public/favicon.png` replace prior farm
imagery. FarmInfantary replaces hardcoded product/report names; prior farm
contact details are removed from default report headers. Tenant-owned farm
names remain data. Sign-in, admin, sidebar, splash, reports, page title, favicon,
install manifest and SVG icon adapter use the new identity. Deleted legacy
images are not restored. PNG report helpers preserve the supplied image format;
receipt/photo handling is unchanged. The icon adapter embeds the supplied
favicon bytes without editing them. Versioned asset URLs and a new static cache
version prevent the prior logo surviving a service-worker cache hit.

Verification: successful production build/output gate; both supplied PNGs decode
and embed in jsPDF; zero old product-brand strings in compiled JS; browser checks
under the production CSP at 1280px and 390px, including computed card/button styles,
loaded logo dimensions, validation, reveal/hide and actual owner sign-in. The
strict premium audit retains its sixteen existing Angular click-handler scanner
false positives; design lint has zero errors and six token warnings. The frozen
desktop reference is untouched. The inherited port-coverage suffix comparison
normalizes CRLF/LF only, preserving its exact source checks across Git checkouts.

The release is self-reviewed under the user's D17 instruction. No CSP relaxation
or authentication/tenant-policy change is part of this fix. Public HTTPS/browser
deployment evidence and final suite results are saved in `qa-results/branding-*`.
