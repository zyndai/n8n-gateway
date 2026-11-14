import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { copy } from '@/lib/copy';

export const metadata: Metadata = {
  title: { default: copy.brand.name, template: `%s · ${copy.brand.name}` },
  description: copy.brand.tagline,
  icons: { icon: '/zynd.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ffffff' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
