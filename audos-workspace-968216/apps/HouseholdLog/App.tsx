import { useState, useMemo, useRef } from 'react';
import {
  Sun,
  Mic,
  Square,
  Send,
  Loader2,
  Calendar,
  Receipt,
  Heart,
  Wrench,
  Bell,
  StickyNote,
  Users,
  CheckCircle2,
  Trash2,
  Clock,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { tw } from '../../lib/colors';
import { useSpaceRuntime } from '../../SpaceRuntimeContext';

/**
 * Household Log — OziUno's memory, one tap from the conversation.
 *
 * Shows today's morning briefing, a voice/text quick-capture bar, the
 * family members OziUno knows, and the full auto-categorized feed of
 * everything the household has told OziUno.
 *
 * Tables (session-scoped — each household sees only its own data):
 *   household_entries  — category, title, details, person, event_date,
 *                        event_time, amount, status, raw_text, source
 *   household_members  — name, relationship, notes
 *   daily_briefings    — briefing_date, content, target_session_id
 */

interface HouseholdEntry {
  id: number;
  category: string;
  title: string;
  details?: string | null;
  person?: string | null;
  event_date?: string | null;
  event_time?: string | null;
  amount?: string | null;
  status?: string | null;
  raw_text?: string | null;
  source?: string | null;
  created_at?: string;
}

interface HouseholdMember {
  id: number;
  name: string;
  relationship?: string | null;
  notes?: string | null;
}

interface DailyBriefing {
  id: number;
  briefing_date: string;
  content: string;
  created_at?: string;
}

declare global {
  interface Window {
    useWorkspaceDB: <T = any>(
      table: string,
      options?: {
        shared?: boolean;
        limit?: number;
        offset?: number;
        orderBy?: { column: string; direction: 'asc' | 'desc' };
        filters?: Array<{ column: string; operator: string; value: any }>;
      }
    ) => { data: T[]; loading: boolean; error: Error | null; total: number; refresh: () => void };
    __workspaceDb: any;
  }
}

const CATEGORY_META: Record<string, { label: string; Icon: any }> = {
  schedule: { label: 'Schedule', Icon: Calendar },
  bill: { label: 'Bill', Icon: Receipt },
  preference: { label: 'Preference', Icon: Heart },
  maintenance: { label: 'Maintenance', Icon: Wrench },
  reminder: { label: 'Reminder', Icon: Bell },
  note: { label: 'Note', Icon: StickyNote },
};

const FILTERS = ['all', 'schedule', 'bill', 'preference', 'maintenance', 'reminder', 'note'];

function todayISO(): string {
  // Lagos is UTC+1 year-round
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function toDateStr(v?: string | null): string | null {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function formatDate(iso?: string | null): string {
  const s = toDateStr(iso);
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Ask the AI to structure a free-form capture into an entry. */
async function categorizeCapture(text: string): Promise<{
  category: string;
  title: string;
  details: string | null;
  person: string | null;
  event_date: string | null;
  event_time: string | null;
  amount: string | null;
}> {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getUTCDay()];
  const fallback = {
    category: 'note',
    title: text.length > 90 ? text.slice(0, 87) + '…' : text,
    details: text.length > 90 ? text : null,
    person: null,
    event_date: null,
    event_time: null,
    amount: null,
  };
  try {
    const res = await fetch('/proxy/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `You structure household notes for a Nigerian family assistant. Today is ${weekday}, ${todayISO()} (Africa/Lagos). ` +
              'Return ONLY a JSON object with keys: category (one of: schedule, bill, preference, maintenance, reminder, note), ' +
              'title (short summary, max 80 chars), details (string or null), person (family member name or null), ' +
              'event_date (YYYY-MM-DD or null — resolve relative dates like "Thursday" or "next Saturday" using today\'s date), ' +
              'event_time (like 14:00, or null), amount (money amount as written, e.g. "₦18,500", or null). ' +
              'schedule = appointment/event; bill = payment due; preference = likes/dislikes/allergies; ' +
              'maintenance = service/repair done; reminder = task to do; note = anything else.',
          },
          { role: 'user', content: text },
        ],
        stream: false,
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    if (!parsed || typeof parsed !== 'object' || !parsed.title) return fallback;
    const category = CATEGORY_META[String(parsed.category || '').toLowerCase()] ? String(parsed.category).toLowerCase() : 'note';
    return {
      category,
      title: String(parsed.title).slice(0, 120),
      details: parsed.details ? String(parsed.details) : null,
      person: parsed.person ? String(parsed.person) : null,
      event_date: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.event_date || '')) ? String(parsed.event_date) : null,
      event_time: parsed.event_time ? String(parsed.event_time) : null,
      amount: parsed.amount ? String(parsed.amount) : null,
    };
  } catch {
    return fallback;
  }
}

export default function HouseholdLog() {
  const { sessionId } = useSpaceRuntime();

  const { data: entries, loading, error, refresh } = window.useWorkspaceDB<HouseholdEntry>('household_entries', {
    orderBy: { column: 'created_at', direction: 'desc' },
    limit: 200,
  });
  const { data: members, refresh: refreshMembers } = window.useWorkspaceDB<HouseholdMember>('household_members', {
    orderBy: { column: 'created_at', direction: 'asc' },
    limit: 50,
  });
  const { data: briefings, refresh: refreshBriefings } = window.useWorkspaceDB<DailyBriefing>('daily_briefings', {
    orderBy: { column: 'created_at', direction: 'desc' },
    limit: 7,
  });

  const [capture, setCapture] = useState('');
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [justLogged, setJustLogged] = useState<string | null>(null);
  const mediaRecorderRef = useRef<any>(null);
  const chunksRef = useRef<Blob[]>([]);

  const today = todayISO();
  const todaysBriefing = useMemo(
    () => (briefings || []).find((b) => toDateStr(b.briefing_date) === today) || null,
    [briefings, today]
  );

  const activeEntries = useMemo(() => (entries || []).filter((e) => e.status !== 'done'), [entries]);
  const doneCount = (entries || []).length - activeEntries.length;

  const filtered = useMemo(() => {
    const list = entries || [];
    if (filter === 'all') return list;
    return list.filter((e) => e.category === filter);
  }, [entries, filter]);

  const dueSoon = useMemo(() => {
    const in7 = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return activeEntries
      .filter((e) => {
        const d = toDateStr(e.event_date);
        return d && d >= today && d <= in7;
      })
      .sort((a, b) => String(toDateStr(a.event_date)).localeCompare(String(toDateStr(b.event_date))));
  }, [activeEntries, today]);

  const logCapture = async (text: string, source: string) => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setMicError(null);
    try {
      const parsed = await categorizeCapture(trimmed);
      await window.__workspaceDb.from('household_entries').insert({
        category: parsed.category,
        title: parsed.title,
        details: parsed.details,
        person: parsed.person,
        event_date: parsed.event_date,
        event_time: parsed.event_time,
        amount: parsed.amount,
        status: 'active',
        raw_text: trimmed,
        source,
      });
      setCapture('');
      setJustLogged(`Logged as ${CATEGORY_META[parsed.category]?.label.toLowerCase() || 'note'}: ${parsed.title}`);
      setTimeout(() => setJustLogged(null), 4000);
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const startRecording = async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.('audio/webm')
        ? 'audio/webm'
        : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e: any) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 200) return;
        setTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('audio', blob, 'capture.webm');
          const res = await fetch('/api/generate/transcribe', { method: 'POST', body: formData });
          if (!res.ok) throw new Error('Transcription failed');
          const { text } = await res.json();
          if (text && text.trim()) {
            await logCapture(text, 'voice');
          } else {
            setMicError("Didn't catch that — try again a little closer to the mic.");
          }
        } catch {
          setMicError('Could not transcribe that recording. You can type it instead.');
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      setRecording(true);
    } catch {
      setMicError('Microphone access was blocked. Allow it in your browser settings, or type instead.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  const refreshBriefing = async () => {
    if (briefingBusy) return;
    setBriefingBusy(true);
    try {
      await fetch('/api/workspaces/968216/hooks/oziuno-morning-briefing/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify({ force: true, sessionId: sessionId || null }),
      });
      refreshBriefings();
    } finally {
      setBriefingBusy(false);
    }
  };

  const markDone = async (id: number) => {
    await window.__workspaceDb.from('household_entries').update(id, { status: 'done' });
    refresh();
  };

  const deleteEntry = async (id: number) => {
    await window.__workspaceDb.from('household_entries').delete(id);
    refresh();
  };

  const deleteMember = async (id: number) => {
    await window.__workspaceDb.from('household_members').delete(id);
    refreshMembers();
  };

  return (
    <div className="min-h-full flex flex-col w-full bg-transparent">
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Today's briefing */}
        <section className={`${tw.card.elevated} p-4`} data-testid="panel-briefing">
          <div className="flex items-center justify-between mb-2">
            <h3 className={`text-sm font-semibold flex items-center gap-1.5 ${tw.typography.color.primary}`}>
              <Sun className="w-4 h-4 text-[var(--space-semantic-warning)]" />
              Today's briefing
            </h3>
            <button
              type="button"
              onClick={refreshBriefing}
              disabled={briefingBusy}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 ${tw.button.secondary} disabled:opacity-50`}
              data-testid="button-refresh-briefing"
            >
              {briefingBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {todaysBriefing ? 'Refresh' : 'Get briefing'}
            </button>
          </div>
          {todaysBriefing ? (
            <p className={`text-sm leading-relaxed whitespace-pre-line ${tw.typography.color.secondary}`}>
              {todaysBriefing.content}
            </p>
          ) : (
            <p className={`text-sm ${tw.typography.color.tertiary}`}>
              Your personalized briefing lands here every morning around 6:30 AM — what's on today, bills due soon,
              and open reminders. Tap "Get briefing" to generate one now.
            </p>
          )}
        </section>

        {/* Quick capture */}
        <section>
          <div
            className={`rounded-2xl border transition-all overflow-hidden ${
              recording
                ? 'border-[var(--space-semantic-danger)] bg-[var(--space-surface-accent-soft)]'
                : 'border-[var(--space-border-strong)] bg-[var(--space-surface-card)]'
            }`}
          >
            <textarea
              value={capture}
              onChange={(e) => setCapture(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void logCapture(capture, 'app');
                }
              }}
              placeholder={
                recording
                  ? 'Listening… tap the square to finish'
                  : "Tell OziUno anything — \"Jake's dentist is Thursday at 3pm\", \"NEPA bill ₦18,500 due Friday\"…"
              }
              rows={2}
              disabled={saving || transcribing}
              className="w-full border-0 bg-transparent px-4 py-3 text-sm focus:outline-none focus:ring-0 resize-none leading-5"
              data-testid="textarea-capture"
            />
            <div className="flex items-center justify-between px-2 pb-2">
              <button
                type="button"
                onClick={recording ? stopRecording : startRecording}
                disabled={saving || transcribing}
                className={`h-9 w-9 flex items-center justify-center rounded-xl transition-colors ${
                  recording
                    ? 'bg-[var(--space-semantic-danger)] text-white animate-pulse'
                    : 'hover:bg-[var(--space-surface-muted)] text-[var(--space-text-secondary)]'
                } disabled:opacity-50`}
                title={recording ? 'Stop and log' : 'Speak to log'}
                data-testid="button-mic"
              >
                {recording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={() => void logCapture(capture, 'app')}
                disabled={!capture.trim() || saving || transcribing}
                className={`h-9 px-4 flex items-center gap-1.5 justify-center rounded-xl text-sm font-medium ${tw.button.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
                data-testid="button-log-capture"
              >
                {saving || transcribing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {transcribing ? 'Transcribing…' : saving ? 'Logging…' : 'Log it'}
              </button>
            </div>
          </div>
          {micError && <p className={`text-xs mt-1.5 ${tw.typography.color.danger}`}>{micError}</p>}
          {justLogged && (
            <p className="text-xs mt-1.5 flex items-center gap-1 text-[var(--space-semantic-success)]" data-testid="text-just-logged">
              <CheckCircle2 className="w-3.5 h-3.5" /> {justLogged}
            </p>
          )}
        </section>

        {/* Coming up */}
        {dueSoon.length > 0 && (
          <section>
            <h3 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${tw.typography.color.tertiary}`}>
              Coming up this week
            </h3>
            <div className="space-y-1.5">
              {dueSoon.slice(0, 5).map((e) => {
                const meta = CATEGORY_META[e.category] || CATEGORY_META.note;
                return (
                  <div key={e.id} className={`${tw.card.default} rounded-xl px-3.5 py-2.5 flex items-center gap-3`}>
                    <meta.Icon className={`w-4 h-4 shrink-0 ${tw.icon.primary}`} />
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${tw.typography.color.primary}`}>{e.title}</p>
                      <p className={`text-xs ${tw.typography.color.tertiary}`}>
                        {formatDate(e.event_date)}
                        {e.event_time ? ` · ${e.event_time}` : ''}
                        {e.amount ? ` · ${e.amount}` : ''}
                      </p>
                    </div>
                    {toDateStr(e.event_date) === today && (
                      <span className={`${tw.badge.default} ${tw.badge.warning} shrink-0`}>Today</span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Family */}
        {(members || []).length > 0 && (
          <section>
            <h3 className={`text-xs font-semibold uppercase tracking-wide mb-2 flex items-center gap-1 ${tw.typography.color.tertiary}`}>
              <Users className="w-3.5 h-3.5" /> Your household
            </h3>
            <div className="flex flex-wrap gap-2">
              {(members || []).map((m) => (
                <div
                  key={m.id}
                  className={`group ${tw.card.default} rounded-xl px-3 py-2 flex items-center gap-2`}
                  title={m.notes || undefined}
                >
                  <span className="w-7 h-7 rounded-full bg-[var(--space-surface-accent-soft)] flex items-center justify-center text-xs font-semibold text-[var(--space-text-brand)]">
                    {m.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className={`text-xs font-semibold ${tw.typography.color.primary}`}>{m.name}</p>
                    {m.relationship && <p className={`text-[10px] ${tw.typography.color.muted}`}>{m.relationship}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteMember(m.id)}
                    className={`opacity-0 group-hover:opacity-100 p-0.5 ${tw.icon.muted} hover:text-[var(--space-semantic-danger)] transition-all`}
                    aria-label={`Remove ${m.name}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Feed */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className={`text-xs font-semibold uppercase tracking-wide ${tw.typography.color.tertiary}`}>
              Everything OziUno remembers
            </h3>
            <span className={`text-[11px] ${tw.typography.color.muted}`}>
              {activeEntries.length} active{doneCount > 0 ? ` · ${doneCount} done` : ''}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5 mb-3">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${
                  filter === f ? tw.button.primary : tw.badge.neutral
                }`}
                data-testid={`filter-${f}`}
              >
                {f === 'all' ? 'All' : CATEGORY_META[f].label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="animate-spin rounded-full h-7 w-7 border-2 border-[var(--space-border-default)] border-t-[var(--space-brand-primary)]" />
              <p className={`text-sm ${tw.typography.color.tertiary}`}>Loading your household memory…</p>
            </div>
          ) : error ? (
            <div className="text-center py-10">
              <p className={`text-sm ${tw.typography.color.danger}`}>Couldn't load entries: {error.message}</p>
              <button type="button" onClick={refresh} className={`mt-3 px-3 py-1.5 text-sm rounded-lg ${tw.button.secondary}`}>
                Try again
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center" data-testid="panel-empty-feed">
              <div className={`w-14 h-14 rounded-2xl ${tw.bg.accent} flex items-center justify-center`}>
                <Sparkles className={`w-6 h-6 ${tw.icon.primary}`} />
              </div>
              <p className={`mt-3 text-sm font-semibold ${tw.typography.color.primary}`}>
                {filter === 'all' ? 'Nothing logged yet' : `No ${CATEGORY_META[filter]?.label.toLowerCase()} entries yet`}
              </p>
              <p className={`mt-1 text-xs max-w-xs ${tw.typography.color.tertiary}`}>
                Speak or type above — or just chat with OziUno. Everything you share is remembered here, sorted
                automatically.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {filtered.map((e) => {
                const meta = CATEGORY_META[e.category] || CATEGORY_META.note;
                const isDone = e.status === 'done';
                return (
                  <li
                    key={e.id}
                    className={`group ${tw.card.default} rounded-xl p-3.5 transition-all ${isDone ? 'opacity-55' : ''}`}
                    data-testid={`row-entry-${e.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${tw.bg.muted}`}>
                        <meta.Icon className={`w-4 h-4 ${tw.icon.primary}`} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-sm font-medium ${isDone ? 'line-through' : ''} ${tw.typography.color.primary}`}>
                            {e.title}
                          </p>
                          <div className="flex items-center gap-1 shrink-0">
                            <span className={`${tw.badge.default} ${tw.badge.neutral}`}>{meta.label}</span>
                            {!isDone && (
                              <button
                                type="button"
                                onClick={() => markDone(e.id)}
                                className={`p-1.5 rounded-lg opacity-0 group-hover:opacity-100 focus:opacity-100 ${tw.icon.muted} hover:text-[var(--space-semantic-success)] transition-all`}
                                aria-label="Mark done"
                                data-testid={`button-done-${e.id}`}
                              >
                                <CheckCircle2 className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => deleteEntry(e.id)}
                              className={`p-1.5 rounded-lg opacity-0 group-hover:opacity-100 focus:opacity-100 ${tw.icon.muted} hover:text-[var(--space-semantic-danger)] transition-all`}
                              aria-label="Delete entry"
                              data-testid={`button-delete-${e.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                        <p className={`text-xs mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 ${tw.typography.color.secondary}`}>
                          {e.person && <span>{e.person}</span>}
                          {e.event_date && (
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {formatDate(e.event_date)}
                              {e.event_time ? ` · ${e.event_time}` : ''}
                            </span>
                          )}
                          {e.amount && <span>{e.amount}</span>}
                          {e.source === 'voice' && (
                            <span className="inline-flex items-center gap-0.5">
                              <Mic className="w-3 h-3" /> voice
                            </span>
                          )}
                        </p>
                        {e.details && (
                          <p className={`text-xs mt-1.5 leading-relaxed ${tw.typography.color.secondary}`}>{e.details}</p>
                        )}
                        {e.created_at && (
                          <p className={`text-[10px] mt-1 flex items-center gap-1 ${tw.typography.color.muted}`}>
                            <Clock className="w-2.5 h-2.5" />
                            {new Date(e.created_at).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className={`px-5 py-2 border-t border-[var(--space-border-default)] text-[11px] text-center ${tw.typography.color.muted}`}>
        Private to your household · OziUno also logs things you say in chat
      </div>
    </div>
  );
}
