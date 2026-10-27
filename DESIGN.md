---
version: alpha
name: FarmInfantary
description: Established poultry farm management UI, with a quiet green credential gateway.
colors:
  primary: '#1a5c38'
  primary-hover: '#144d2e'
  background: '#f0f4f8'
  surface: '#ffffff'
  text: '#1a1a1a'
  muted: '#59656b'
  border: '#d5dedb'
  danger: '#b3261e'
  soft: '#e8f5e9'
typography:
  body:
    fontFamily: 'Segoe UI, system-ui, sans-serif'
  heading:
    fontFamily: 'Segoe UI, system-ui, sans-serif'
rounded:
  control: '8px'
  card: '16px'
spacing:
  field-gap: '18px'
  card-padding: '36px'
components:
  auth-card: {}
  password-field: {}
  auth-button: {}
  admin-workspace: {}
---

# FarmInfantary design context

## Broker accounts and flock sales

The Distribution Broker register and Broiler Sale broker detail share one
`BrokersComponent`. Keep the existing Segoe UI, green actions, white surfaces
and global `--fi-*` tokens. Broker name plus selected flock is the main context;
the sales/received/pending strip is an account reconciliation, not decoration.
Tables own horizontal overflow; forms retain natural document height. Native
date and method selects follow existing farm forms. The shared BankPicker's
`receipt-form` variant gives account selection the same field geometry. Broker
corrections use the shared ConfirmDialog's native modal variant, with Cancel
initial focus, Escape and background inertness.

Broker receipt entry uses shared `FormDialogComponent`: a native modal with
focus containment, Escape (except during saving), focus return and its own
scroll area. Destination is the first required choice. Existing BankPicker
geometry is retained for explicitly scoped own/customer accounts; selectable
recipient names include supplier outstanding balances. No palette changes.

## Business navigation at narrow widths

Module selectors in platform administration and Farms share BUSINESS_BUNDLES in
business-modules.ts: Broiler + Distribution, Layers + Distribution, All three
modules. Native selects retain their existing field styles. The top module tabs
show enabled business workspaces plus the existing owner Overview. Shared-screen
context follows the selected enabled tab, including in paired accounts.

LayoutComponent owns section ordering across Broiler, Layers and Distribution.
Each expanded row has a quiet six-dot grip before the existing icon/label. Pointer
drag, arrow keys and explicit Move up/down controls share the same order/save path.
Collapsed rails retain navigation alone. Existing green/white tokens and compact
row geometry remain; drag starts only on the grip, preserving normal page scroll.

The existing green sidebar is a compact 60px rail at widths up to 768px. Its
native, named expand/collapse button opens a 240px drawer over content; selecting
a screen closes it. This preserves form width without changing tenant/module
selection. Menu actions are named native buttons, operable by keyboard in either
state. Inventory header actions wrap and its search field can shrink within the
available content width. Desktop navigation retains the established full sidebar.

## Overview

The user selected FarmInfantary branding and supplied replacement logo/favicon
assets on 2026-10-26. These replace the prior farm's name and imagery on sign-in,
admin, splash, install identity and printed reports. Farm owners and employees
use dense poultry, stock and account screens. The established sign-in gateway
uses the farm logo, dark green primary actions, a pale blue-grey canvas and one
white rounded card. Keep that recognizable entry point; do not add marketing
claims, stock photography, gradients or a new font identity to authentication.

`public/logo.png` and `public/favicon.png` are the supplied originals. Reuse their
pixels without replacement artwork. Branded asset URLs are versioned to avoid
an older service worker retaining the previous logo. Production styles use a
normal external stylesheet: Angular critical-CSS inlining is disabled because
its inline onload handler is incompatible with the deployed script CSP.

Product register, English interface, local daily dates under the existing PKT
business contract. There is no evidence of Japan-market scope. Primary workflow
is keyboard/password-manager sign-in on desktop, with a narrow viewport supported.
The logo remains the visual signature; clear labels and recovery take precedence.

Runtime token ownership: `src/styles.scss` is canonical. This file mirrors its
`--fi-*` colors and the established auth geometry. Shared auth classes implement
card, fields, buttons, help/error states. The shared PasswordField component owns
masking and reveal behavior. Other legacy screens retain their established CSS;
this contract does not claim a completed application-wide design migration.

## Colors

Primary/hover map to `--fi-primary`/`--fi-primary-hover`; canvas, white surface,
text, muted, border, danger and soft map to matching `--fi-*` variables. Errors
use text and live announcements as well as color. The muted text and error colors
are darker than the former login's #888/#e53935 for readability. No dark theme
is promised. Forced-color mode retains system-operable scrollbars and focus.

## Typography

Segoe UI with system sans fallback preserves the application identity. The auth
heading uses 20px/700, labels 13px/600, help 13px with 1.5 line height, fields
14px and primary actions 15px/600. No remote fonts or late font swap.

## Layout

Centered 420px card, bounded by viewport padding. Desktop card padding is
40px/36px; narrow padding is 28px/22px below 480px. Fields are full width,
18px apart. Busy controls retain dimensions; errors reserve three lines and the
recovery-action row reserves space. Loading uses the same minimum form height.
The auth document scrolls when height is insufficient; never crop the form or
trap keyboard focus. Shared data screens are outside this layout change.

## Elevation & Depth

Auth card keeps the original 0 4px 24px rgba(0,0,0,.08) shadow. Focus is an
explicit green outline; do not replace it with a shadow alone. No decorative layers.

## Shapes

16px card radius, 8px controls, 12px logo radius. Auth buttons span the card and
have a minimum 46px height. Password reveal is a labeled native button.

## Components

The admin workspace extends this identity with a 1280px maximum canvas, a 260px
farm list beside a flexible editor, and stacked cards below 760px. It reuses
the same green, white surfaces, border/focus tokens and shared password control.
The signature is the farm list showing real active staff/seats, rather than
decorative dashboard metrics. Admin form controls, notices and tables share
`src/app/admin/admin.component.scss`; root and delegated team views reuse the
same component. Native selects own platform popup geometry; no custom listbox.
Tables scroll within their card at narrow widths; actions remain outside scroll
regions. Audit times explicitly use PKT. Other business screens remain outside
this design certification.

Canonical owners and behavior are in `UX-CONTRACT.md`. Scrollbar tokens live
globally in `src/styles.scss`: thumb #93a8a0, track #eef2f1, hover #657f72 and
active #466351, with standards properties and WebKit fallbacks. Existing scroll
geometry may remain local; new surfaces need no opt-in theming class.

## Do's and Don'ts

The owner export uses the existing sidebar and a native button with fixed busy
feedback plus a persistent status region. Entitlement displays the server's
active-account result. The install shell preserves this identity but caches only
public static assets; account data and mutations stay online-only.

Preserve the logo/card identity, visible labels, keyboard focus and password-manager
support. Never persist passwords, cookies or authoritative user/farm/role state in
browser storage. Never list accounts or invent a public registration policy.
Backend D7/D8/D14 rules and API authorization override visual convenience.
