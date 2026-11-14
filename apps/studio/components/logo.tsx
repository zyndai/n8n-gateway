import Link from 'next/link';
import { copy } from '@/lib/copy';

export function Logo({ href = '/agents' }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {/* eslint-disable-next-line @next/next/no-img-element -- a 64px SVG, nothing to optimise */}
      <img src="/zynd.svg" alt="" width={28} height={28} className="size-7 rounded-md" />
      <span className="text-[15px] font-semibold tracking-tight">{copy.brand.name}</span>
    </Link>
  );
}
