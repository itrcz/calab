# Landing legal and daily prices v2

Date: 2026-10-09. Specification v1, based on ADR-0080 v4.1 and `b8fbdc02`.
Owner request: update public daily prices and agreements, separate RU/Global sellers,
provide a readable Global EULA and a corner cookie/preferences panel. Lead implements
without subagents. This changes publication content, not billing execution or entitlements.

## Contract

- RU locale: Gromtekh LLC / Russian documents / Team6 and Business18 RUB per person/day.
  All other locales: Unne L.L.C-FZ / USD0.10 and0.30; English Global documents with localized
  navigation and explicit English document language. Locale selects the marketing edition,
  not a backend billing account; the seller is displayed before any future purchase.
- Six stable document IDs: offer, terms (Global EULA), privacy, payments, contacts, cookies.
  Preserve old URL paths. RU canonical stays RU; Global canonical EN. Both markets appear
  in sitemap; no Global legal page canonicalizes to RU. Preserve the old legal edition
  in a versioned source archive. No monthly/yearly discounts or obsolete quarantine rules.
- Offer describes full rolling24h seats, owner included, guests/bots/invites excluded,
  immediate paid growth, optional top-up debt+30 days, seven days debt then suspension,
  no accrual during suspension, termination and unused-funds/service refunds. Payment
  capability/launch is conditional on checkout availability; contact CTAs remain truthful.
- VAT implementation remains deferred. Public wording gives base prices and the final
  total before payment, not a universal tax exemption. Unne details are owner-provided;
  do not invent a licence number, approvals, processors or transfer safeguards.
- Global EULA covers hosted use, client licence, roles/content, conduct/security,
  recordings/integrations, termination/export, remedies and mandatory consumer rights.
  It does not replace the repository BSL/commercial self-hosting licence.
- Global Privacy controller is Unne; RU is Gromtekh. Global hosting follows the earlier owner confirmation that core data is in Russia;
  a Global-specific clarification is pending. Do not fabricate international-transfer safeguards.

## Site storage and interaction

Audit: no analytics/advertising SDK or tracking cookie in landing source. Existing optional
storage is calab.locale. Preference panel manages only that actual purpose; no fake analytics
switches. Necessary choice record is calab.site-preferences, version1, maximum180days.
Default optional storage off; equally prominent allow-language/reject controls, settings,
policy link. Reject/withdraw/expiry deletes saved language; root locale router also checks
current consent before reading the key. Language links work without storage/JavaScript.
Panel is non-modal, bottom corner, keyboard-operable, close/Escape does not grant consent;
reopen via persistent button and footer. Blocked storage leaves optional persistence off.
No third-party CMP, tracking calls, blanket privacy consent or consent to contract by scroll.
Owner clarification: analytics/marketing will be added later. Show their categories as
not connected now, store false (no permission for unspecified vendors), expose a
purpose guard for future integrations, and require provider disclosure + version bump
+ fresh choice before enabling them.

## Paths and acceptance

Allowed: apps/landing source/content/public llms text and README, this spec, legal README,
ADR publication notes and focused tests. No server/proto/billing/provider mutations.
Versioned content and storage helper precede dependent components. No API/migration needed.

Check: landing typecheck/build; root make lint, with actual unavailable/failures recorded.
Inspect exported HTML for both sellers, correct price/currency/day, all24 legal pages,
metadata/sitemap, and absence of old prices/discounts in active content. Test preference
no-choice/allow/reject/revoke/expiry/blocked-storage and root redirect; single manual
screenshot pass of affected RU/Global pricing/legal/panel on desktop/mobile. Visual suites off.
Publication does not constitute bank/legal acceptance or enable live billing. Deployment
follows the current runbook and separate release gates; no independent review is claimed.

## Sources consulted

- ICO cookie/storage guidance: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/
- EDPB cookie banner taskforce: https://www.edpb.europa.eu/system/files/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf
- UAE data protection overview: https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws.

## Acceptance evidence (2026-10-09)

Implementation tree based on b8fbdc02; final commit is recorded in PR #138.
macOS, Node22.15.0, pnpm10.17.0; golangci-lint2.14.0 matches CI.
- `pnpm -F @calaba/landing typecheck` and `build`: passed, all24 legal pages exported.
- `make lint` from root: passed (Go vet, integration-tag vet/lint, workspace ESLint).
- `pnpm -F @calaba/landing test:preferences`:18 passed, including invalid/expired/missing
  consent, withdraw, blocked reads/writes, unavailable purposes and actual root redirect.
- Static export inspection:4 locale price/seller pairs,24 documents,12 canonical legal
  sitemap entries; local links and language attributes valid; no obsolete prices or
  mistakenly supplied company identifiers in active HTML.
- Manual browser QA1440×960 and390×844:Global prices/settings, RU prices/settings,
  EULA, refund anchor, ES Global privacy/navigation and footer settings. Choice persists,
  rejection/withdrawal work, Escape returns focus. Screenshots in ignored landing/shots/legal-v2.
- No visual suite or billing/server integration execution: no backend changes. No
  independent reviewer was used (owner requested no agents). Live deployment is separate.
