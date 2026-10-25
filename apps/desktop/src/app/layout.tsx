import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { Providers } from './providers';
import './globals.css';

// No next/font/google: it downloads fonts at build time, which fails offline and on
// restricted networks. The app uses the system UI font stack instead.

export const metadata: Metadata = {
  title: 'AI Automation Platform',
  description: 'Configure, run and review AI-powered development workflows locally.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
