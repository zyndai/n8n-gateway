'use client';

import { Loader2, Send, Sparkles, Square } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { AgentBlueprint, BuildActivity, partsFromDraft } from '@/components/agent-blueprint';
import { applyEvent, currentActivity, decodeEvents, newView, type Activity, type BuildEvent, type BuildView, type Part, type Preview } from '@/lib/builder/events';
import { apiMessage, copy } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import { SAMPLE_BUILD, SAMPLE_BUILD_ASK, SAMPLE_EDIT, sampleBuildScript, sampleEditScript } from '@/lib/sample';
import { useStoredText } from '@/lib/use-stored';
import type { BuilderMode, Helper } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Msg {
  role: 'user' | 'agent';
  text: string;
}

interface Draft {
  name?: string;
  does?: string;
  helpers: readonly Helper[];
  costUsd?: string;
}

interface Saved {
  messages: Msg[];
  draft: Draft;
  step: number;
  thread: string | null;
  /** A message still being worked on by the server when this was saved (S5.2). */
  jobId?: string;
  /** The last job already shown, so it is not shown twice. */
  doneJob?: string;
  /** The picture of the agent and the activity of the last message (S5.3). */
  parts?: Part[];
  activity?: Activity[];
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const draftOf = (p: Preview): Draft => ({ name: p.name, does: p.does, helpers: p.helpers, costUsd: p.costUsd });

/** The chat bubbles one builder message adds: the question, the reply, and how it ended. */
function bubblesOf(v: BuildView): Msg[] {
  const out: Msg[] = [{ role: 'user', text: v.message }];
  if (v.reply.trim()) out.push({ role: 'agent', text: v.reply.trim() });
  if (v.live) out.push({ role: 'agent', text: copy.edit.live[v.live] });
  if (v.error) out.push({ role: 'agent', text: v.error });
  return out;
}

/** Reads one stream of numbered events into `onView`. Resolves true when the job said it had ended. */
async function readJob(res: Response, start: BuildView, onView: (v: BuildView) => void): Promise<{ view: BuildView; ended: boolean }> {
  let view = start;
  if (!res.body) return { view, ended: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, rest } = decodeEvents(buf);
    buf = rest;
    for (const e of events) {
      if (e.type === 'ping' || (typeof e.seq === 'number' && e.seq <= view.seq)) continue;
      view = applyEvent(view, e);
      onView(view);
    }
  }
  return { view, ended: view.status !== 'running' };
}

/** An error whose text is already plain words, so it may be shown as it is. Anything else becomes a generic line. */
class PlainError extends Error {}
const plainOf = (err: unknown): string => (err instanceof PlainError ? err.message : err instanceof TypeError ? copy.errors.network : copy.errors.generic);
const storeKey = (agentId: string) => `studio.build.${agentId}`;

function parseSaved(raw: string | null | undefined): Saved | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Saved>;
    if (!Array.isArray(s.messages) || typeof s.step !== 'number') return null;
    return {
      messages: s.messages.slice(-60),
      draft: s.draft ?? { helpers: [] },
      step: s.step >= 5 ? 5 : 0,
      thread: s.thread ?? null,
      ...(typeof s.jobId === 'string' ? { jobId: s.jobId } : {}),
      ...(typeof s.doneJob === 'string' ? { doneJob: s.doneJob } : {}),
      ...(Array.isArray(s.parts) ? { parts: s.parts.slice(0, 40) } : {}),
      ...(Array.isArray(s.activity) ? { activity: s.activity.slice(-40) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The Create agent screen. In preview it plays a short scripted build with sample content, so the look and the flow
 * can be judged. In live mode the first message creates the agent, then the builder works on it and streams back.
 * With `editing` it is the Make changes tab of an agent that already exists: the same chat, with the progress list
 * only, since the agent's own page already shows its name and what it does.
 */
export function Builder(props: { mode: BuilderMode; agentId?: string; initialIdea?: string; editing?: { live: boolean } }) {
  // Come back to the same conversation after a reload (kept in this browser, per agent).
  const raw = useStoredText(props.mode === 'live' && props.agentId ? storeKey(props.agentId) : null);
  if (raw === undefined) return <div className="h-[28rem] animate-pulse rounded-xl border bg-card" aria-hidden />;
  return <BuilderView {...props} saved={parseSaved(raw)} />;
}

function BuilderView({ mode, agentId: initialAgentId, initialIdea, editing, saved }: { mode: BuilderMode; agentId?: string; initialIdea?: string; editing?: { live: boolean }; saved: Saved | null }) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(saved?.messages ?? []);
  const [input, setInput] = useState(initialIdea ?? '');
  const [draft, setDraft] = useState<Draft>(saved?.draft ?? { helpers: [] });
  const [step, setStep] = useState(editing ? 0 : (saved?.step ?? 0)); // 0 not started; 1..4 = the step in progress; 5 = all done
  const [parts, setParts] = useState<Part[]>(saved?.parts ?? []);
  const [activity, setActivity] = useState<Activity[]>(saved?.activity ?? []);
  const [agentId, setAgentId] = useState<string | undefined>(initialAgentId);
  const [thread, setThread] = useState<string | null>(saved?.thread ?? null);
  // The message the server is working on now (S5.2). It runs on the server: a reload only reattaches to it.
  const [job, setJob] = useState<BuildView | null>(null);
  const [doneJob, setDoneJob] = useState<string | undefined>(saved?.doneJob);
  const [pendingJob, setPendingJob] = useState<string | undefined>(saved?.jobId);
  const [stopping, setStopping] = useState(false);
  const alive = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);
  const live = mode === 'live';
  const demo = mode === 'preview';

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const jobId = job?.id ?? pendingJob;
  useEffect(() => {
    if (!live || !agentId) return;
    try {
      const value: Saved = { messages: messages.slice(-60), draft, step, thread, parts, activity, ...(jobId ? { jobId } : {}), ...(doneJob ? { doneJob } : {}) };
      window.localStorage.setItem(storeKey(agentId), JSON.stringify(value));
    } catch {
      /* storage is a convenience: without it the chat just does not come back after a reload */
    }
  }, [live, agentId, messages, draft, step, thread, parts, activity, jobId, doneJob]);

  const thinking = job?.status === 'running';
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, thinking, job?.reply]);

  /** A message that has ended becomes part of the chat for good. */
  const settle = useCallback(
    (v: BuildView) => {
      if (!alive.current) return;
      setMessages((prev) => [...prev, ...bubblesOf(v)]);
      if (v.thread) setThread(v.thread);
      if (v.preview) setDraft(draftOf(v.preview));
      if (v.parts.length) setParts(v.parts);
      if (v.activity.length) setActivity(v.activity);
      setStep(v.step);
      setDoneJob(v.id);
      setPendingJob(undefined);
      setJob(null);
      setStopping(false);
      if (v.live === 'updated') toast.success(copy.edit.live.updated);
      // What the agent is called and what it does may have changed: the page above the chat shows them.
      if (editing) router.refresh();
    },
    [editing, router],
  );

  /** Follows a job until it ends, picking the stream up again when it drops (a proxy, a sleeping laptop). */
  const follow = useCallback(
    async (id: string, first: Response | null, start: BuildView) => {
      let view = start;
      const show = (v: BuildView) => alive.current && setJob(v);
      show(view);
      let res = first;
      for (let attempt = 0; alive.current; attempt++) {
        try {
          res ??= await fetch(`/api/agents/${encodeURIComponent(id)}/build?after=${view.seq}`, { cache: 'no-store' });
          if (res.status === 404) break; // the server no longer has it (it restarted)
          if (!res.ok) throw new PlainError(apiMessage(((await res.json().catch(() => ({}))) as { error?: string }).error));
          const out = await readJob(res, view, show);
          view = out.view;
          if (out.ended) return settle(view);
          attempt = 0;
        } catch (err) {
          if (err instanceof PlainError) return settle({ ...view, status: 'error', error: err.message });
        }
        res = null;
        await wait(Math.min(1000 * 2 ** attempt, 15_000));
      }
      if (alive.current) settle({ ...view, status: 'error', error: copy.errors.cutOff });
    },
    [settle],
  );

  // Coming back to this screen: show a message the server is still working on, or how one ended while away.
  useEffect(() => {
    if (!live || !initialAgentId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/agents/${encodeURIComponent(initialAgentId)}/build`, { cache: 'no-store' }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as { job?: BuildView | null } | null) : null;
      if (cancelled || !alive.current || !body) return;
      const found = body.job ?? null;
      if (found && found.id !== saved?.doneJob) {
        if (found.status === 'running') void follow(initialAgentId, null, found);
        else settle(found);
      } else if (saved?.jobId && saved.jobId !== found?.id) {
        // It was being worked on when this screen closed, and the server no longer knows it.
        setMessages((prev) => [...prev, { role: 'agent', text: copy.errors.cutOff }]);
        setPendingJob(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once, on arrival: later messages are followed by `sendLive`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const asked = messages.filter((m) => m.role === 'user').length;

  /** Preview mode: plays a scripted message through the same view a real build uses. */
  async function play(text: string, script: [number, BuildEvent][]) {
    let v = newView(`sample-${Date.now()}`, text, Date.now());
    setJob(v);
    for (const [ms, e] of script) {
      if (ms) await wait(ms);
      if (!alive.current) return;
      v = applyEvent(v, e);
      setJob(v);
    }
    settle(v);
  }

  /** Scripted build for preview mode: two questions first, then the build. */
  async function sendDemo(text: string) {
    if (asked === 0) {
      await play(text, SAMPLE_BUILD_ASK);
      if (alive.current) setDraft((d) => ({ ...d, name: SAMPLE_BUILD.agent.name }));
      return;
    }
    await play(text, sampleBuildScript());
  }

  /** The real thing: make the agent on the first message, then start the builder's work on the server and follow it. */
  async function sendLive(text: string) {
    const startView = (id: string) => newView(id, text, Date.now());
    // Shown at once; replaced by the server's job as soon as it answers.
    setJob(startView('starting'));
    setStep(0);
    let id = agentId;
    try {
      if (!id) {
        const res = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; credit?: { status: string; amountUsd?: string; reason?: string } };
        if (!res.ok || !body.id) throw new PlainError(apiMessage(body.error));
        id = body.id;
        setAgentId(id);
        window.history.replaceState(null, '', `/agents/new?agent=${encodeURIComponent(id)}`);
        if (body.credit?.status === 'sent') toast.success(copy.create.creditSent(formatUsd(body.credit.amountUsd)));
        else if (body.credit?.status === 'failed' || body.credit?.reason === 'low-balance') toast(copy.create.creditNone);
      }

      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, thread }),
      });
      if (res.status === 409) {
        // Already being worked on (another tab, or a double send): follow that one instead.
        setJob(null);
        const snap = (await fetch(`/api/agents/${encodeURIComponent(id)}/build`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)) as { job?: BuildView | null } | null;
        if (snap?.job?.status === 'running') return void (await follow(id, null, snap.job));
        throw new PlainError(copy.errors.busy);
      }
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new PlainError(apiMessage(body.error));
      }
      const jobIdHeader = res.headers.get('X-Build-Job') ?? crypto.randomUUID();
      setPendingJob(jobIdHeader);
      await follow(id, res, startView(jobIdHeader));
    } catch (err) {
      settle({ ...startView(`failed-${Date.now()}`), status: 'error', error: plainOf(err) });
    }
  }

  /** Asks the server to stop the message it is working on. The stream then ends with a plain note. */
  async function stop() {
    if (!agentId || stopping) return;
    setStopping(true);
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/build`, { method: 'DELETE' }).catch(() => null);
  }

  async function send() {
    const text = input.trim();
    if (!text || thinking || mode === 'off') return;
    if (demo && step > 0) return;
    setInput('');
    if (demo) await (editing ? play(text, sampleEditScript()) : sendDemo(text));
    else await sendLive(text);
  }

  const shown = job ? [...messages, ...bubblesOf(job)] : messages;
  const view = job?.preview ? draftOf(job.preview) : draft;
  const atStep = job ? job.step : step;
  const done = atStep === 5;
  const empty = !view.name && !view.does && view.helpers.length === 0;
  const locked = mode === 'off' || (demo && step > 0);
  const stepLabels = editing ? copy.edit.steps : copy.create.steps;
  const chatTitle = editing ? copy.edit.chatTitle : copy.create.chatTitle;
  const placeholder = editing ? copy.edit.placeholder : done && live ? copy.create.continueHint : copy.create.placeholder;
  // The picture: what this message has shown so far, else the last one, else what the preview card knows.
  const picture = job?.parts.length ? job.parts : parts.length ? parts : !empty && !editing ? partsFromDraft(view.helpers, done) : [];
  const lines = job ? job.activity : activity;
  const working = (job && currentActivity(job)?.label) || copy.agent.working;
  const showAgent = !editing || picture.length > 0 || thinking;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className={cn('flex min-h-[24rem] flex-col gap-0 py-0 shadow-none', editing ? 'h-[min(34rem,calc(100vh-17rem))]' : 'h-[min(36rem,calc(100vh-11rem))] min-h-[28rem]')}>
        <CardHeader className="gap-0 border-b px-5 py-4">
          <CardTitle className="text-[15px]">{chatTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col px-0">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5" aria-live="polite">
            {mode === 'off' ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{copy.create.notReady}</p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{editing ? (editing.live ? copy.edit.introLive : copy.edit.intro) : copy.create.placeholder}</p>
            ) : null}
            {shown.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <p className={cn('max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap', m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground')}>{m.text}</p>
              </div>
            ))}
            {thinking ? (
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 rounded-2xl bg-secondary px-4 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                  <span className="min-w-0 break-words">{working}</span>
                </p>
                {live && job && job.id !== 'starting' && !job.id.startsWith('sample-') ? (
                  <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void stop()} disabled={stopping}>
                    <Square className="size-3" aria-hidden />
                    {copy.create.stop}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
          <form
            className="flex items-end gap-2 border-t p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={placeholder}
              aria-label={chatTitle}
              rows={2}
              maxLength={2000}
              disabled={locked}
              className="min-h-11 resize-none shadow-none"
            />
            <Button type="submit" size="icon-lg" disabled={locked || !input.trim() || thinking} aria-label={copy.create.send}>
              <Send aria-hidden />
            </Button>
          </form>
          {demo && !editing && asked === 1 && step === 0 && !thinking ? (
            <div className="border-t px-3 py-2">
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setInput(SAMPLE_BUILD.followUp)}>
                <Sparkles aria-hidden />
                {SAMPLE_BUILD.followUp}
              </Button>
            </div>
          ) : null}
          {demo && editing && asked === 0 && !thinking ? (
            <div className="border-t px-3 py-2">
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setInput(SAMPLE_EDIT.suggestion)}>
                <Sparkles aria-hidden />
                {SAMPLE_EDIT.suggestion}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-6">
        {showAgent ? (
          <Card className="gap-0 py-0 shadow-none">
            <CardHeader className="gap-0 border-b px-5 py-4">
              <CardTitle className="text-[15px]">{copy.create.previewTitle}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 px-5 py-5">
              {atStep > 0 || thinking || done ? <StepBar labels={stepLabels} at={atStep} /> : null}
              {!editing && (view.name || view.does) ? (
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{view.name ?? <Pending />}</p>
                  <p className="text-sm leading-6 text-muted-foreground">{view.does ?? <Pending />}</p>
                </div>
              ) : null}
              {picture.length ? (
                <AgentBlueprint parts={picture} />
              ) : (
                <p className="text-sm text-muted-foreground">{copy.create.previewEmpty}</p>
              )}
              {!editing && view.costUsd ? (
                <Field label={copy.create.costLabel}>
                  <span className="font-medium tabular-nums">{formatUsd(view.costUsd)}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{copy.create.costNote}</span>
                </Field>
              ) : null}
              {done && !editing ? (
                <Button asChild className="w-full">
                  <Link href={demo ? '/agents/sample-supplier-check' : `/agents/${agentId ?? ''}`}>{copy.create.open}</Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {lines.length ? (
          <Card className="gap-0 py-0 shadow-none">
            <CardHeader className="gap-0 border-b px-5 py-4">
              <CardTitle className="text-[15px]">{copy.create.activityTitle}</CardTitle>
            </CardHeader>
            <CardContent className="max-h-72 overflow-y-auto px-5 py-4">
              <BuildActivity items={lines} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/** The four steps as a thin bar: done, the one in progress, still to come. */
function StepBar({ labels, at }: { labels: readonly string[]; at: number }) {
  return (
    <ol className="grid grid-cols-4 gap-1.5" aria-label={copy.create.stepsTitle}>
      {labels.map((label, i) => {
        const n = i + 1;
        const state = at > n || at === 5 ? 'done' : at === n ? 'active' : 'todo';
        return (
          <li key={label} aria-current={state === 'active' ? 'step' : undefined}>
            <div className={cn('h-1 rounded-full transition-colors duration-500', state === 'done' ? 'bg-success' : state === 'active' ? 'animate-pulse bg-primary motion-reduce:animate-none' : 'bg-muted')} />
            <span className={cn('mt-1.5 block text-[11px] leading-tight', state === 'todo' ? 'text-muted-foreground' : 'font-medium')}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="text-sm leading-6">{children}</div>
    </div>
  );
}

function Pending() {
  return <span className="inline-block h-4 w-32 animate-pulse rounded bg-muted align-middle" aria-hidden />;
}
