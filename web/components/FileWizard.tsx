'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Gavel,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';
import { useRouter } from 'next/navigation';

import { ConsensusPip, ConsensusProgress } from '@/components/ConsensusProgress';
import { Code, FullRule, Panel, RailNote } from '@/components/ui/primitives';
import { normaliseAddress } from '@/lib/address';
import { sha256Hex } from '@/lib/deident';
import { useApi } from '@/lib/useApi';

interface RuleOption {
  planId: string;
  insurer: string;
  familyId: string;
  bulletinNumber: string;
  bulletinTitle: string;
  bulletinUrl: string;
  cmsDisplayId: string;
  cmsSourceUrl: string;
  effectiveTo: string;
}

interface StateRow {
  state: string;
  state_name: string;
  agency: string;
  statute_citation: string;
  external_review_deadline_days: number;
  mechanism: string;
}

interface ReasonCode {
  code: string;
  set: string;
  description: string;
  maps_to_ground: string;
}

interface ScanResult {
  clean: string;
  redactions: Array<{ kind: string; count: number }>;
  cptCodes: string[];
  icd10Codes: string[];
  chainFlags: string[];
  chainReachable: boolean;
  accepted: boolean;
}

const STEPS = ['The letter', 'What we kept', 'The plan rule', 'File it'] as const;

export function FileWizard({
  rules,
  states,
  reasonCodes,
}: {
  rules: RuleOption[];
  states: StateRow[];
  reasonCodes: ReasonCode[];
}) {
  const router = useRouter();
  const { call, authenticated, memberAddress } = useApi();

  const [step, setStep] = useState(0);
  const [letter, setLetter] = useState('');
  const [rationale, setRationale] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [serviceDate, setServiceDate] = useState('');
  const [amount, setAmount] = useState('');
  const [payoutAddress, setPayoutAddress] = useState('');
  const [planId, setPlanId] = useState(rules[0]?.planId ?? '');
  const [stateCode, setStateCode] = useState(states[0]?.state ?? 'TX');

  const [scan, setScan] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rule = useMemo(() => rules.find((r) => r.planId === planId) ?? null, [rules, planId]);
  const stateRow = useMemo(
    () => states.find((row) => row.state === stateCode) ?? null,
    [states, stateCode],
  );

  // Where the money would go. The member's own wallet unless they nominate somewhere
  // else, and never the relayer, which is the address that actually signs the filing.
  const typedPayout = payoutAddress.trim();
  const payoutAddressBad = typedPayout !== '' && normaliseAddress(typedPayout) === null;
  const payoutRecipient = typedPayout !== '' ? typedPayout : memberAddress;

  async function runScan() {
    setBusy(true);
    setError(null);
    try {
      const result = await call<ScanResult>('/api/scan', {
        method: 'POST',
        body: JSON.stringify({ text: letter, serviceDate: serviceDate || undefined }),
      });
      setScan(result);
      if (rationale === '') {
        const firstSentence = result.clean
          .split(/(?<=[.!?])\s+/)
          .find((s) => s.trim().length > 40 && s.trim().length < 400);
        if (firstSentence !== undefined) setRationale(firstSentence.trim());
      }
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That scan did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (rule === null) {
      setError('Pick a plan rule first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sources = [rule.bulletinUrl, rule.cmsSourceUrl].filter((u) => u !== '');
      // The letter is hashed here, on this machine, with the same function the server
      // would use. The hash is the commitment; the letter itself never leaves.
      const evidenceSha256 = await sha256Hex(letter);
      const result = await call<{
        docket: string | null;
        txHash: string;
        message?: string;
      }>('/api/cases', {
        method: 'POST',
        body: JSON.stringify({
          planId: rule.planId,
          familyId: rule.familyId,
          state: stateCode,
          letterText: letter,
          denialRationale: rationale,
          denialReasonCode: reasonCode,
          serviceDate,
          disputedAmount: amount,
          sourceUrls: sources,
          cptCodes: scan?.cptCodes,
          icd10Codes: scan?.icd10Codes,
          evidenceSha256,
          payoutAddress: payoutAddress.trim() || undefined,
        }),
      });
      if (result.docket !== null) {
        router.push(`/case/${result.docket}`);
      } else {
        // A 202 comes back when consensus outlasted the request. The server
        // explains that better than a generic line can, so prefer what it said.
        setError(
          result.message ??
            'The filing landed but we could not read the docket number back. Check the docket page.',
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That filing did not go through.');
    } finally {
      setBusy(false);
    }
  }

  const canScan = letter.trim().length > 80;
  const canChooseRule = rule !== null && rationale.trim().length > 20;
  const canFile =
    canChooseRule &&
    serviceDate !== '' &&
    amount.trim() !== '' &&
    (scan?.accepted ?? false) &&
    !payoutAddressBad &&
    payoutRecipient !== null;

  return (
    <div className="mt-10">
      {/* Step rule. A genuine sequence, so it is numbered. */}
      <ol className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Progress">
        {STEPS.map((name, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <li key={name} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-px w-5"
                style={{ background: active || done ? 'var(--signal)' : 'var(--line)' }}
              />
              <span
                className={`mono text-12 ${active ? 'text-text' : done ? 'text-signal-bright' : 'text-text-3'}`}
              >
                {name}
              </span>
              {done && <Check size={12} className="text-signal-bright" aria-label="done" />}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 rail">
        <div className="rail-main">
          {/* ------------------------------------------------- step 1 */}
          {step === 0 && (
            <Panel className="p-6">
              <label htmlFor="letter" className="block text-16 text-text">
                Paste the whole denial letter
              </label>
              <p className="mt-1.5 text-14 text-text-2">
                Including the bits with your name on. We take those out here, in your browser
                session, before anything is signed or stored.
              </p>
              <textarea
                id="letter"
                value={letter}
                onChange={(event) => setLetter(event.target.value)}
                rows={14}
                placeholder="Dear member, we have reviewed your claim for ..."
                className="mono mt-4 w-full resize-y border border-line bg-raised p-3 text-13 text-text outline-none focus-visible:border-signal"
                style={{ borderRadius: 'var(--radius-hair)' }}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <span className="mono text-12 text-text-3">
                  {letter.trim().length} characters
                  {!canScan && letter.length > 0 && ' (a bit more than that, please)'}
                </span>
                <button
                  type="button"
                  disabled={!canScan || busy}
                  onClick={() => void runScan()}
                  className="inline-flex h-10 items-center gap-2 border border-signal bg-signal px-4 text-14 font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderRadius: 'var(--radius-hair)' }}
                >
                  {busy ? <ConsensusPip size={15} /> : <ScanSearch size={15} aria-hidden="true" />}
                  Scan it
                </button>
              </div>
            </Panel>
          )}

          {/* ------------------------------------------------- step 2 */}
          {step === 1 && scan !== null && (
            <div className="flex flex-col gap-5">
              <Panel className="p-6">
                <div className="flex items-start gap-3">
                  <span className={scan.accepted ? 'text-win' : 'text-loss'}>
                    {scan.accepted ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}
                  </span>
                  <div>
                    <p className="text-16 text-text">
                      {scan.accepted
                        ? 'Clean. Nothing identifying survived the scrub.'
                        : 'Something identifying is still in there.'}
                    </p>
                    <p className="mt-1.5 text-14 text-text-2">
                      {scan.accepted
                        ? 'The chain ran its own check over the same text and agreed. Two independent checks, both happy.'
                        : `The contract flagged ${scan.chainFlags.join(', ')}. Edit the sentence below and scan again, because a filing with that in it would be refused.`}
                    </p>
                  </div>
                </div>

                {scan.redactions.length > 0 && (
                  <>
                    <FullRule />
                    <p className="mono text-12 text-text-3">Taken out</p>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {scan.redactions.map((item) => (
                        <li key={item.kind}>
                          <Code>
                            {item.kind.toLowerCase().replace(/_/g, ' ')} &times; {item.count}
                          </Code>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Panel>

              <Panel className="p-6">
                <p className="mono text-12 text-text-3">Codes we found</p>
                <div className="mt-3 flex flex-col gap-3">
                  <div>
                    <p className="text-13 text-text-2">Procedure codes</p>
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {scan.cptCodes.length === 0 ? (
                        <li className="text-13 text-text-3">none found</li>
                      ) : (
                        scan.cptCodes.map((code) => (
                          <li key={code}>
                            <Code>{code}</Code>
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                  <div>
                    <p className="text-13 text-text-2">Diagnosis codes</p>
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {scan.icd10Codes.length === 0 ? (
                        <li className="text-13 text-text-3">none found</li>
                      ) : (
                        scan.icd10Codes.map((code) => (
                          <li key={code}>
                            <Code>{code}</Code>
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                </div>
              </Panel>

              <Panel className="p-6">
                <label htmlFor="rationale" className="block text-16 text-text">
                  The sentence where they say why
                </label>
                <p className="mt-1.5 text-14 text-text-2">
                  We picked one out. Change it if we got the wrong sentence. This is the line the
                  panel argues against, so it matters that it is their words and not a summary.
                </p>
                <textarea
                  id="rationale"
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  rows={4}
                  className="mt-3 w-full resize-y border border-line bg-raised p-3 text-14 text-text outline-none focus-visible:border-signal"
                  style={{ borderRadius: 'var(--radius-hair)' }}
                />
              </Panel>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(0)}
                  className="mono inline-flex items-center gap-1.5 text-13 text-text-2 hover:text-text"
                >
                  <ArrowLeft size={13} aria-hidden="true" />
                  Back to the letter
                </button>
                <button
                  type="button"
                  disabled={!scan.accepted || rationale.trim().length < 20}
                  onClick={() => setStep(2)}
                  className="inline-flex h-10 items-center gap-2 border border-signal bg-signal px-4 text-14 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderRadius: 'var(--radius-hair)' }}
                >
                  Pick the plan rule
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {/* ------------------------------------------------- step 3 */}
          {step === 2 && (
            <div className="flex flex-col gap-5">
              <Panel className="p-6">
                <p className="text-16 text-text">Which rule should we argue from</p>
                <p className="mt-1.5 text-14 text-text-2">
                  These are the bulletins on chain with a current effective window. A rule that has
                  lapsed cannot be argued against, which is the registry refusing rather than us.
                </p>

                {rules.length === 0 ? (
                  <p className="mt-4 text-14 text-loss">
                    No rules are readable right now, so a case cannot be filed. The registry is on
                    chain either way.
                  </p>
                ) : (
                  <ul className="mt-4 flex flex-col gap-2">
                    {rules.map((option) => {
                      const selected = option.planId === planId;
                      return (
                        <li key={option.planId}>
                          <label
                            className="flex cursor-pointer items-start gap-3 border p-3.5 transition-colors"
                            style={{
                              borderRadius: 'var(--radius-hair)',
                              borderColor: selected ? 'var(--signal)' : 'var(--line)',
                              background: selected ? 'var(--signal-wash)' : 'transparent',
                            }}
                          >
                            <input
                              type="radio"
                              name="planId"
                              value={option.planId}
                              checked={selected}
                              onChange={() => setPlanId(option.planId)}
                              className="mt-1 accent-[var(--signal)]"
                            />
                            <span>
                              <span className="block text-14 text-text">
                                {option.insurer}, {option.bulletinTitle || option.familyId.replace(/_/g, ' ')}
                              </span>
                              <span className="mono mt-1 block text-12 text-text-3">
                                bulletin {option.bulletinNumber}
                                {option.cmsDisplayId !== '' && ` with CMS ${option.cmsDisplayId}`}
                                {' · in force to '}
                                {option.effectiveTo}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>

              <Panel className="p-6">
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <label htmlFor="state" className="block text-14 text-text">
                      Which state are you in
                    </label>
                    <p className="mt-1 text-13 text-text-2">This decides your review deadline.</p>
                    <select
                      id="state"
                      value={stateCode}
                      onChange={(event) => setStateCode(event.target.value)}
                      className="mono mt-2 h-10 w-full border border-line bg-raised px-2.5 text-13 text-text outline-none focus-visible:border-signal"
                      style={{ borderRadius: 'var(--radius-hair)' }}
                    >
                      {states.map((row) => (
                        <option key={row.state} value={row.state}>
                          {row.state_name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="reason" className="block text-14 text-text">
                      Their denial reason code
                    </label>
                    <p className="mt-1 text-13 text-text-2">
                      On the explanation of benefits, if you have it.
                    </p>
                    <select
                      id="reason"
                      value={reasonCode}
                      onChange={(event) => setReasonCode(event.target.value)}
                      className="mono mt-2 h-10 w-full border border-line bg-raised px-2.5 text-13 text-text outline-none focus-visible:border-signal"
                      style={{ borderRadius: 'var(--radius-hair)' }}
                    >
                      <option value="">not stated</option>
                      {reasonCodes.map((row) => (
                        <option key={`${row.set}-${row.code}`} value={row.code}>
                          {row.set} {row.code}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="serviceDate" className="block text-14 text-text">
                      Date of service
                    </label>
                    <p className="mt-1 text-13 text-text-2">
                      Only the month is kept. The day is dropped.
                    </p>
                    <input
                      id="serviceDate"
                      type="date"
                      value={serviceDate}
                      onChange={(event) => setServiceDate(event.target.value)}
                      className="mono mt-2 h-10 w-full border border-line bg-raised px-2.5 text-13 text-text outline-none focus-visible:border-signal"
                      style={{ borderRadius: 'var(--radius-hair)' }}
                    />
                  </div>

                  <div>
                    <label htmlFor="amount" className="block text-14 text-text">
                      Amount in dispute
                    </label>
                    <p className="mt-1 text-13 text-text-2">In US dollars. An estimate is fine.</p>
                    <input
                      id="amount"
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="12400"
                      className="mono mt-2 h-10 w-full border border-line bg-raised px-2.5 text-13 text-text outline-none focus-visible:border-signal"
                      style={{ borderRadius: 'var(--radius-hair)' }}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label htmlFor="payoutAddress" className="block text-14 text-text">
                      Payout address (optional)
                    </label>
                    <p className="mt-1 text-13 text-text-2">
                      Where an advance and any recovery surplus are paid.{' '}
                      {memberAddress === null
                        ? 'We could not read your own wallet address, so you need to enter one here.'
                        : 'Leave it blank and it goes to your own wallet.'}
                    </p>
                    <input
                      id="payoutAddress"
                      type="text"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={memberAddress ?? '0x...'}
                      value={payoutAddress}
                      onChange={(event) => setPayoutAddress(event.target.value)}
                      aria-invalid={payoutAddressBad}
                      aria-describedby={payoutAddressBad ? 'payoutAddressError' : undefined}
                      className="mono mt-2 h-10 w-full border bg-raised px-2.5 text-13 text-text outline-none focus-visible:border-signal"
                      style={{
                        borderRadius: 'var(--radius-hair)',
                        borderColor: payoutAddressBad ? 'var(--loss)' : 'var(--line)',
                      }}
                    />
                    {payoutAddressBad ? (
                      <p id="payoutAddressError" className="mt-2 text-13 text-loss">
                        That is not a 0x address followed by 40 hex characters.
                      </p>
                    ) : null}
                  </div>
                </div>
              </Panel>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="mono inline-flex items-center gap-1.5 text-13 text-text-2 hover:text-text"
                >
                  <ArrowLeft size={13} aria-hidden="true" />
                  Back
                </button>
                <button
                  type="button"
                  disabled={!canChooseRule}
                  onClick={() => setStep(3)}
                  className="inline-flex h-10 items-center gap-2 border border-signal bg-signal px-4 text-14 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderRadius: 'var(--radius-hair)' }}
                >
                  Review and file
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {/* ------------------------------------------------- step 4 */}
          {step === 3 && (
            <div className="flex flex-col gap-5">
              <Panel className="p-6">
                <p className="text-16 text-text">This is everything that will be made public</p>
                <p className="mt-1.5 text-14 text-text-2">
                  Read it once. If you can identify yourself from this, stop and tell us, because
                  that would be a bug and we would want to know.
                </p>
                <dl className="mt-5 flex flex-col gap-3 text-14">
                  {[
                    ['Plan rule', rule?.planId ?? ''],
                    ['Procedure family', rule?.familyId.replace(/_/g, ' ') ?? ''],
                    ['State', stateCode],
                    ['Procedure codes', (scan?.cptCodes ?? []).join(', ') || 'none'],
                    ['Diagnosis codes', (scan?.icd10Codes ?? []).join(', ') || 'none'],
                    ['Denial reason code', reasonCode || 'not stated'],
                    ['Month of service', serviceDate.slice(0, 7) || 'not set'],
                    ['Amount in dispute', amount === '' ? 'not set' : `$${amount}`],
                    ['Paid to', payoutRecipient ?? 'no address yet, enter one above'],
                  ].map(([key, value]) => (
                    <div key={key} className="flex flex-wrap items-baseline gap-x-3">
                      <dt className="mono w-[11rem] shrink-0 text-12 text-text-3">{key}</dt>
                      <dd className="mono text-13 text-text">{value}</dd>
                    </div>
                  ))}
                  <FullRule />
                  <div>
                    <dt className="mono text-12 text-text-3">Their rationale, verbatim</dt>
                    <dd className="mt-1.5 text-14 text-text">{rationale}</dd>
                  </div>
                </dl>
              </Panel>

              {!authenticated && (
                <Panel className="border-wait p-5">
                  <p className="text-14 text-text">
                    Sign in with your email first. That is the only account step, and it exists so
                    we know which cases are yours.
                  </p>
                </Panel>
              )}

              {error !== null && (
                <Panel className="border-loss p-5">
                  <p className="text-14 text-loss">{error}</p>
                </Panel>
              )}

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="mono inline-flex items-center gap-1.5 text-13 text-text-2 hover:text-text"
                >
                  <ArrowLeft size={13} aria-hidden="true" />
                  Back
                </button>
                <button
                  type="button"
                  disabled={!canFile || busy || !authenticated}
                  onClick={() => void submit()}
                  className="inline-flex h-11 items-center gap-2 border border-signal bg-signal px-5 text-16 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderRadius: 'var(--radius-hair)' }}
                >
                  {busy ? <ConsensusPip /> : <Gavel size={16} aria-hidden="true" />}
                  {busy ? 'Opening the case' : 'Open the case'}
                </button>
              </div>

              {busy && (
                <ConsensusProgress job="The filing is being checked against the plan rule on chain and written to the court." />
              )}
            </div>
          )}

          {error !== null && step < 3 && (
            <Panel className="mt-4 border-loss p-5">
              <p className="text-14 text-loss">{error}</p>
            </Panel>
          )}
        </div>

        {/* The margin rail. Context for whichever step is open. */}
        <div className="rail-aside flex flex-col gap-6">
          {step === 0 && (
            <>
              <RailNote title="Why the whole letter">
                The codes and the reason code are usually buried in different paragraphs. We read
                them out rather than make you hunt.
              </RailNote>
              <RailNote title="It is not stored">
                The letter text is used to build the de-identified record and then dropped. Only a
                hash of it is kept.
              </RailNote>
            </>
          )}
          {step === 1 && (
            <>
              <RailNote title="Two checks, not one">
                The browser side scrub runs first, then the contract runs its own tripwire. Both
                have to pass.
              </RailNote>
              <RailNote title="Codes survive scrubbing">
                A five digit procedure code and a five digit postcode look identical. The scrubber
                knows the difference and leaves the codes alone.
              </RailNote>
            </>
          )}
          {step === 2 && rule !== null && (
            <>
              <RailNote index={1} title="The bulletin we will read">
                <a
                  href={rule.bulletinUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mono break-all text-12 text-signal-bright hover:underline"
                >
                  {rule.bulletinUrl}
                </a>
              </RailNote>
              {rule.cmsSourceUrl !== '' && (
                <RailNote index={2} title={`CMS determination ${rule.cmsDisplayId}`}>
                  <a
                    href={rule.cmsSourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mono break-all text-12 text-signal-bright hover:underline"
                  >
                    {rule.cmsSourceUrl}
                  </a>
                </RailNote>
              )}
              {stateRow !== null && (
                <RailNote index={3} title={`${stateRow.state_name} review window`}>
                  {stateRow.external_review_deadline_days} days from the final internal denial,
                  under {stateRow.statute_citation}, through the {stateRow.agency}.
                </RailNote>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <RailNote title="What happens next">
                The case opens with a docket number. Then you send it to a panel, and every
                validator reads the sources again before any of them can agree.
              </RailNote>
              <RailNote title="No gas, no wallet">
                A server side relayer signs the transaction. You never hold a key and never approve
                a transaction.
              </RailNote>
              <RailNote title="Not medical advice">
                The panel argues about coverage and contract terms. It has nothing to say about what
                treatment you should have.
              </RailNote>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
