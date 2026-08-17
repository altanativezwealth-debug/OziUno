import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Wrench,
  Plus,
  Search,
  Calendar,
  User,
  DollarSign,
  Clock,
  AlertTriangle,
  Trash2,
  RotateCcw,
  Phone,
  FileText,
  X,
  Sparkles,
} from 'lucide-react';
import { tw } from '../../lib/colors';

/**
 * Service Log — household maintenance history for OziUno.
 * Tracks what was done, when, by whom, cost, and recurrence so anyone
 * can answer "when did we last…?" in seconds.
 *
 * Table `service_logs` (created on first write):
 *   service_item (text), service_date (text), vendor (text),
 *   cost (text), notes (text), recurrence_months (number)
 */

interface ServiceLog {
  id: number;
  service_item: string;
  service_date: string;
  vendor: string;
  cost: string;
  notes: string;
  recurrence_months: number;
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

const RECURRENCE_OPTIONS = [
  { label: 'None', months: 0 },
  { label: 'Every 3 months', months: 3 },
  { label: 'Every 6 months', months: 6 },
  { label: 'Yearly', months: 12 },
  { label: 'Every 2 years', months: 24 },
  { label: 'Every 5 years', months: 60 },
];

const QUICK_ITEMS = [
  'HVAC / AC',
  'Furnace',
  'Water heater',
  'Gutters',
  'Roof inspection',
  'Chimney',
  'Septic',
  'Lawn mower',
];

/** Muted, non-interactive placeholders shown only in the first-run empty state. */
const EXAMPLE_TASKS = [
  { item: 'Schedule HVAC maintenance', detail: 'Repeats yearly · vendor and cost remembered for you' },
  { item: 'Update grocery preferences', detail: 'Keep household staples and brands current' },
  { item: "Log Jake's dietary restrictions", detail: 'So every meal plan gets it right' },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(iso: string): string {
  const d = parseDate(iso);
  if (!d) return iso || '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function daysUntil(date: Date): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function normalizeItem(name: string): string {
  return name.trim().toLowerCase();
}

interface ItemSummary {
  key: string;
  displayName: string;
  lastLog: ServiceLog;
  nextDue: Date | null;
  isOverdue: boolean;
  daysOverdue: number;
}

function buildSummaries(logs: ServiceLog[]): ItemSummary[] {
  const byItem = new Map<string, ServiceLog[]>();
  for (const log of logs) {
    const key = normalizeItem(log.service_item);
    if (!key) continue;
    const list = byItem.get(key) || [];
    list.push(log);
    byItem.set(key, list);
  }

  const summaries: ItemSummary[] = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  for (const [key, entries] of byItem) {
    const sorted = [...entries].sort(
      (a, b) => (parseDate(b.service_date)?.getTime() ?? 0) - (parseDate(a.service_date)?.getTime() ?? 0)
    );
    const lastLog = sorted[0];
    const months = Number(lastLog.recurrence_months) || 0;
    let nextDue: Date | null = null;
    let isOverdue = false;
    let daysOverdue = 0;

    if (months > 0) {
      const lastDate = parseDate(lastLog.service_date);
      if (lastDate) {
        nextDue = addMonths(lastDate, months);
        const diff = daysUntil(nextDue);
        if (diff < 0) {
          isOverdue = true;
          daysOverdue = Math.abs(diff);
        }
      }
    }

    summaries.push({
      key,
      displayName: lastLog.service_item,
      lastLog,
      nextDue,
      isOverdue,
      daysOverdue,
    });
  }

  return summaries.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.isOverdue && b.isOverdue) return b.daysOverdue - a.daysOverdue;
    return a.displayName.localeCompare(b.displayName);
  });
}

const emptyForm = () => ({
  service_item: '',
  service_date: todayISO(),
  vendor: '',
  cost: '',
  notes: '',
  recurrence_months: 12,
});

export default function ServiceLog() {
  const { data: logs, loading, error, refresh } = window.useWorkspaceDB<ServiceLog>('service_logs', {
    shared: true,
    orderBy: { column: 'service_date', direction: 'desc' },
    limit: 200,
  });

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [filterOverdue, setFilterOverdue] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const summaries = useMemo(() => buildSummaries(logs || []), [logs]);

  const overdueCount = useMemo(() => summaries.filter((s) => s.isOverdue).length, [summaries]);

  const filteredLogs = useMemo(() => {
    let list = logs || [];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (l) =>
          l.service_item?.toLowerCase().includes(q) ||
          l.vendor?.toLowerCase().includes(q) ||
          l.notes?.toLowerCase().includes(q)
      );
    }
    if (filterOverdue) {
      const overdueKeys = new Set(summaries.filter((s) => s.isOverdue).map((s) => s.key));
      list = list.filter((l) => overdueKeys.has(normalizeItem(l.service_item)));
    }
    return list;
  }, [logs, search, filterOverdue, summaries]);

  const handleSubmit = async () => {
    const item = form.service_item.trim();
    if (!item || !form.service_date || busy) return;
    setBusy(true);
    try {
      await window.__workspaceDb.from('service_logs').insert({
        service_item: item,
        service_date: form.service_date,
        vendor: form.vendor.trim(),
        cost: form.cost.trim(),
        notes: form.notes.trim(),
        recurrence_months: form.recurrence_months,
      });
      setForm(emptyForm());
      setShowForm(false);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: number) => {
    await window.__workspaceDb.from('service_logs').delete(id);
    refresh();
  };

  const updateForm = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="min-h-full flex flex-col w-full bg-transparent">
      {/* Hero stats */}
      <div className="px-5 pt-4 pb-3 border-b border-[var(--space-border-default)]">
        <div className="grid grid-cols-3 gap-2.5">
          <div className={`${tw.card.default} rounded-xl p-3 text-center transition-all duration-200`}>
            <p className={`text-[11px] uppercase tracking-wide ${tw.typography.color.tertiary}`}>Logged</p>
            <p className={`text-xl font-semibold mt-0.5 ${tw.typography.color.primary}`}>{logs?.length ?? 0}</p>
          </div>
          <div className={`${tw.card.default} rounded-xl p-3 text-center transition-all duration-200`}>
            <p className={`text-[11px] uppercase tracking-wide ${tw.typography.color.tertiary}`}>Tracked</p>
            <p className={`text-xl font-semibold mt-0.5 ${tw.typography.color.primary}`}>{summaries.length}</p>
          </div>
          <button
            type="button"
            onClick={() => setFilterOverdue((v) => !v)}
            className={`rounded-xl p-3 text-center transition-all duration-200 border ${
              filterOverdue
                ? 'border-[var(--space-semantic-warning)] bg-[var(--space-semantic-warning-100)] shadow-[0_2px_8px_color-mix(in_srgb,var(--space-semantic-warning)_25%,transparent)]'
                : `${tw.card.default}`
            }`}
          >
            <p className={`text-[11px] uppercase tracking-wide ${tw.typography.color.tertiary}`}>Overdue</p>
            <p
              className={`text-xl font-semibold mt-0.5 ${
                overdueCount > 0 ? 'text-[var(--space-semantic-warning)]' : tw.typography.color.primary
              }`}
            >
              {overdueCount}
            </p>
          </button>
        </div>
      </div>

      {/* Search + add */}
      <div className="px-5 py-3 flex flex-col sm:flex-row gap-2 border-b border-[var(--space-border-default)]">
        <div className="relative flex-1">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${tw.icon.muted}`} />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search services, vendors, notes…"
            className={`${tw.input.base} ${tw.input.default} pl-9 py-2.5 text-sm`}
            data-testid="input-search"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className={`px-4 py-2.5 rounded-xl text-sm font-medium flex items-center justify-center gap-1.5 shrink-0 transition-all duration-200 ${
            showForm ? `${tw.button.secondary}` : `${tw.button.primary}`
          }`}
          data-testid="button-toggle-form"
        >
          {showForm ? (
            <>
              <X className="w-4 h-4" /> Cancel
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" /> Log service
            </>
          )}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div
          className={`mx-5 mt-3 mb-1 ${tw.card.elevated} p-4 space-y-3 animate-in fade-in duration-200`}
          data-testid="panel-add-form"
        >
          <div>
            <label className={`block text-xs font-medium mb-1.5 ${tw.typography.color.secondary}`}>
              What was serviced?
            </label>
            <input
              type="text"
              value={form.service_item}
              onChange={(e) => updateForm({ service_item: e.target.value })}
              placeholder="e.g. HVAC tune-up, gutter cleaning"
              className={`${tw.input.base} ${tw.input.default} text-sm`}
              autoFocus
              data-testid="input-service-item"
            />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {QUICK_ITEMS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => updateForm({ service_item: item })}
                  className={`px-2 py-0.5 rounded-full text-[11px] ${tw.badge.neutral} hover:brightness-95 transition-all`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={`flex items-center gap-1 text-xs font-medium mb-1.5 ${tw.typography.color.secondary}`}>
                <Calendar className="w-3 h-3" /> Date
              </label>
              <input
                type="date"
                value={form.service_date}
                onChange={(e) => updateForm({ service_date: e.target.value })}
                className={`${tw.input.base} ${tw.input.default} text-sm`}
                data-testid="input-service-date"
              />
            </div>
            <div>
              <label className={`flex items-center gap-1 text-xs font-medium mb-1.5 ${tw.typography.color.secondary}`}>
                <RotateCcw className="w-3 h-3" /> Repeat every
              </label>
              <select
                value={form.recurrence_months}
                onChange={(e) => updateForm({ recurrence_months: Number(e.target.value) })}
                className={`${tw.input.base} ${tw.input.default} text-sm`}
                data-testid="select-recurrence"
              >
                {RECURRENCE_OPTIONS.map((opt) => (
                  <option key={opt.months} value={opt.months}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={`flex items-center gap-1 text-xs font-medium mb-1.5 ${tw.typography.color.secondary}`}>
                <User className="w-3 h-3" /> Vendor / contact
              </label>
              <input
                type="text"
                value={form.vendor}
                onChange={(e) => updateForm({ vendor: e.target.value })}
                placeholder="Company name, phone, tech name"
                className={`${tw.input.base} ${tw.input.default} text-sm`}
                data-testid="input-vendor"
              />
            </div>
            <div>
              <label className={`flex items-center gap-1 text-xs font-medium mb-1.5 ${tw.typography.color.secondary}`}>
                <DollarSign className="w-3 h-3" /> Cost
              </label>
              <input
                type="text"
                value={form.cost}
                onChange={(e) => updateForm({ cost: e.target.value })}
                placeholder="$189 or covered by warranty"
                className={`${tw.input.base} ${tw.input.default} text-sm`}
                data-testid="input-cost"
              />
            </div>
          </div>

          <div>
            <label className={`flex items-center gap-1 text-xs font-medium mb-1.5 ${tw.typography.color.secondary}`}>
              <FileText className="w-3 h-3" /> Notes
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => updateForm({ notes: e.target.value })}
              placeholder="What they did, parts replaced, warranty info…"
              rows={2}
              className={`${tw.input.base} ${tw.input.default} text-sm resize-none`}
              data-testid="input-notes"
            />
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !form.service_item.trim()}
            className={`w-full py-2.5 rounded-xl text-sm font-medium ${tw.button.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
            data-testid="button-save-service"
          >
            {busy ? 'Saving…' : 'Save to household log'}
          </button>
        </div>
      )}

      {/* Main scroll area */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="animate-spin rounded-full h-7 w-7 border-2 border-[var(--space-border-default)] border-t-[var(--space-brand-primary)]" />
            <p className={`text-sm ${tw.typography.color.tertiary}`}>Loading your service history…</p>
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className={`text-sm ${tw.typography.color.danger}`}>Couldn't load logs: {error.message}</p>
            <button
              type="button"
              onClick={refresh}
              className={`mt-3 px-3 py-1.5 text-sm rounded-lg ${tw.button.secondary}`}
            >
              Try again
            </button>
          </div>
        ) : !logs || logs.length === 0 ? (
          /* First-run onboarding — shown only when there are zero real entries */
          <div
            className="flex flex-col items-center justify-center py-10 text-center animate-in fade-in duration-300"
            data-testid="panel-empty-onboarding"
          >
            <div className={`w-16 h-16 rounded-2xl ${tw.bg.accent} flex items-center justify-center`}>
              <Sparkles className={`w-7 h-7 ${tw.icon.primary}`} />
            </div>
            <p className={`mt-4 text-base font-semibold ${tw.typography.color.primary}`}>
              No tasks yet — your household is all caught up!
            </p>
            <p className={`mt-1.5 text-sm max-w-sm ${tw.typography.color.tertiary}`}>
              Log anything you take care of around the house and OziUno will remember the details — so you
              never wonder "when did we last…?" again.
            </p>
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className={`mt-4 px-5 py-2.5 rounded-xl text-sm font-medium flex items-center gap-1.5 ${tw.button.primary}`}
              data-testid="button-add-first-task"
            >
              <Plus className="w-4 h-4" /> Add your first task
            </button>

            <div className="w-full max-w-md mt-8" aria-hidden="true">
              <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2.5 ${tw.typography.color.muted}`}>
                A few ideas to get you started
              </p>
              <ul className="space-y-2 select-none pointer-events-none">
                {EXAMPLE_TASKS.map((example) => (
                  <li
                    key={example.item}
                    className="rounded-xl p-3.5 border border-dashed border-[var(--space-border-default)] bg-[var(--space-surface-muted)]/60 opacity-60 text-left flex items-start gap-3"
                  >
                    <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${tw.bg.muted}`}>
                      <Wrench className={`w-4 h-4 ${tw.icon.muted}`} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className={`text-sm font-medium truncate ${tw.typography.color.secondary}`}>
                          {example.item}
                        </p>
                        <span className={`${tw.badge.default} ${tw.badge.neutral} shrink-0`}>Example</span>
                      </div>
                      <p className={`text-xs mt-0.5 ${tw.typography.color.muted}`}>{example.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <>
            {/* Last-service snapshot */}
            {summaries.length > 0 && !search && !filterOverdue && (
              <section>
                <h3 className={`text-xs font-semibold uppercase tracking-wide mb-2.5 ${tw.typography.color.tertiary}`}>
                  At a glance
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {summaries.slice(0, 4).map((s) => (
                    <div
                      key={s.key}
                      className={`${tw.card.default} rounded-xl p-3.5 flex items-start gap-3 transition-all duration-200 hover:-translate-y-px`}
                    >
                      <span
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                          s.isOverdue ? 'bg-[var(--space-semantic-warning-100)]' : tw.bg.muted
                        }`}
                      >
                        {s.isOverdue ? (
                          <AlertTriangle className={`w-4 h-4 text-[var(--space-semantic-warning)]`} />
                        ) : (
                          <Wrench className={`w-4 h-4 ${tw.icon.primary}`} />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium truncate ${tw.typography.color.primary}`}>
                          {s.displayName}
                        </p>
                        <p className={`text-xs mt-0.5 ${tw.typography.color.secondary}`}>
                          Last: {formatDate(s.lastLog.service_date)}
                          {s.lastLog.vendor && ` · ${s.lastLog.vendor}`}
                        </p>
                        {s.nextDue && (
                          <p
                            className={`text-[11px] mt-1 font-medium ${
                              s.isOverdue
                                ? 'text-[var(--space-semantic-warning)]'
                                : tw.typography.color.muted
                            }`}
                          >
                            {s.isOverdue
                              ? `Overdue by ${s.daysOverdue} day${s.daysOverdue === 1 ? '' : 's'}`
                              : `Next due ${formatDate(s.nextDue.toISOString().slice(0, 10))}`}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* History list */}
            <section>
              <div className="flex items-center justify-between mb-2.5">
                <h3 className={`text-xs font-semibold uppercase tracking-wide ${tw.typography.color.tertiary}`}>
                  {filterOverdue ? 'Overdue items' : search ? 'Search results' : 'Full history'}
                </h3>
                <span className={`text-[11px] ${tw.typography.color.muted}`}>
                  {filteredLogs.length} record{filteredLogs.length === 1 ? '' : 's'}
                </span>
              </div>

              {filteredLogs.length === 0 ? (
                <div className={`text-center py-10 text-sm ${tw.typography.color.tertiary}`}>
                  No matches — try a different search or clear filters.
                </div>
              ) : (
                <ul className="space-y-2">
                  {filteredLogs.map((log) => {
                    const summary = summaries.find((s) => s.key === normalizeItem(log.service_item));
                    const isLatest = summary?.lastLog.id === log.id;
                    const showOverdue = isLatest && summary?.isOverdue;

                    return (
                      <li
                        key={log.id}
                        className={`group ${tw.card.default} rounded-xl p-3.5 transition-all duration-200 hover:border-[var(--space-brand-primary-500)]/40`}
                        data-testid={`row-service-${log.id}`}
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                              showOverdue ? 'bg-[var(--space-semantic-warning-100)]' : tw.bg.muted
                            }`}
                          >
                            <Wrench
                              className={`w-4 h-4 ${
                                showOverdue ? 'text-[var(--space-semantic-warning)]' : tw.icon.primary
                              }`}
                            />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className={`text-sm font-semibold truncate ${tw.typography.color.primary}`}>
                                  {log.service_item}
                                </p>
                                <p className={`text-xs mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 ${tw.typography.color.secondary}`}>
                                  <span className="inline-flex items-center gap-1">
                                    <Calendar className="w-3 h-3" />
                                    {formatDate(log.service_date)}
                                  </span>
                                  {log.vendor && (
                                    <span className="inline-flex items-center gap-1">
                                      <Phone className="w-3 h-3" />
                                      {log.vendor}
                                    </span>
                                  )}
                                  {log.cost && (
                                    <span className="inline-flex items-center gap-1">
                                      <DollarSign className="w-3 h-3" />
                                      {log.cost}
                                    </span>
                                  )}
                                </p>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {showOverdue && (
                                  <span
                                    className={`${tw.badge.default} ${tw.badge.warning} flex items-center gap-1`}
                                  >
                                    <AlertTriangle className="w-3 h-3" />
                                    Overdue
                                  </span>
                                )}
                                {isLatest && Number(log.recurrence_months) > 0 && !showOverdue && (
                                  <span className={`${tw.badge.default} ${tw.badge.neutral} flex items-center gap-1`}>
                                    <Clock className="w-3 h-3" />
                                    Current
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleDelete(log.id)}
                                  className={`p-1.5 rounded-lg opacity-0 group-hover:opacity-100 focus:opacity-100 ${tw.icon.muted} hover:text-[var(--space-semantic-danger)] hover:bg-[var(--space-semantic-danger-100)] transition-all`}
                                  aria-label="Delete entry"
                                  data-testid={`button-delete-${log.id}`}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                            {log.notes && (
                              <p className={`text-xs mt-2 leading-relaxed ${tw.typography.color.secondary}`}>
                                {log.notes}
                              </p>
                            )}
                            {Number(log.recurrence_months) > 0 && (
                              <p className={`text-[11px] mt-1.5 ${tw.typography.color.muted}`}>
                                Repeats every{' '}
                                {RECURRENCE_OPTIONS.find((o) => o.months === Number(log.recurrence_months))?.label.toLowerCase() ||
                                  `${log.recurrence_months} months`}
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
          </>
        )}
      </div>

      {/* Footer hint */}
      {!loading && !error && (logs?.length ?? 0) > 0 && (
        <div className={`px-5 py-2 border-t border-[var(--space-border-default)] text-[11px] text-center ${tw.typography.color.muted}`}>
          Shared household log · visible to everyone in this space
        </div>
      )}
    </div>
  );
}
