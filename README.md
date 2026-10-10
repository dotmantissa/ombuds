<div align="center">
  <img src="web/public/mark.svg" width="72" alt="Ombuds" />
  <h1>Ombuds</h1>
  <p><strong>Your insurer wrote the rule. Ombuds reads it back to them.</strong></p>
  <p>
    An intelligent contract that adjudicates a denied health insurance claim against the
    insurer's own published coverage policy, with GenLayer validator consensus, and a capital
    pool that pays the member before the insurer gets round to it.
  </p>
</div>

---

## The problem this exists for

When a health insurer denies a claim, the insurer decides whether the denial was correct.
That is what an internal appeal is: the party that keeps the money if the answer is no gets
to write the answer.

Roughly four in five denials are never appealed at all. Not because people agree with them,
but because appealing means reading your plan document, the insurer's clinical policy
bulletin, the right procedure and diagnosis codes, and your state's external review statute,
and then holding all four against each other. Every one of those documents is public. The
labour of assembling them is what defeats people.

So Ombuds assembles them, and then does the one thing a chatbot cannot: it produces a verdict
that several independent validators each reached by re-reading the same public sources, that
is timestamped and cannot be edited afterwards, that carries the citation it rests on, and
that had real money staked on being right.

That is a consensus object rather than an inference. And once it is trustworthy, capital will
advance against it.

## Why this needs a chain at all

An off-chain model saying "this denial looks wrong" is worth nothing. The insurer will not
accept it and neither will a state regulator. The value is in the agreement, not the answer.

The name comes from the Old Norse *umbodhsmadhr*, the one who acts on behalf of another. The
neutral office that hears a citizen's complaint against an institution too large to argue
with. The symbolism is the point: the thing standing between you and the insurer must not be
another insurer.

## What is deployed

GenLayer studio network, chain id 61999.

| Contract | Address | What it holds |
|---|---|---|
| `PlanRegistry` | [`0x0905d1C488c626A1016Cd219E69141a141Cc0bD2`](https://genlayer-explorer.vercel.app) | Published coverage rules, their effective windows, and a digest of each one's policy text |
| `OmbudsCourt` | [`0x24363fC8f8eBb763e5235A011DBAe7399350cA20`](https://genlayer-explorer.vercel.app) | Cases, verdicts, the appeal path and the de-identification tripwire |
| `AdvancePool` | [`0x820A00d3C3C3cb7D5939b87967D1c5be60FceBaF`](https://genlayer-explorer.vercel.app) | Underwriter capital, advances to members, recoveries and write offs |

All five registered plan rules carry a consensus digest that every validator independently
agreed on after re-fetching the live bulletin.

## How a case actually runs

1. **You paste the denial letter.** De-identification runs before anything is signed. Out
   come procedure codes, diagnosis codes, the denial reason code and one scrubbed sentence of
   the insurer's own rationale. Your name, member id, date of birth and the full date of
   service do not. The document is hashed and only the hash is committed.

2. **The registry decides whether there is a case to answer.** Every plan rule has an
   effective window. A rule that has lapsed cannot be argued against and the filing is
   refused before a single validator cycle is spent. Arguing against last year's policy is how
   an appeal gets thrown out, so the refusal happens early.

3. **A panel does the whole job, several times over.** Each validator fetches the insurer's
   bulletin and the federal coverage determination at the same URLs, audits the codes by
   running code rather than by asking a model, and reaches its own answer.

4. **Four fields are compared.**

   | Field | Rule | Why |
   |---|---|---|
   | `overturn_recommended` | exact match | The decision. No partial credit. |
   | `ground` | exact match, five values | A coding error and a medical necessity dispute lead to different letters and different statutes. |
   | `clause_id` | exact match | The section being turned against the denial. The anti hallucination clamp, checkable because both sides just re-fetched the document. |
   | `recoverable_band` | same discrete band | Nobody agrees on $4,312.88. Everybody can agree the money sits between two thousand and seven and a half thousand. |

   Free text is handled differently. The quoted clause is not compared between validators,
   because two readers can cite different sentences from the same section and both be right.
   Instead each validator verifies its own citation against the document it just fetched. A
   quote that cannot be found raises an error and forces a fresh panel, so a fabricated
   citation cannot reach the record.

5. **The money moves on its own.** If the verdict recommends overturning and clears the
   confidence band, the pool advances a share of the disputed amount to the member. No human
   approves it. The pool reads the court, and the court only says yes when the panel agreed.

6. **You get a letter.** A PDF in your voice, carrying the clause quoted verbatim, every
   source URL, the verdict digest so the paper matches the on-chain record, and your own
   state's external review deadline.

### A real run

```
docket OMB-2026-000002
consensus reached in 35s

overturn_recommended  true
ground                MEDICAL_NECESSITY
clause_id             0157#medically-necessary
clause_section        Medically Necessary
recoverable_band      3 ($7,500 to $25,000)
confidence            100, clears the money line
citations             3

quoted clause, verbatim from Aetna CPB 0157:
"Body mass index (BMI) (see Appendix ) greater than or equal to 40 kg/m 2 (or greater
 than or equal to 37.5 kg/m 2 for persons of Asian ancestry) measured prior to
 preoperative preparatory program ..."

pool advanced 2 GEN, limited by the ceiling on this payout band
case status ADVANCED
```

## Nothing identifying goes on the chain

Say this part loudly, because it is a design constraint and not a policy.

Prompts are public on GenLayer. That is what makes a verdict auditable, and it also means the
public thing must contain no patient. So the privacy work happens first, not last.

**Never leaves your browser:** your name, member id, subscriber or group number, date of
birth, address, postcode, phone number, email address, medical record number, any claim or
account number, the raw letter, and the full date of service.

**Does go on chain:** procedure and diagnosis codes, the insurer's own denial reason code,
one scrubbed sentence of their rationale, a plan rule identifier, a two letter state code, a
month, the amount in dispute, a SHA-256 of your letter, and the public URLs a validator will
re-fetch.

Two checks enforce this, written independently of each other. A browser side scrubber runs the
HIPAA Safe Harbor patterns and refuses to return a record that still matches one. Then
`OmbudsCourt.file_case` runs its own patterns over every free text field and refuses the
filing outright if anything got through. A leak would have to defeat both.

The scrubber is careful about a specific trap: a five digit postcode and a five digit
procedure code are the same string, so codes are protected by context rather than by shape.

You can run the contract side check yourself before filing anything. It stores nothing.

## Sources, and what was rejected

Every source is public and every URL in `web/data/sources.json` carries the HTTP status it
actually answered with and the moment it was observed. Nothing is asserted without a recorded
observation.

**Used during consensus:**

- Aetna clinical policy bulletins, HTML. Five families: obesity surgery (CPB 0157),
  obstructive sleep apnea (0004), breast reconstructive surgery (0185), cochlear implants
  (0013) and knee arthroplasty (0660).
- CMS National Coverage Determinations through the coverage database API, which returns the
  indications and limitations text directly.

**Used for the letter but not fetched on chain:** state external review statutes and
deadlines for twelve states, plus the federal fallback under 45 CFR 147.136.

**Rejected, with reasons:**

- *CMS Local Coverage Determinations.* The API returns 401 and a licence agreement for the
  AMA CPT, ADA CDT and AHA NUBC code sets. It needs a token that cannot be obtained without
  accepting those licences, so Ombuds argues from National Coverage Determinations instead.
- *UnitedHealthcare and Cigna commercial policies.* Both publish as PDFs. The contracts read
  a bulletin by stripping markup from HTML, which a PDF defeats. Adding them needs a PDF text
  layer in the fetch path, which is real work and not a mock, so neither insurer is in version
  one.

Version one covers five procedure families where the source coverage is genuinely deep,
rather than fifty where it would be thin and broad.

## Running it

Python 3.12 or newer is required. The GenLayer SDK uses PEP 695 generics, which 3.10 cannot
parse.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt

npm install
npm --prefix web install

cp .env.example .env     # then fill it in
```

```bash
npm run lint:contracts   # genvm-lint, all three contracts
npm run test:contracts   # 219 direct mode tests
npm run test:web         # 45 tests over the filing API path
npm run deploy:contracts # studio network
npm run seed:registry    # register the verified rules, then refresh each digest
npm run dev              # the app on :3000
```

Other scripts worth knowing:

```bash
npm run sources:build              # rebuild data/sources.json, re-checking every URL
npm run fixtures:check             # does any captured bulletin still match the live page
node scripts/check_chain.mjs       # read the three contracts back
node scripts/e2e_case.mjs          # file, adjudicate and advance one real case
node deploy/fund_pool.mjs 12       # put 12 GEN of real capital in the pool
```

## Layout

```
contracts/
  plan_registry.py    the gatekeeper. Rules expire, and a lapsed rule is refused outright.
  ombuds_court.py     the adjudicator, the validator comparison rule and the appeal path.
  advance_pool.py     underwriter capital, advances, recoveries and write offs.
tests/
  direct/             219 tests, run against genuine captured source documents.
  fixtures/           real Aetna bulletin pages and CMS payloads, byte for byte.
web/data/sources.json every source, with the status it answered with when checked.
deploy/               deployment, registry seeding, pool funding.
scripts/              source verification, chain checks, the end to end run.
web/                  Next.js 15 App Router, the API routes and the pages.
  lib/deident.ts      the de-identification layer.
  lib/filing.ts       the evidence commitment and whose address the money is bound to.
  lib/schema.sql      the search index, which is explicitly not the record.
  tests/              45 tests over the filing path, run with no network at all.
```

## The tests

219 direct mode tests across the three contracts, run against the real Aetna bulletin pages
and CMS payloads captured in `tests/fixtures`. A hand written stub would quietly prove
nothing, because the contracts slice policy text by looking for real section headings.

The ones worth reading are the disagreement tests. They drive the actual validator function
and check that it refuses to agree when a second reader flips the decision, picks a different
ground, cites a different clause, lands in a different payout band, crosses the confidence
line, or turns out to have read a document that had been edited. And they check the one case
where disagreement would be wrong: when both sides independently hit the same transient
failure, they agree the source was down, because a dead government API is not a disagreement.

A second set drives the same function against a leader that is lying rather than one that is
merely mistaken. The honest path cannot produce a forged citation, because the step that
decides the case verifies its own quote before returning it, so a dishonest leader has to be
injected deliberately: the harness hands the validator an arbitrary payload and asks whether it
votes for it. Those tests commit a quote that appears nowhere in the bulletin, a quote too
short to identify anything, a rewritten rationale, a rationale carrying a patient identifier,
a bulletin digest the validator did not compute, a coverage digest it did not compute, a
section the registry never declared, and a confidence figure nowhere near its own. All nine
fail against the previous version of the contract, which is what makes them proof rather than
description.

Direct mode runs one contract per VM, so cross contract calls are served through the
documented `gl_call` hook. The genuine three contract wiring is exercised against the studio
network instead.

Two bugs came out of writing these, both in contracts that had already passed lint:

- The court read the outgoing verdict *after* overwriting it. Because a storage view points
  at the slot being replaced, the running overturn totals silently stopped being corrected on
  re-adjudication.
- The pool's equity figure added recoveries without subtracting advances, which inflated the
  total value governed after any recovery.

## A note on what this is not

Ombuds argues about coverage and contract terms. It never gives medical advice and it has
nothing to say about what treatment anybody should have. That conversation belongs to you and
your doctor and nothing here is a substitute for it.

It does not pretend to be your lawyer either. The letter is yours, in your voice, and you
decide whether to send it.

And it does not claim certainty it lacks. Every verdict carries a confidence figure and an
appeal path. Either side can post a bond and send the case to a fresh panel, and the bond goes
to whoever turns out to be right.

## Licence

MIT.
