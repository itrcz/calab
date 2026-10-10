import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SITE_URL } from '@/lib/site';
import '../globals.css';

// Merchant return pages of the payment form (/onpay/success/, /onpay/fail/): outside [locale], so this layout
// renders the document itself. Never indexed, no tracking, nothing from the query string is rendered.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = { themeColor: '#0e0e10', colorScheme: 'dark' };

export default function OnpayLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-dvh text-fg">{children}</body>
    </html>
  );
}
