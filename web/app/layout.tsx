import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';

import './globals.css';
import { Providers } from '@/components/Providers';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';

// Archivo carries a width axis, which is what makes the condensed headline voice possible
// without loading a second family.
const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  axes: ['wdth'],
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
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
