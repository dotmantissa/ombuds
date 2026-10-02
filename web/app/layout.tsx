import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';

import './globals.css';
import { Providers } from '@/components/Providers';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';

// Both families are served from this origin rather than from Google.
//
// Two reasons. The practical one is that the build must not depend on reaching a third
// party at compile time. The better one is that a product whose whole argument is that
// nothing identifying leaves the browser should not make every reader's browser announce
// itself to a font CDN on page load.
//
// Archivo is the full variable cut, so it carries the width axis as well as weight. That
// is what makes the condensed headline voice possible without a second family.
const archivo = localFont({
  src: [{ path: './fonts/archivo-variable.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-archivo',
  display: 'swap',
  fallback: ['Archivo', 'Archivo Narrow', 'system-ui', 'sans-serif'],
});

const plexMono = localFont({
  src: [
    { path: './fonts/plex-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/plex-mono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/plex-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
  fallback: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
});

export const metadata: Metadata = {
  title: {
    default: 'Ombuds',
    template: '%s · Ombuds',
  },
  description:
    'Ombuds reads your denial letter against the rule your insurer published, then puts the verdict on chain where the insurer cannot argue with it.',
  applicationName: 'Ombuds',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
  openGraph: {
    title: 'Ombuds',
    description:
      'Four out of five denied claims are never appealed. Not because people agree with the denial, but because the paperwork wins. Ombuds does the paperwork.',
    images: ['/og.svg'],
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#1b191f' },
    { media: '(prefers-color-scheme: light)', color: '#faf9fb' },
  ],
};

// Runs before first paint so a reader who picked light does not get a dark flash.
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('ombuds-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-signal focus:bg-surface focus:px-3 focus:py-2 focus:text-14"
        >
          Skip to the main content
        </a>
        <Providers>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
