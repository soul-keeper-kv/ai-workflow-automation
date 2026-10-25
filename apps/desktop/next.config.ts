import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Tauri serves prebuilt static files; the desktop app has no Next.js server.
  // This rules out SSR, route handlers, server actions and dynamic routes without
  // generateStaticParams. See docs/adr/0002-desktop-frontend-static-export.md.
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
