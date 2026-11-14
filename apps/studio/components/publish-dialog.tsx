'use client';

import { Loader2, Rocket } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiMessage, copy } from '@/lib/copy';
import type { Agent, BuilderMode } from '@/lib/types';

export const DESCRIPTION_MAX = 200;

export function PublishDialog({ agent, mode }: { agent: Agent; mode: BuilderMode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.summary.slice(0, DESCRIPTION_MAX));
  const [price, setPrice] = useState(agent.priceUsd ?? '0.10');
  const [problem, setProblem] = useState<string | null>(null);
  const valid = name.trim().length > 0 && description.trim().length > 0 && /^\d{1,3}(\.\d{1,6})?$/.test(price.trim());
  const canPublish = mode === 'preview' || (mode === 'live' && agent.hasWorkflow);

  async function publish() {
    if (mode === 'preview') {
      setOpen(false);
      toast.success(copy.publish.done);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, summary: description, priceUsd: price.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setProblem(apiMessage(body.error));
        return;
      }
      setOpen(false);
      toast.success(copy.publish.done);
      router.refresh();
    } catch {
      setProblem(copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogTrigger asChild>
        <Button disabled={!canPublish}>
          <Rocket aria-hidden />
          {copy.agent.publish}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.publish.title}</DialogTitle>
          <DialogDescription>{copy.publish.body}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pub-name">{copy.publish.name}</Label>
            <Input id="pub-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pub-desc">{copy.publish.description}</Label>
            <Textarea id="pub-desc" value={description} maxLength={DESCRIPTION_MAX} rows={3} onChange={(e) => setDescription(e.target.value)} />
            <p className="text-right text-xs tabular-nums text-muted-foreground">
              {description.length}/{DESCRIPTION_MAX}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pub-price">{copy.publish.price}</Label>
            <Input id="pub-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="max-w-32 tabular-nums" />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">{copy.publish.note}</p>
          {problem ? (
            <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              {problem}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            {copy.publish.cancel}
          </Button>
          <Button disabled={!valid || busy} onClick={() => void publish()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {copy.publish.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
