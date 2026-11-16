'use client';

import { copy } from '@/lib/copy';

/** The last resort: the page frame itself failed. It replaces the root layout, so it brings its own bare styling. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', color: '#18181b', background: '#fff' }}>
        <main role="alert" style={{ maxWidth: 420, margin: '0 auto', padding: '96px 16px', textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>{copy.errors.loadFailedTitle}</h1>
          <p style={{ fontSize: 14, color: '#52525b', lineHeight: 1.5 }}>{copy.errors.loadFailed}</p>
          <button
            type="button"
            onClick={() => retry()}
            style={{ marginTop: 12, padding: '8px 16px', borderRadius: 8, border: 0, background: '#6d28d9', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
          >
            {copy.errors.retry}
          </button>
        </main>
      </body>
    </html>
  );
}
