import { Label, Panel, FullRule, RailNote, Code } from '@/components/ui/primitives';

export const metadata = { title: 'What stays private' };

export default function PrivacyPage() {
  return (
    <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12">
      <div className="seq set-type" style={{ ['--i' as string]: 0 }}>
        <Label>The design, not a policy document</Label>
        <h1 className="display mt-4 max-w-[34rem] text-49 text-text">
          The public record contains no patient. That is a design constraint, not a promise.
        </h1>
      </div>

      <div className="mt-12 rail">
        <div className="rail-main">
          <p className="max-w-[44rem] text-20 text-text-2">
            Prompts are public on GenLayer. Anyone can read what a panel was asked, which is exactly
            what makes a verdict auditable. It also means privacy cannot be a policy sitting on top
            of the system. The thing that becomes public has to contain nothing identifying in the
            first place.
          </p>

          <h2 className="display mt-12 text-31 text-text">What never leaves your browser</h2>
          <ul className="mt-4 flex max-w-[44rem] flex-col gap-2 text-16 text-text-2">
            <li>Your name.</li>
            <li>Your member id, subscriber id, group number or policy number.</li>
            <li>Your date of birth.</li>
            <li>Your address, postcode, phone number or email address.</li>
            <li>Your medical record number and any claim or account number.</li>
            <li>The raw denial letter itself.</li>
            <li>The full date of service. Only the month survives.</li>
          </ul>

          <h2 className="display mt-12 text-31 text-text">What does go on chain</h2>
          <ul className="mt-4 flex max-w-[44rem] flex-col gap-2 text-16 text-text-2">
            <li>Procedure and diagnosis codes.</li>
            <li>The insurer&apos;s own denial reason code.</li>
            <li>One sentence of the insurer&apos;s own rationale, scrubbed.</li>
            <li>A plan rule identifier, a two letter state code, and a month.</li>
            <li>The amount in dispute.</li>
            <li>A SHA-256 of your original letter, and nothing else of it.</li>
            <li>The public URLs a validator will re-fetch.</li>
          </ul>

          <h2 className="display mt-12 text-31 text-text">Two checks, written at different layers</h2>
          <Panel className="mt-5 p-6">
            <p className="text-16 text-text">The browser side scrubber</p>
            <p className="mt-2 max-w-[44rem] text-14 text-text-2">
              Runs the HIPAA Safe Harbor identifier patterns over the letter, replaces each hit with
              a token, and refuses to return a record that still matches one. It is careful about a
              real trap: a five digit postcode and a five digit procedure code are the same string,
              so the codes are protected by context rather than by shape.
            </p>
            <FullRule />
            <p className="text-16 text-text">The contract side tripwire</p>
            <p className="mt-2 max-w-[44rem] text-14 text-text-2">
              <Code>file_case</Code> runs its own patterns over every free text field and refuses the
              filing outright if anything that looks like a member id, a social security number, a
              phone number, an email address, a medical record number or a full date got through. A
              leak would have to defeat two checks written independently of each other.
            </p>
            <p className="mt-3 text-14 text-text-2">
              You can run the second one yourself before you file anything, from the first step of
              the wizard. It stores nothing.
            </p>
          </Panel>

          <h2 className="display mt-12 text-31 text-text">About the database</h2>
          <p className="mt-4 max-w-[44rem] text-16 text-text-2">
            There is a Postgres index behind the site. It exists so search and case history are fast.
            It holds a SHA-256 of your email rather than the address, so a dump of it cannot be turned
            into a mailing list.
          </p>
          <p className="mt-3 max-w-[44rem] text-16 text-text">
            The index cannot invent or alter a verdict. Every verdict is re-read from the contract
            before it is shown, and nothing in the index can cause a payout.
          </p>

          <h2 className="display mt-12 text-31 text-text">About the keys</h2>
          <p className="mt-4 max-w-[44rem] text-16 text-text-2">
            You sign in with an email address and nothing else. You never hold a key, never see a seed
            phrase and never approve a transaction. A server side relayer signs chain writes on your
            behalf. It holds no member funds, and the advance pool can only ever pay the address that
            filed the case, because the pool reads that address off the court rather than from
            whoever asked.
          </p>
        </div>

        <div className="rail-aside flex flex-col gap-6">
          <RailNote title="Safe Harbor">
            The identifier list comes from the HIPAA de-identification standard. The scrubber
            implements the ones a denial letter actually carries.
          </RailNote>
          <RailNote title="Why a month">
            A full date of service is an identifier when combined with a procedure and a postcode. A
            month is not, and a month is all the argument needs.
          </RailNote>
          <RailNote title="Why a hash">
            So you can prove later which letter you were holding, without the letter ever being
            published.
          </RailNote>
          <RailNote title="If you find a leak">
            That is a bug and we would want to know. The case record shown on every case page is
            literally everything that is public about it, so you can check.
          </RailNote>
        </div>
      </div>
    </section>
  );
}
