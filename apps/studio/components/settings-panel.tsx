'use client';

import { Loader2, Pause, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { DESCRIPTION_MAX } from '@/components/publish-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiMessage, copy } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import type { Agent, BuilderMode } from '@/lib/types';

type Call = { method: 'PATCH' | 'POST' | 'DELETE'; path: string; body?: unknown };

export function SettingsPanel({ agent, mode }: { agent: Agent; mode: BuilderMode }) {
  const router = useRouter();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.summary.slice(0, DESCRIPTION_MAX));
  const [price, setPrice] = useState(agent.priceUsd ?? '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'save' | 'pause' | 'delete' | null>(null);
  const s = copy.agent.settings;
  const enabled = mode !== 'off';
  const preview = mode === 'preview';

  /** One action against the API. Returns true when it worked; otherwise the person has already been told why. */
  async function act(kind: 'save' | 'pause' | 'delete', call: Call): Promise<boolean> {
    setBusy(kind);
    try {
      const res = await fetch(call.path, {
        method: call.method,
        headers: call.body !== undefined ? { 'Content-Type': 'application/json' } : {},
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(apiMessage(body.error));
        return false;
      }
      return true;
    } catch {
      toast.error(copy.errors.generic);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (preview) return void toast.success(copy.agent.saved);
    const trimmed = price.trim();
    const ok = await act('save', { method: 'PATCH', path: `/api/agents/${encodeURIComponent(agent.id)}`, body: { name, summary: description, priceUsd: trimmed === '' ? null : trimmed } });
    if (ok) {
      toast.success(copy.agent.saved);
      router.refresh();
    }
  }

  async function pause() {
    if (preview) return void toast.success(copy.agent.paused);
    if (await act('pause', { method: 'POST', path: `/api/agents/${encodeURIComponent(agent.id)}/pause`, body: {} })) {
      toast.success(copy.agent.paused);
      router.refresh();
    }
  }

  async function remove() {
    if (!preview && !(await act('delete', { method: 'DELETE', path: `/api/agents/${encodeURIComponent(agent.id)}` }))) return;
    setConfirming(false);
    toast.success(copy.agent.deleted);
    router.push('/agents');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <section className="space-y-5 rounded-xl border bg-card p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold tracking-tight">{s.title}</h2>
        <div className="space-y-2">
          <Label htmlFor="set-name">{s.name}</Label>
          <Input id="set-name" value={name} maxLength={100} disabled={!enabled} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="set-desc">{s.description}</Label>
          <Textarea id="set-desc" value={description} maxLength={DESCRIPTION_MAX} rows={3} disabled={!enabled} onChange={(e) => setDescription(e.target.value)} />
          <p className="flex justify-between text-xs text-muted-foreground">
            <span>{s.descriptionHelp}</span>
            <span className="tabular-nums">
              {description.length}/{DESCRIPTION_MAX}
            </span>
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="set-price">{s.price}</Label>
          <Input id="set-price" inputMode="decimal" value={price} disabled={!enabled} onChange={(e) => setPrice(e.target.value)} className="max-w-32 tabular-nums" />
          <p className="text-xs text-muted-foreground">{s.priceHelp}</p>
        </div>
        <Button disabled={!enabled || busy !== null || !name.trim() || !description.trim()} onClick={() => void save()}>
          {busy === 'save' ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {s.save}
        </Button>
      </section>

      <section className="divide-y rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 sm:px-6">
          <div>
            <h3 className="text-sm font-medium">{s.pause}</h3>
            <p className="text-sm text-muted-foreground">{s.pauseHelp}</p>
          </div>
          <Button variant="outline" disabled={!enabled || busy !== null || agent.status !== 'live'} onClick={() => void pause()}>
            {busy === 'pause' ? <Loader2 className="animate-spin" aria-hidden /> : <Pause aria-hidden />}
            {s.pause}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 sm:px-6">
          <div>
            <h3 className="text-sm font-medium">{s.delete}</h3>
            <p className="text-sm text-muted-foreground">{s.deleteHelp}</p>
          </div>
          <Dialog open={confirming} onOpenChange={(o) => busy !== 'delete' && setConfirming(o)}>
            <DialogTrigger asChild>
              <Button variant="outline" disabled={!enabled || busy !== null} className="border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive">
                <Trash2 aria-hidden />
                {s.delete}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{s.deleteTitle}</DialogTitle>
                <DialogDescription>{s.deleteBody(formatUsd(agent.creditUsd))}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={busy === 'delete'} onClick={() => setConfirming(false)}>
                  {s.cancel}
                </Button>
                <Button variant="destructive" disabled={busy === 'delete'} onClick={() => void remove()}>
                  {busy === 'delete' ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {s.deleteConfirm}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </section>
    </div>
  );
}
