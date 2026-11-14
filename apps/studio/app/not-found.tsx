import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { copy } from '@/lib/copy';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold">{copy.notFound.title}</h1>
      <p className="text-sm text-muted-foreground">{copy.notFound.body}</p>
      <Button asChild className="mt-2">
        <Link href="/agents">{copy.notFound.back}</Link>
      </Button>
    </main>
  );
}
