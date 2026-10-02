'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Logo } from '@/components/brand/Logo';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { SignInButton } from '@/components/SignInButton';

const NAV = [
  { href: '/file', label: 'File a case' },
  { href: '/docket', label: 'The docket' },
  { href: '/pool', label: 'Advance pool' },
  { href: '/how-it-works', label: 'How it works' },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/92 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-6 px-4">
        <Link href="/" className="shrink-0" aria-label="Ombuds, home">
          <Logo size={21} />
        </Link>

        <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`px-2.5 py-1.5 text-14 transition-colors ${
                  active ? 'text-text' : 'text-text-2 hover:text-text'
                }`}
                style={
                  active
                    ? { boxShadow: 'inset 0 -1px 0 0 var(--signal)' }
                    : undefined
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <SignInButton />
        </div>
      </div>

      <nav
        className="flex gap-1 overflow-x-auto border-t border-line px-4 py-2 md:hidden"
        aria-label="Main, compact"
      >
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`whitespace-nowrap px-2 py-1 text-13 ${
                active ? 'text-signal' : 'text-text-2'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

export default SiteHeader;
