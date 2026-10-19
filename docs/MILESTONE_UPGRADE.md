# Ombuds milestone upgrade

Comparison baseline: [`f4ba79d86ef62b59c7f810458d9155dc8900121a`](https://github.com/dotmantissa/ombuds/tree/f4ba79d86ef62b59c7f810458d9155dc8900121a).

The upgrade keeps the three GenLayer contracts, Next.js application, Privy authentication and Neon index. Adjudication remains independently checked by validators; financial decisions remain deterministic. Dashboards read the contracts, and the database records submission intents and supports member discovery.

## Before and after

| Area | Previous behavior | Upgraded behavior | Evidence |
| --- | --- | --- | --- |
| Payments | Outbound wallet payments used the intelligent-contract transfer interface on acceptance. Pool records did not distinguish emission from receipt. | Wallet payments use the external EVM interface after finalization. Each payout has an ID, recipient, amount, attempt and pending/acknowledged/refunded state. A retry requires the entire amount to be funded back into custody. | `contracts/advance_pool.py`, `tests/direct/test_advance_pool.py` |
| Accounting | Partial payments left the original principal counted as outstanding, overstating equity. Fee terms could change after origination. Current capital weights governed later earnings/losses. | Unpaid principal drives exposure and equity. Fees and underwriting weights are fixed at origination. Risk reserves prevent withdrawing capital that backs an open advance. Fee and loss allocation carries integer remainders exactly. Member surplus and retry funds are excluded from free underwriting capital. | Pool regression tests and local lifecycle test |
| Duplicate processing and interruptions | API timeouts returned hashes but had no durable submission intent. Script transport retries could rebroadcast writes. | A database intent is claimed before signing. Request keys bind to a fingerprint and target contract; filed docket IDs are extracted only from the deciding leader return, never from request text or idle validator entries; hashes persist immediately. Unknown broadcasts and missing/uncommitted execution results remain blocked for reconciliation. Recovery references cannot be processed twice. Script retries are limited to reads/receipt polling. | `web/lib/operations.ts`, `web/lib/reconciliation.ts`, `scripts/receipts.mjs` |
| Policy/evidence provenance | Registry retained current and previous hashes. A new verdict replaced the previous verdict. | Immutable registry versions preserve registration, replacement, expiry/SBC edits, source observations and retirement. Every verdict round preserves its policy configuration, registry address, evidence commitment, sanitized-record digest, fetched source digests, clause and reasoning. | `policy_history`, `policy_version`, `verdict_history`, `case_history` contract views |
| Appeals | Existing statuses and bond release existed, but advanced cases could return to a plain verdict state. Evidence changes could affect the bond’s ruling digest. | Case events expose submission, hearing, resolution and bond custody. Closing an appeal preserves advanced exposure. Decision changes, rather than evidence-only changes, govern bond awards. Abandonment is distinct from a changed verdict. Sponsored appeals require case ownership and have a sponsorship limit. | Court regressions; case timeline and verdict comparison |
| Privacy | Wizard sent raw letter text to scanning and filing endpoints. Labelled identifiers could survive by resembling medical codes. | Browser scans and hashes the source locally. Filing sends sanitized rationale/codes and the source commitment. Users can read TXT/HTML/JSON/CSV, edit extracted codes, inspect redactions and confirm privacy before filing. Unicode/invisible separators, labelled names and identifier/code ambiguity receive stronger checks. API validation errors do not echo document text. | `web/lib/deident.ts`, filing/privacy tests and browser network assertions |
| Underwriters and transactions | Pool totals and an advance ledger were public, with no connected personal position/history screen. | Pool and account views show capital, utilization, advance headroom, earnings, losses, withdrawal limits, reserves, financial events, payout attempts and submitted transaction outcomes. Unavailable data is labelled instead of presented as zero. | `/pool`, `/account`, `/api/activity` |
| Policy management | Refresh/revision methods existed, with limited maintenance visibility. | `/policies` shows expiry and stale-check queues, immutable revisions/configuration differences and associated cases. Verified curators can refresh, extend or retire registrations. Calendar-active counts exclude expired rules. | Policy monitoring tests; registry tests |
| Case discovery | Docket showed a fixed recent slice; the personal case API depended on indexed filings. | Contract-backed search applies query/status/plan/filer filters before pagination. Account receipt reconciliation recovers interrupted filings into the member index. Case pages expose timelines, evidence and comparisons across appeal rounds. | `search_dockets`, discovery tests, `/docket` |
| Verification | 235 direct contract tests and 45 web tests; live consensus scripts existed. | Expanded direct, privacy, receipt, policy, PostgreSQL namespace and submission regressions; a fixture-backed multi-contract lifecycle; Chromium browser tests; CI for lint, type checking, contract checks, tests, build and browser flows. | `.github/workflows/checks.yml`, `scripts/test_localnet.mjs`, `web/tests/browser` |

## Financial invariants and recovery

- Equity equals free underwriting cash plus unpaid principal. A principal repayment moves value from receivables to cash; it does not create profit. Fees create earnings and write-offs reduce equity.
- Quotes are advisory; the write also checks underwriting reserves and may refuse an amount that cannot be allocated safely.
- Every outstanding advance has fixed underwriting allocations. Positions reserve those allocations until the advance closes. This deliberately keeps withdrawal restrictions conservative during partial repayment.
- Fees and losses are allocated to the capital that underwrote the advance. A later depositor does not earn an old advance’s fee or absorb its loss.
- Recovery references are globally unique. A rejected duplicate does not credit funds, reduce exposure or allocate fees again.
- A payout’s emitted amount is debited once. Returned/replacement value is earmarked for that payout and cannot fund new advances. Retrying consumes that earmarked value without booking a second advance or withdrawal.
- Recipient acknowledgement is an authenticated statement by the receiving wallet, not an independent bank/payment-processor proof. Funded replacement cannot establish where an earlier transfer ultimately landed; operators must confirm the return/failure before funding a retry. The contract prevents unbacked duplicate spending and does not retry unknown delivery automatically.
- Pool-to-court notifications are asynchronous. Exact duplicate notifications are safe, and `sync_court` can resend authoritative advance/settlement records after a child notification fails. Pending finalization can leave the court temporarily behind the pool.

GenLayer documents the distinction between parent execution and recipient credit, external wallet transfers and finalization in [Value Transfers](https://docs.genlayer.com/developers/intelligent-contracts/features/value-transfers) and [Messages](https://docs.genlayer.com/developers/intelligent-contracts/features/messages).

## Production application

The hosted application is [ombuds-five.vercel.app](https://ombuds-five.vercel.app). The deployed health check reported both the chain and database healthy; the registry, court and pool addresses matched the new manifest. The hosted APIs returned five plans, one pending synthetic case and the actual new pool balance. [Hosted verification](../deployments/milestone-hosting-verification.json) and [production browser checks](../deployments/milestone-hosted-browser.json) preserve those results.

## Deployment and existing positions

The contracts are immutable. The upgrade deploys a new registry, court and pool, seeds the five existing policy registrations and verifies wiring and new view methods before updating local addresses. Deployment steps persist their hashes before waiting; reruns resume those hashes.

- Current deployment: [`deployed_contracts.json`](../deployed_contracts.json).
- Preserved legacy deployment: [`deployments/pre-milestone-f4ba79d.json`](../deployments/pre-milestone-f4ba79d.json).
- Deployment command: `npm run deploy:milestone`.
- Recoverable live smoke test: `node scripts/verify_milestone.mjs`.

Legacy funds, outstanding advances, cases and positions were not withdrawn or relabelled as new positions. Older index rows are preserved separately; they do not become new-court identities. They remain on the archived contract addresses. Existing production hosting must use the addresses in the current manifest to serve the upgraded contracts; repository changes alone do not update a hosting provider’s private environment configuration. The existing Vercel production address variables were updated for this release; provider-managed secrets were retained.

The database migration is additive and automatic for the existing index. New case and verdict identities include the court address, and submission keys include the target contract. Older rows that did not record their source contract are preserved as `legacy:unscoped`; they cannot authorize sponsorship or impersonate a new court’s case. The schema is included in Next.js server file tracing. Do not delete an `UNKNOWN`/`SUBMITTING` operation to force a retry: recover the transaction hash and reconcile first.

## Verified results

- 256 direct contract tests passed, compared with 235 at the baseline.
- 74 web tests passed, compared with 45 at the baseline.
- Five script/PostgreSQL tests passed, including duplicate docket isolation and mixed leader/idle-validator receipts.
- Four Chromium end-to-end tests passed. A separate production browser check also found no page errors or horizontal overflow on the account, pool and policy pages at a 390px viewport.
- The complete fixture-backed three-contract lifecycle with three validator checks passed.
- Contract lint, frontend ESLint, TypeScript and the production build passed.
- The two live synthetic adjudication attempts were rejected: one by validator disagreement, the other by citation validation. The case stayed `FILED`, with no claimant advance or recovery fabricated. [Live case evidence](../deployments/milestone-live-verification.json) records these outcomes; the full successful lifecycle is established by the reproducible local consensus test, not claimed as a successful live adjudication.
- A live 0.001 GEN withdrawal finalized and the recipient balance increased by exactly that amount. The observed receipt and balances are recorded in [milestone-payout-verification.json](../deployments/milestone-payout-verification.json). The payout record remains delivery-unverified until the receiving wallet acknowledges it; the report does not silently alter that record.

Optional `npm run test:index` checks a locally configured Neon database using temporary synthetic rows. Vercel’s protected production secrets are not exported for that command. The SQL migration is independently exercised against PostgreSQL in the default script suite.

## Reproduce the checks

Use Node 22.19+ and Python 3.14. The contract runner hash remains pinned; the contracts contain no `test`/`latest` runner aliases.

Direct tests prepare a project-local SDK cache automatically. CI explicitly downloads the pinned v0.3.0-rc7 bundle using its current upstream asset name and verifies SHA-256 before loading it. This avoids depending on a developer's existing cache or the upstream `latest` release.

```sh
python3 -m pip install -r requirements.txt
npm ci
npm --prefix web ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:localnet
npm exec --prefix web -- playwright install --with-deps chromium
npm run test:e2e
```

The local lifecycle executes all three real contracts against fixture-backed sources with three validator checks. It covers filing, adjudication, an advance, an appeal changing the verdict, bond return, partial repayment, duplicate rejection, settlement, surplus, withdrawal, policy history and a funded payout retry. It explicitly supplies payable context that the simulator’s RPC omits. It does **not** prove native-token delivery or production GenVM isolation.

Browser tests exercise local privacy review without transmitting the source letter, editable codes, public case search, preserved appeal evidence, capital/payment records, policy history, signed-out authorization and a narrow screen. They do not bypass Privy or claim to verify a real email login. The existing filing-handler tests cover authenticated filing with injected collaborators; live scripts cover actual network writes.

## Scope and practical limits

Automatic de-identification is an aid, not a proof of anonymity. Labelled names are detected; ambiguous/unlabelled names and clinical narratives still require the explicit user review. PDF/image documents require locally extracted text; this upgrade does not upload those documents to an OCR service.

Policy monitoring exposes registered observations and flags checks older than 30 days. Refresh is curator-triggered; no external scheduler or private document archive was introduced. Hash/configuration differences identify changes for review; the UI does not claim to reconstruct a complete textual policy diff from hashes.

A source update or appeal does not silently claw back an existing advance, fabricate an insurer recovery, or move legacy funds. Changed decisions remain visible alongside the original financial exposure.
