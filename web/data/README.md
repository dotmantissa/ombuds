# The source dataset

`sources.json` is every public document Ombuds argues from, plus the procedure and diagnosis
codes, the state external review statutes and the denial reason codes that go into a letter.

There is one copy and this is it. The contract seed script (`deploy/seed_registry.mjs`), the
verifier (`scripts/build_sources.py`), the integration tests and the app all read this exact
file. Two copies is how the chain and the app end up disagreeing about which sources exist.

It lives inside `web/` rather than at the repository root so that the deployed serverless
functions can reach it. `web/next.config.ts` names it in `outputFileTracingIncludes`, because
it is read at request time rather than imported and the bundler cannot see it otherwise.

## How it was checked

Every URL in here was requested over HTTPS with a browser user agent, and the status that
came back is recorded next to it along with the moment it was observed. Nothing is asserted
without an observation. Rebuild and re-check the lot with:

```bash
python3 scripts/build_sources.py
```

That rewrites this file in place. It is polite about it: three workers, backoff on a 403 or a
429, four attempts per URL. Both aetna.com and api.coverage.cms.gov will rate limit an address
that hammers them, and a rate limit recorded as if the document had gone away would be a lie.

## What `fetchable_on_chain` means

Only the insurer bulletins and the CMS coverage determinations are fetched by the contracts
during consensus, so only those have to answer a scripted request. A validator that cannot
reach one of them cannot produce a verdict.

State statute pages are different. They are citations for the appeal letter, read by a person,
and several state sites refuse automated traffic outright. Their status is recorded as whatever
it was rather than hidden, and a 403 against a state legislature does not stop a case.

## What was left out, and why

Both exclusions are in the `meta.rejected` block with full reasons. In short:

- **CMS Local Coverage Determinations.** The API answers 401 with a licence agreement for the
  AMA CPT, ADA CDT and AHA NUBC code sets. It needs a token that cannot be obtained without
  accepting those licences, so Ombuds argues from National Coverage Determinations instead.
- **UnitedHealthcare and Cigna.** Both publish their commercial medical policies as PDFs. The
  contracts read a bulletin by stripping markup out of HTML, which a PDF defeats. Adding them
  needs a PDF text layer in the fetch path, which is real work rather than a configuration
  change, so neither insurer is in version one.

Knee arthroplasty has no `ncd` entry. That is not an oversight: a sweep of all 345 National
Coverage Determinations finds none for the procedure. The only knee entry is 150.9, arthroscopic
lavage, which is a different operation. So that family is argued on the insurer bulletin alone.

## Shape

| Key | What it holds |
|---|---|
| `meta` | when it was generated, how it was verified, and what was rejected |
| `federal_external_review` | the 45 CFR 147.136 fallback and its window |
| `code_set_authorities` | who stewards CPT, HCPCS, ICD-10-CM and the reason codes |
| `procedure_families` | five families, with real codes, the CMS determination and a guideline |
| `plan_rules` | what gets registered on chain, one row per plan and family |
| `states` | twelve states, with the real citation, agency and deadline |
| `denial_reason_codes` | the CARC and RARC codes behind most of these denials |
