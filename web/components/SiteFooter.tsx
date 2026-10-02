import Link from 'next/link';

import { Logo } from '@/components/brand/Logo';

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto max-w-[1240px] px-4 py-10">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-[30rem]">
            <Logo size={19} />
            <p className="mt-3 text-14 text-text-2">
              From the Old Norse <em>umbodhsmadhr</em>, the one who acts on behalf of another.
              The office that hears your complaint should not be run by the people you are
              complaining about.
            </p>
          </div>

          <div className="flex gap-12">
            <div>
              <p className="mono text-12 text-text-3">Product</p>
              <ul className="mt-2 flex flex-col gap-1.5 text-14">
                <li><Link href="/file" className="text-text-2 hover:text-text">File a case</Link></li>
                <li><Link href="/docket" className="text-text-2 hover:text-text">The docket</Link></li>
                <li><Link href="/pool" className="text-text-2 hover:text-text">Advance pool</Link></li>
              </ul>
            </div>
            <div>
              <p className="mono text-12 text-text-3">Reading</p>
              <ul className="mt-2 flex flex-col gap-1.5 text-14">
                <li><Link href="/how-it-works" className="text-text-2 hover:text-text">How it works</Link></li>
                <li><Link href="/sources" className="text-text-2 hover:text-text">Sources we read</Link></li>
                <li><Link href="/privacy" className="text-text-2 hover:text-text">What stays private</Link></li>
              </ul>
            </div>
          </div>
        </div>

        <p className="mt-10 border-t border-line pt-6 text-13 text-text-3">
          Ombuds argues about coverage and contracts. It never gives medical advice and it
          never tells you what treatment to have. That conversation belongs to you and your
          doctor, and nothing here is a substitute for it.
        </p>
      </div>
    </footer>
  );
}

export default SiteFooter;
