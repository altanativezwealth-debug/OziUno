import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Shield, Users, Search, RefreshCw, ChevronUp, ChevronDown, ArrowLeft, Trash2,
  Database, LayoutDashboard, AlertTriangle, Lock, CheckCircle2, XCircle, Crown, LifeBuoy,
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════════════
 * OziUno ADMIN PORTAL — internal dashboard for the workspace admin.
 *
 * ACCESS CONTROL: only emails in ADMIN_EMAILS below may view this app.
 * Everyone else (including signed-in customers) sees an "Access restricted"
 * screen and NO data is fetched. Login itself is the standard OziUno email
 * gate — this app just checks the authenticated email against the allowlist.
 * ═══════════════════════════════════════════════════════════════════════════ */

// ─── ADMIN ALLOWLIST ── add more admin emails here (lowercase) ──────────────
const ADMIN_EMAILS: string[] = [
  "altanativez.wealth@gmail.com",
];
// ────────────────────────────────────────────────────────────────────────────

function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = String(email).toLowerCase().trim();
  return ADMIN_EMAILS.some((e) => e.toLowerCase().trim() === normalized);
}

const TRIAL_DAYS = 7;
const DAY_MS = 86400000;

/* ------------------------------- data access ------------------------------ */

type Row = Record<string, any>;

const wdb = () => (window as any).__workspaceDb;
// Admin reads bypass session scoping: { shared: true } returns every row.
const sdb = (table: string) => wdb().from(table, { shared: true });

async function fetchAll(table: string, householdId?: number | null): Promise<Row[]> {
  try {
    let q = sdb(table);
    if (householdId != null) q = q.eq("household_id", householdId);
    const { data } = await q.limit(1000).get();
    return Array.isArray(data) ? (data as Row[]) : [];
  } catch (err) {
    console.warn("[AdminPortal] fetch failed:", table, err);
    return [];
  }
}

/* --------------------------- signed-in account ---------------------------- */

function getSpaceId(): string {
  const w = window as any;
  return w.__SPACE_ID__ || w.__APP_ID__ || "workspace-968216";
}

/** Same mechanism as the main OziUno app: the email-gate login stored in localStorage. */
function getAccount(): { email: string | null; sessionId: string | null } {
  try {
    let raw = localStorage.getItem(`space_session_${getSpaceId()}`);
    if (!raw) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || "";
        if (key.startsWith("space_session_")) { raw = localStorage.getItem(key); break; }
      }
    }
    if (raw) {
      const s = JSON.parse(raw) as { email?: string; workspaceSessionId?: string; sessionId?: string; id?: string };
      const email = typeof s.email === "string" && s.email.includes("@") ? s.email.toLowerCase().trim() : null;
      const sessionId = s.workspaceSessionId || s.sessionId || s.id || null;
      return { email, sessionId };
    }
  } catch { /* storage unavailable */ }
  return { email: null, sessionId: null };
}

/* -------------------------------- helpers --------------------------------- */

function fmtDate(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function trialDaysLeft(startedAt: unknown): number {
  const t = new Date(String(startedAt)).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t + TRIAL_DAYS * DAY_MS - Date.now()) / DAY_MS));
}

type SubStatus = "Subscribed" | "Trialing" | "Trial expired" | "No trial";

function statusOf(trial: Row | null, subscribed: boolean): SubStatus {
  if (subscribed) return "Subscribed";
  if (!trial) return "No trial";
  return trialDaysLeft(trial.trial_started_at) > 0 ? "Trialing" : "Trial expired";
}

const MONEY_COLS = new Set(["amount_ngn", "limit_ngn", "spent_ngn", "est_cost_ngn", "monthly_food_budget_ngn"]);

interface Currency { code: string; symbol: string }
const DEFAULT_CURRENCY: Currency = { code: "NGN", symbol: "₦" };

/* ------------------------------ core dataset ------------------------------ */

interface CoreData {
  households: Row[];
  memberships: Row[];
  trials: Row[];
  profiles: Row[];
  settings: Row[];
}

interface AccountRow {
  key: string;
  householdId: number | null;
  householdName: string;
  householdCode: string;
  email: string;
  ownerName: string;
  members: number;
  trial: Row | null;
  trialStart: string | null;
  daysLeft: number;
  status: SubStatus;
  signup: string | null;
  onboarded: boolean;
}

function buildAccounts(data: CoreData): AccountRow[] {
  const { households, memberships, trials, profiles } = data;
  const usedTrialIds = new Set<number>();
  const rows: AccountRow[] = [];

  for (const h of households) {
    const members = memberships.filter((m) => Number(m.household_id) === Number(h.id));
    const owner = members.find((m) => m.role === "owner")
      || members.find((m) => m.email && h.owner_email && String(m.email).toLowerCase() === String(h.owner_email).toLowerCase())
      || members[0]
      || null;
    const memberSessions = members.map((m) => m.account_session_id).filter(Boolean) as string[];
    // Household-keyed trial rows (the current model — one trial per household_id)
    // take precedence; rows matched only via a member's session_id are legacy
    // records from the per-visitor era before the 2026-08 re-keying.
    const hhKeyed = trials.filter((t) => t.household_id != null && Number(t.household_id) === Number(h.id));
    const sessionLinked = trials.filter((t) => t.session_id && memberSessions.includes(String(t.session_id)));
    const linked = [...hhKeyed, ...sessionLinked.filter((t) => !hhKeyed.some((k) => Number(k.id) === Number(t.id)))];
    linked.forEach((t) => usedTrialIds.add(Number(t.id)));
    const byStart = (a: Row, b: Row) => new Date(String(a.trial_started_at)).getTime() - new Date(String(b.trial_started_at)).getTime();
    const ownerTrial = owner?.account_session_id
      ? sessionLinked.find((t) => t.session_id === owner.account_session_id) || null
      : null;
    const trial = [...hhKeyed].sort(byStart)[0]
      || ownerTrial
      || [...sessionLinked].sort(byStart)[0]
      || null;
    const subscribed = linked.some((t) => !!t.subscribed);
    rows.push({
      key: `hh-${h.id}`,
      householdId: Number(h.id),
      householdName: String(h.name || "(unnamed)"),
      householdCode: String(h.household_code || ""),
      email: String(owner?.email || h.owner_email || "—"),
      ownerName: String(owner?.name || h.owner_name || "—"),
      members: members.length,
      trial,
      trialStart: trial ? String(trial.trial_started_at) : null,
      daysLeft: trial ? trialDaysLeft(trial.trial_started_at) : 0,
      status: statusOf(trial, subscribed),
      signup: h.created_at ? String(h.created_at) : null,
      onboarded: !!h.onboarded,
    });
  }

  // Trial rows not linked to any household member (signed up, never created/joined a household)
  for (const t of trials) {
    if (usedTrialIds.has(Number(t.id))) continue;
    const profile = profiles.find((p) => p.session_id && p.session_id === t.session_id);
    const membership = data.memberships.find((m) => m.account_session_id && m.account_session_id === t.session_id);
    rows.push({
      key: `trial-${t.id}`,
      householdId: null,
      householdName: profile ? `${String(profile.household_name || "").trim()} (no household record)` : "(no household)",
      householdCode: "",
      email: String(membership?.email || "—"),
      ownerName: String(membership?.name || "—"),
      members: 0,
      trial: t,
      trialStart: String(t.trial_started_at),
      daysLeft: trialDaysLeft(t.trial_started_at),
      status: statusOf(t, !!t.subscribed),
      signup: t.created_at ? String(t.created_at) : null,
      onboarded: false,
    });
  }

  return rows;
}

/* --------------------------------- styles --------------------------------- */

// Fonts via <link> (parallel, non-blocking) instead of a serial CSS @import.
try {
  if (typeof document !== "undefined" && !document.getElementById("ozi-fonts")) {
    const fontLink = document.createElement("link");
    fontLink.id = "ozi-fonts";
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap";
    document.head.appendChild(fontLink);
  }
} catch { /* document unavailable */ }

const ADM_CSS = `
.adm-root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#10151F;color:#E8ECF1;min-height:100vh;-webkit-font-smoothing:antialiased;font-size:14px}
.adm-display{font-family:"Instrument Serif",serif;letter-spacing:-0.01em}
.adm-wrap{max-width:1280px;margin:0 auto;padding:1.25rem 1rem 4rem}
.adm-header{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.75rem 0 1rem}
.adm-muted{color:#8B97A8}
.adm-tabs{display:flex;gap:.375rem;flex-wrap:wrap;margin-bottom:1rem}
.adm-tab{display:inline-flex;align-items:center;gap:.4rem;border-radius:9999px;border:1px solid rgba(232,236,241,.12);background:transparent;color:#8B97A8;padding:.4rem .9rem;font-size:.8125rem;font-weight:500;cursor:pointer}
.adm-tab.active{background:#0B6E4F;border-color:#0B6E4F;color:#FAFAF8}
.adm-tab:hover:not(.active){border-color:rgba(232,236,241,.3);color:#E8ECF1}
.adm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin-bottom:1.25rem}
.adm-stat{background:#161D2B;border:1px solid rgba(232,236,241,.07);border-radius:.75rem;padding:.875rem 1rem}
.adm-stat b{display:block;font-size:1.5rem;font-weight:700;line-height:1.2}
.adm-stat span{font-size:.75rem;color:#8B97A8;text-transform:uppercase;letter-spacing:.06em}
.adm-panel{background:#161D2B;border:1px solid rgba(232,236,241,.07);border-radius:.75rem;overflow:hidden;margin-bottom:1.25rem}
.adm-panel-head{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.75rem 1rem;border-bottom:1px solid rgba(232,236,241,.07)}
.adm-panel-title{font-weight:600;font-size:.9375rem}
.adm-table-scroll{overflow-x:auto}
.adm-table{width:100%;border-collapse:collapse;font-size:.8125rem;white-space:nowrap}
.adm-table th{position:sticky;top:0;background:#1B2334;color:#8B97A8;font-weight:600;text-align:left;padding:.5rem .75rem;font-size:.6875rem;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;user-select:none}
.adm-table th.nosort{cursor:default}
.adm-table td{padding:.5rem .75rem;border-top:1px solid rgba(232,236,241,.05);vertical-align:top}
.adm-table tbody tr:hover{background:rgba(232,236,241,.03)}
.adm-table tbody tr.click{cursor:pointer}
.adm-badge{display:inline-flex;align-items:center;gap:.25rem;border-radius:9999px;padding:2px 9px;font-size:.6875rem;font-weight:600}
.adm-badge.sub{background:rgba(23,166,115,.16);color:#3ECF9A}
.adm-badge.trial{background:rgba(212,175,55,.16);color:#D4AF37}
.adm-badge.expired{background:rgba(228,87,79,.14);color:#F08A84}
.adm-badge.none{background:rgba(139,151,168,.14);color:#8B97A8}
.adm-input{border-radius:.5rem;border:1px solid rgba(232,236,241,.12);background:#10151F;color:#E8ECF1;padding:.45rem .75rem;font-size:.8125rem;outline:none;min-width:200px}
.adm-input:focus{border-color:rgba(11,110,79,.7)}
.adm-select{border-radius:.5rem;border:1px solid rgba(232,236,241,.12);background:#10151F;color:#E8ECF1;padding:.45rem .6rem;font-size:.8125rem;outline:none}
.adm-btn{display:inline-flex;align-items:center;gap:.4rem;border-radius:.5rem;background:#0B6E4F;color:#FAFAF8;padding:.45rem .9rem;font-size:.8125rem;font-weight:500;border:none;cursor:pointer}
.adm-btn:hover{background:#095a41}
.adm-btn:disabled{opacity:.45;cursor:not-allowed}
.adm-btn.ghost{background:transparent;border:1px solid rgba(232,236,241,.15);color:#B9C2CF}
.adm-btn.ghost:hover{border-color:rgba(232,236,241,.35);background:transparent}
.adm-btn.danger{background:#7E2B26}
.adm-btn.danger:hover{background:#93332d}
.adm-icon-btn{display:inline-flex;align-items:center;justify-content:center;border-radius:.375rem;background:transparent;border:none;color:#8B97A8;padding:.25rem;cursor:pointer}
.adm-icon-btn:hover{color:#F08A84;background:rgba(228,87,79,.12)}
.adm-gate{min-height:100vh;display:grid;place-items:center;padding:2rem;text-align:center}
.adm-gate-card{max-width:26rem;background:#161D2B;border:1px solid rgba(232,236,241,.09);border-radius:1rem;padding:2rem;display:flex;flex-direction:column;align-items:center;gap:.75rem}
.adm-chips{display:flex;flex-wrap:wrap;gap:.5rem}
.adm-chip{background:#1B2334;border:1px solid rgba(232,236,241,.08);border-radius:.5rem;padding:.5rem .75rem;font-size:.75rem;color:#B9C2CF}
.adm-chip b{display:block;font-size:1.125rem;color:#E8ECF1}
.adm-modal{position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:rgba(5,8,14,.7);padding:1rem}
.adm-modal-card{background:#161D2B;border:1px solid rgba(232,236,241,.12);border-radius:.875rem;padding:1.5rem;max-width:24rem;width:100%;display:flex;flex-direction:column;gap:1rem}
.adm-kv{display:grid;grid-template-columns:auto 1fr;gap:.25rem .875rem;font-size:.8125rem}
.adm-kv dt{color:#8B97A8}
.adm-kv dd{margin:0}
.adm-empty{padding:2rem 1rem;text-align:center;color:#8B97A8;font-size:.8125rem}
.adm-manage{border:1px solid rgba(212,175,55,.35);border-radius:.75rem;padding:1rem;margin:1rem;background:rgba(212,175,55,.05)}
.adm-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;color:#B9C2CF}
@media(max-width:640px){.adm-wrap{padding:.75rem .5rem 3rem}.adm-input{min-width:130px}}
`;

/* ------------------------------- tiny pieces ------------------------------ */

function StatusBadge({ status }: { status: SubStatus }) {
  const cls = status === "Subscribed" ? "sub" : status === "Trialing" ? "trial" : status === "Trial expired" ? "expired" : "none";
  return <span className={`adm-badge ${cls}`}>{status}</span>;
}

function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="adm-stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function ConfirmModal({ title, body, confirmLabel, danger, onConfirm, onCancel, busy }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void; busy?: boolean;
}) {
  return (
    <div className="adm-modal" onClick={onCancel}>
      <div className="adm-modal-card" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: ".5rem", fontWeight: 600 }}>
          <AlertTriangle size={18} style={{ color: danger ? "#F08A84" : "#D4AF37" }} />
          {title}
        </div>
        <div style={{ fontSize: ".8125rem", color: "#B9C2CF", lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: "flex", gap: ".5rem", justifyContent: "flex-end" }}>
          <button type="button" className="adm-btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className={`adm-btn ${danger ? "danger" : ""}`} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- subscribers view ---------------------------- */

type SortKey = "email" | "householdName" | "trialStart" | "daysLeft" | "status" | "signup" | "members";

function SubscribersView({ data, onSelect }: { data: CoreData; onSelect: (hid: number) => void }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("signup");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const accounts = useMemo(() => buildAccounts(data), [data]);

  const stats = useMemo(() => {
    const trials = data.trials;
    const subs = trials.filter((t) => !!t.subscribed).length;
    const active = trials.filter((t) => !t.subscribed && trialDaysLeft(t.trial_started_at) > 0).length;
    const expired = trials.filter((t) => !t.subscribed && trialDaysLeft(t.trial_started_at) <= 0).length;
    const conversion = trials.length ? Math.round((subs / trials.length) * 100) : 0;
    return { households: data.households.length, active, expired, subs, conversion };
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    let rows = accounts;
    if (q) {
      rows = rows.filter((r) =>
        r.email.toLowerCase().includes(q) ||
        r.householdName.toLowerCase().includes(q) ||
        r.householdCode.toLowerCase().includes(q) ||
        r.ownerName.toLowerCase().includes(q));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey];
      if (sortKey === "trialStart" || sortKey === "signup") {
        return (new Date(String(av || 0)).getTime() - new Date(String(bv || 0)).getTime()) * dir;
      }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [accounts, query, sortKey, sortDir]);

  const header = (label: string, key: SortKey) => (
    <th onClick={() => {
      if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
      else { setSortKey(key); setSortDir(key === "signup" || key === "trialStart" ? "desc" : "asc"); }
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: ".2rem" }}>
        {label}
        {sortKey === key ? (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
      </span>
    </th>
  );

  return (
    <>
      <div className="adm-stats">
        <StatCard label="Households" value={stats.households} />
        <StatCard label="Active trials" value={stats.active} />
        <StatCard label="Expired trials" value={stats.expired} />
        <StatCard label="Paid subscribers" value={stats.subs} />
        <StatCard label="Trial → paid" value={`${stats.conversion}%`} />
      </div>

      <div className="adm-panel">
        <div className="adm-panel-head">
          <span className="adm-panel-title">Subscribers &amp; trials</span>
          <span className="adm-muted" style={{ fontSize: ".75rem" }}>{filtered.length} account{filtered.length === 1 ? "" : "s"}</span>
          <span style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <Search size={14} style={{ position: "absolute", left: ".55rem", top: "50%", transform: "translateY(-50%)", color: "#8B97A8" }} />
            <input
              className="adm-input"
              style={{ paddingLeft: "1.8rem" }}
              placeholder="Search email, household, code…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="adm-table-scroll">
          <table className="adm-table">
            <thead>
              <tr>
                {header("Email", "email")}
                {header("Household", "householdName")}
                {header("Members", "members")}
                {header("Trial start", "trialStart")}
                {header("Days left", "daysLeft")}
                {header("Status", "status")}
                {header("Signed up", "signup")}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7}><div className="adm-empty">No accounts match{query ? " this search" : " — no signups yet"}.</div></td></tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.key}
                  className={r.householdId != null ? "click" : ""}
                  onClick={() => { if (r.householdId != null) onSelect(r.householdId); }}
                  title={r.householdId != null ? "Open household detail" : "No household record for this account"}
                >
                  <td>{r.email}</td>
                  <td>
                    {r.householdName}
                    {r.householdCode ? <span className="adm-code" style={{ marginLeft: ".4rem" }}>{r.householdCode}</span> : null}
                  </td>
                  <td>{r.members || "—"}</td>
                  <td>{r.trialStart ? fmtDate(r.trialStart) : "—"}</td>
                  <td>{r.trial ? (r.status === "Subscribed" ? "—" : r.daysLeft > 0 ? `${r.daysLeft}d` : "0d") : "—"}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{fmtDate(r.signup)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* --------------------------- household detail ----------------------------- */

const ENGAGEMENT_TABLES: { table: string; label: string }[] = [
  { table: "hh_bills", label: "Bills" },
  { table: "hh_schedule_events", label: "Schedule events" },
  { table: "hh_pantry_items", label: "Pantry items" },
  { table: "hh_shopping_items", label: "Shopping items" },
  { table: "hh_tasks", label: "Chores / tasks" },
  { table: "hh_meal_plans", label: "Meal plans" },
  { table: "hh_maintenance_tasks", label: "Maintenance" },
  { table: "hh_budgets", label: "Budget categories" },
];

function HouseholdDetail({ householdId, data, onBack, refreshCore }: {
  householdId: number; data: CoreData; onBack: () => void; refreshCore: () => void;
}) {
  const hh = data.households.find((h) => Number(h.id) === householdId);
  const members = data.memberships.filter((m) => Number(m.household_id) === householdId);
  const memberSessions = members.map((m) => m.account_session_id).filter(Boolean) as string[];
  // Household-keyed trial rows first (current model), then legacy session-linked ones.
  const hhKeyedTrials = data.trials.filter((t) => t.household_id != null && Number(t.household_id) === householdId);
  const sessionTrials = data.trials.filter((t) => t.session_id && memberSessions.includes(String(t.session_id)));
  const linkedTrials = [...hhKeyedTrials, ...sessionTrials.filter((t) => !hhKeyedTrials.some((k) => Number(k.id) === Number(t.id)))];
  const subscribed = linkedTrials.some((t) => !!t.subscribed);
  const settings = data.settings.find((s) => Number(s.household_id) === householdId);
  const currency: Currency = settings?.currency_code
    ? { code: String(settings.currency_code), symbol: String(settings.currency_symbol || settings.currency_code) }
    : DEFAULT_CURRENCY;

  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [confirm, setConfirm] = useState<null | { toSubscribed: boolean }>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.all(ENGAGEMENT_TABLES.map(async ({ table }) => {
        const rows = await fetchAll(table, householdId);
        return [table, rows.length] as const;
      }));
      if (!cancelled) setCounts(Object.fromEntries(results));
    })();
    return () => { cancelled = true; };
  }, [householdId]);

  const applySubscription = async (toSubscribed: boolean) => {
    setBusy(true);
    setNotice("");
    try {
      for (const t of linkedTrials) {
        await sdb("trial_status").update(Number(t.id), { subscribed: toSubscribed });
      }
      setNotice(toSubscribed ? "Marked as subscribed." : "Marked as not subscribed.");
      refreshCore();
    } catch (err) {
      console.error("[AdminPortal] subscription update failed", err);
      setNotice("Update failed — see console.");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (!hh) {
    return (
      <div className="adm-panel"><div className="adm-empty">Household not found (it may have been deleted). <button type="button" className="adm-btn ghost" onClick={onBack}>Back</button></div></div>
    );
  }

  const ownerTrial = linkedTrials[0] || null;
  const status = statusOf(ownerTrial, subscribed);
  const budget = Number(hh.monthly_food_budget_ngn || 0);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: ".75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <button type="button" className="adm-btn ghost" onClick={onBack}><ArrowLeft size={14} /> All subscribers</button>
        <h2 className="adm-display" style={{ fontSize: "1.375rem", margin: 0 }}>{String(hh.name)}</h2>
        <StatusBadge status={status} />
      </div>

      <div className="adm-panel">
        <div className="adm-panel-head"><span className="adm-panel-title">Overview</span></div>
        <div style={{ padding: "1rem" }}>
          <dl className="adm-kv">
            <dt>Join code</dt><dd className="adm-code">{String(hh.household_code || "—")}</dd>
            <dt>Owner</dt><dd>{String(hh.owner_name || "—")} · {String(hh.owner_email || "—")}</dd>
            <dt>Family size</dt><dd>{hh.family_size ?? "—"} ({hh.adults ?? 0} adults, {hh.children ?? 0} children)</dd>
            <dt>Country / currency</dt><dd>{String(settings?.country || "—")} · {currency.code} ({currency.symbol.trim()})</dd>
            <dt>Food budget</dt><dd>{budget ? `${currency.symbol}${budget.toLocaleString()}/mo` : "—"}</dd>
            <dt>Timezone</dt><dd>{String(hh.timezone || "—")}</dd>
            <dt>Onboarded</dt><dd>{hh.onboarded ? "Yes" : "No"}</dd>
            <dt>Created</dt><dd>{fmtDateTime(hh.created_at)}</dd>
            <dt>Trial started</dt><dd>{ownerTrial ? `${fmtDateTime(ownerTrial.trial_started_at)} (${subscribed ? "subscribed" : trialDaysLeft(ownerTrial.trial_started_at) > 0 ? `${trialDaysLeft(ownerTrial.trial_started_at)}d left` : "expired"})` : "No trial record linked"}</dd>
          </dl>
        </div>
      </div>

      <div className="adm-panel">
        <div className="adm-panel-head"><Users size={15} /><span className="adm-panel-title">Members ({members.length})</span></div>
        <div className="adm-table-scroll">
          <table className="adm-table">
            <thead><tr><th className="nosort">Name</th><th className="nosort">Email</th><th className="nosort">Role</th><th className="nosort">Status</th><th className="nosort">Joined</th></tr></thead>
            <tbody>
              {members.length === 0 && <tr><td colSpan={5}><div className="adm-empty">No members recorded for this household.</div></td></tr>}
              {members.map((m) => (
                <tr key={String(m.id)}>
                  <td>{m.role === "owner" ? <span style={{ display: "inline-flex", alignItems: "center", gap: ".3rem" }}><Crown size={12} style={{ color: "#D4AF37" }} />{String(m.name)}</span> : String(m.name)}</td>
                  <td>{String(m.email || "—")}</td>
                  <td>{String(m.role)}</td>
                  <td>{String(m.status)}</td>
                  <td>{fmtDate(m.joined_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="adm-panel">
        <div className="adm-panel-head"><Database size={15} /><span className="adm-panel-title">Data volume (engagement)</span></div>
        <div style={{ padding: "1rem" }}>
          {counts === null ? (
            <span className="adm-muted" style={{ fontSize: ".8125rem" }}>Counting…</span>
          ) : (
            <div className="adm-chips">
              {ENGAGEMENT_TABLES.map(({ table, label }) => (
                <div key={table} className="adm-chip"><b>{counts[table] ?? 0}</b>{label}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="adm-manage">
        <div style={{ display: "flex", alignItems: "center", gap: ".5rem", fontWeight: 600, marginBottom: ".5rem" }}>
          <Shield size={15} style={{ color: "#D4AF37" }} /> Management actions
        </div>
        <p className="adm-muted" style={{ fontSize: ".8125rem", margin: "0 0 .75rem" }}>
          Manually flips <code className="adm-code">trial_status.subscribed</code> for every account in this household
          ({linkedTrials.length} linked trial record{linkedTrials.length === 1 ? "" : "s"}).
        </p>
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" }}>
          {subscribed ? (
            <button type="button" className="adm-btn danger" disabled={busy || linkedTrials.length === 0} onClick={() => setConfirm({ toSubscribed: false })}>
              <XCircle size={14} /> Mark as NOT subscribed
            </button>
          ) : (
            <button type="button" className="adm-btn" disabled={busy || linkedTrials.length === 0} onClick={() => setConfirm({ toSubscribed: true })}>
              <CheckCircle2 size={14} /> Mark as subscribed
            </button>
          )}
          {linkedTrials.length === 0 && <span className="adm-muted" style={{ fontSize: ".75rem" }}>No trial record is linked to this household's member accounts yet.</span>}
          {notice && <span style={{ fontSize: ".8125rem", color: "#3ECF9A" }}>{notice}</span>}
        </div>
      </div>

      {confirm && (
        <ConfirmModal
          title={confirm.toSubscribed ? "Mark household as subscribed?" : "Remove subscribed status?"}
          body={<>This updates <b>{linkedTrials.length}</b> trial record{linkedTrials.length === 1 ? "" : "s"} for <b>{String(hh.name)}</b>. {confirm.toSubscribed ? "Members will be treated as paid subscribers." : "Members will fall back to the normal 7-day trial rules (possibly hitting the paywall immediately)."}</>}
          confirmLabel={confirm.toSubscribed ? "Mark subscribed" : "Remove subscription"}
          danger={!confirm.toSubscribed}
          busy={busy}
          onConfirm={() => void applySubscription(confirm.toSubscribed)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

/* ------------------------------- data browser ------------------------------ */

interface BrowserTable { id: string; label: string; scope: "household" | "session" | "root" }

const BROWSER_TABLES: BrowserTable[] = [
  { id: "hh_bills", label: "Bills", scope: "household" },
  { id: "hh_schedule_events", label: "Schedule", scope: "household" },
  { id: "hh_pantry_items", label: "Pantry", scope: "household" },
  { id: "hh_shopping_items", label: "Shopping", scope: "household" },
  { id: "hh_budgets", label: "Budgets", scope: "household" },
  { id: "hh_maintenance_tasks", label: "Maintenance", scope: "household" },
  { id: "hh_meal_plans", label: "Meal plans", scope: "household" },
  { id: "hh_tasks", label: "Tasks", scope: "household" },
  { id: "household_entries", label: "Log entries", scope: "session" },
  { id: "daily_briefings", label: "Briefings", scope: "session" },
  { id: "chat_threads", label: "Chat threads", scope: "session" },
  { id: "chat_messages", label: "Chat messages", scope: "session" },
  { id: "households", label: "Households (core)", scope: "root" },
  { id: "household_memberships", label: "Memberships (core)", scope: "household" },
  { id: "household_settings", label: "Household settings (core)", scope: "household" },
  { id: "trial_status", label: "Trial records (core)", scope: "session" },
];

// Deleting from these tables changes the Subscribers view — reload core data after.
const CORE_TABLES = new Set(["households", "household_memberships", "household_settings", "trial_status"]);

const HIDDEN_COLS = new Set(["updated_at"]);

function cellValue(col: string, value: unknown, currency: Currency): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="adm-muted">—</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (MONEY_COLS.has(col)) return `${currency.symbol}${Number(value).toLocaleString()}`;
  if (col === "session_id" || col === "target_session_id" || col === "account_session_id") {
    const s = String(value);
    return <span className="adm-code" title={s}>{s.length > 16 ? `${s.slice(0, 16)}…` : s}</span>;
  }
  if (col === "created_at" || col.endsWith("_at")) return fmtDateTime(value);
  if (col.endsWith("_date") || col === "date" || col === "month") return fmtDate(value);
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return <span className="adm-code" title={s}>{s.length > 60 ? `${s.slice(0, 60)}…` : s}</span>;
  }
  const s = String(value);
  return <span title={s}>{s.length > 90 ? `${s.slice(0, 90)}…` : s}</span>;
}

function DataBrowser({ data, onCoreChanged }: { data: CoreData; onCoreChanged: () => void }) {
  const [tableId, setTableId] = useState<string>(BROWSER_TABLES[0].id);
  const [hid, setHid] = useState<number | "all">("all");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const table = BROWSER_TABLES.find((t) => t.id === tableId) || BROWSER_TABLES[0];

  const currencyFor = useCallback((row: Row): Currency => {
    const rowHid = row.household_id != null ? Number(row.household_id) : (hid !== "all" ? hid : null);
    if (rowHid != null) {
      const s = data.settings.find((x) => Number(x.household_id) === rowHid);
      if (s?.currency_code) return { code: String(s.currency_code), symbol: String(s.currency_symbol || s.currency_code) };
    }
    return DEFAULT_CURRENCY;
  }, [data.settings, hid]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    (async () => {
      let fetched: Row[];
      if (table.scope === "household" && hid !== "all") {
        fetched = await fetchAll(table.id, hid);
      } else {
        fetched = await fetchAll(table.id);
        if (table.scope === "root" && hid !== "all") {
          fetched = fetched.filter((r) => Number(r.id) === hid);
        }
        if (table.scope === "session" && hid !== "all") {
          const sessions = data.memberships
            .filter((m) => Number(m.household_id) === hid && m.account_session_id)
            .map((m) => String(m.account_session_id));
          fetched = fetched.filter((r) =>
            (r.session_id && sessions.includes(String(r.session_id))) ||
            (r.target_session_id && sessions.includes(String(r.target_session_id))));
        }
      }
      if (!cancelled) setRows(fetched);
    })();
    return () => { cancelled = true; };
  }, [table, hid, data.memberships, reloadTick]);

  const columns = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    const keys = new Set<string>();
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (!HIDDEN_COLS.has(k)) keys.add(k); }));
    const ordered = [...keys];
    ordered.sort((a, b) => {
      const rank = (k: string) => (k === "id" ? 0 : k === "session_id" ? 90 : k === "created_at" ? 91 : 10);
      return rank(a) - rank(b);
    });
    return ordered;
  }, [rows]);

  const doDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await sdb(table.id).delete(Number(pendingDelete.id));
      setReloadTick((n) => n + 1);
      if (CORE_TABLES.has(table.id)) onCoreChanged();
    } catch (err) {
      console.error("[AdminPortal] delete failed", err);
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  };

  return (
    <>
      <div className="adm-panel">
        <div className="adm-panel-head">
          <Database size={15} />
          <span className="adm-panel-title">App data browser</span>
          <span style={{ flex: 1 }} />
          <select className="adm-select" value={tableId} onChange={(e) => setTableId(e.target.value)}>
            {BROWSER_TABLES.map((t) => <option key={t.id} value={t.id}>{t.label} ({t.id})</option>)}
          </select>
          <select className="adm-select" value={String(hid)} onChange={(e) => setHid(e.target.value === "all" ? "all" : Number(e.target.value))}>
            <option value="all">All households</option>
            {data.households.map((h) => <option key={String(h.id)} value={String(h.id)}>{String(h.name)}</option>)}
          </select>
        </div>

        {rows === null ? (
          <div className="adm-empty">Loading {table.label.toLowerCase()}…</div>
        ) : rows.length === 0 ? (
          <div className="adm-empty">No rows in <code className="adm-code">{table.id}</code>{hid !== "all" ? " for this household" : ""}.</div>
        ) : (
          <div className="adm-table-scroll" style={{ maxHeight: "32rem", overflowY: "auto" }}>
            <table className="adm-table">
              <thead>
                <tr>
                  {columns.map((c) => <th key={c} className="nosort">{c}</th>)}
                  <th className="nosort" style={{ width: "2rem" }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    {columns.map((c) => <td key={c}>{cellValue(c, r[c], currencyFor(r))}</td>)}
                    <td>
                      <button type="button" className="adm-icon-btn" title="Delete row" onClick={() => setPendingDelete(r)}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ padding: ".5rem 1rem", borderTop: "1px solid rgba(232,236,241,.07)", fontSize: ".6875rem" }} className="adm-muted">
          Read-only view — the trash icon permanently deletes a single row (for cleaning up bad/test data) and always asks for confirmation first.
        </div>
      </div>

      {pendingDelete && (
        <ConfirmModal
          title={`Delete row #${String(pendingDelete.id)}?`}
          body={<>This permanently deletes row <b>#{String(pendingDelete.id)}</b> from <code className="adm-code">{table.id}</code>. This cannot be undone.</>}
          confirmLabel="Delete row"
          danger
          busy={busy}
          onConfirm={() => void doDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}

/* ------------------------------ support inbox ------------------------------ */

/** Complaints sent from the customer app's Support section (support_tickets). */
function SupportInbox({ data }: { data: CoreData }) {
  const [tickets, setTickets] = useState<Row[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"open" | "resolved" | "all">("open");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTickets(null);
    (async () => {
      const rows = await fetchAll("support_tickets");
      rows.sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime());
      if (!cancelled) setTickets(rows);
    })();
    return () => { cancelled = true; };
  }, [reloadTick]);

  const isResolved = (t: Row) => String(t.status || "open") === "resolved";
  const openCount = (tickets ?? []).filter((t) => !isResolved(t)).length;
  const resolvedCount = (tickets ?? []).length - openCount;
  const shown = (tickets ?? []).filter((t) => statusFilter === "all" ? true : statusFilter === "open" ? !isResolved(t) : isResolved(t));

  const hhName = (hid: unknown) => {
    if (hid == null) return "—";
    const h = data.households.find((x) => Number(x.id) === Number(hid));
    return h ? String(h.name) : `Household #${String(hid)}`;
  };

  const setStatus = async (t: Row, status: "open" | "resolved") => {
    if (busyId) return;
    setBusyId(Number(t.id));
    try {
      await sdb("support_tickets").update(Number(t.id), { status });
      setReloadTick((n) => n + 1);
    } catch (err) {
      console.error("[AdminPortal] Ticket update failed:", err);
    } finally { setBusyId(null); }
  };

  return (
    <>
      <div className="adm-stats">
        <StatCard label="Open tickets" value={tickets === null ? "…" : openCount} />
        <StatCard label="Resolved" value={tickets === null ? "…" : resolvedCount} />
        <StatCard label="Total" value={tickets === null ? "…" : (tickets ?? []).length} />
      </div>

      <div className="adm-panel">
        <div className="adm-panel-head">
          <LifeBuoy size={15} />
          <span className="adm-panel-title">Support inbox</span>
          <span className="adm-muted" style={{ fontSize: ".75rem" }}>complaints sent from the app's Support section</span>
          <span style={{ flex: 1 }} />
          <select className="adm-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "open" | "resolved" | "all")}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </div>

        {tickets === null ? (
          <div className="adm-empty">Loading support tickets…</div>
        ) : shown.length === 0 ? (
          <div className="adm-empty">{statusFilter === "open" ? "No open tickets — inbox zero." : "No tickets here."}</div>
        ) : (
          <div style={{ display: "grid", gap: ".75rem", padding: "1rem" }}>
            {shown.map((t) => {
              const resolved = isResolved(t);
              return (
                <div key={String(t.id)} style={{ border: "1px solid rgba(232,236,241,.09)", borderRadius: ".625rem", padding: ".75rem .875rem", background: resolved ? "transparent" : "rgba(212,175,55,.04)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                    <span className={`adm-badge ${resolved ? "sub" : "trial"}`}>{resolved ? "Resolved" : "Open"}</span>
                    <span className="adm-badge none" style={{ textTransform: "capitalize" }}>{String(t.category || "other")}</span>
                    <span style={{ fontSize: ".8125rem", fontWeight: 600 }}>{String(t.member_name || "Unknown member")}</span>
                    <span className="adm-muted" style={{ fontSize: ".75rem" }}>{String(t.member_email || "no email")} · {hhName(t.household_id)}</span>
                    <span className="adm-muted" style={{ fontSize: ".75rem", marginLeft: "auto" }}>{fmtDateTime(t.created_at)}</span>
                  </div>
                  {t.subject ? <p style={{ fontSize: ".875rem", fontWeight: 600, margin: ".5rem 0 0" }}>{String(t.subject)}</p> : null}
                  <p style={{ fontSize: ".8125rem", margin: ".375rem 0 .625rem", whiteSpace: "pre-wrap", color: "#B9C2CF" }}>{String(t.message)}</p>
                  {resolved ? (
                    <button type="button" className="adm-btn ghost" disabled={busyId === Number(t.id)} onClick={() => void setStatus(t, "open")}>
                      <RefreshCw size={13} /> Reopen
                    </button>
                  ) : (
                    <button type="button" className="adm-btn" disabled={busyId === Number(t.id)} onClick={() => void setStatus(t, "resolved")}>
                      <CheckCircle2 size={13} /> {busyId === Number(t.id) ? "Saving…" : "Mark resolved"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/* --------------------------------- shell ----------------------------------- */

type AdminView = "subscribers" | "data" | "support";

function AdminShell({ email }: { email: string }) {
  const [view, setView] = useState<AdminView>("subscribers");
  const [selectedHousehold, setSelectedHousehold] = useState<number | null>(null);
  const [core, setCore] = useState<CoreData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [households, memberships, trials, profiles, settings] = await Promise.all([
      fetchAll("households"),
      fetchAll("household_memberships"),
      fetchAll("trial_status"),
      fetchAll("profiles"),
      fetchAll("household_settings"),
    ]);
    setCore({ households, memberships, trials, profiles, settings });
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="adm-wrap">
      <div className="adm-header">
        <Shield size={22} style={{ color: "#D4AF37" }} />
        <div>
          <h1 className="adm-display" style={{ fontSize: "1.5rem", margin: 0 }}>OziUno Admin</h1>
          <div className="adm-muted" style={{ fontSize: ".75rem" }}>Signed in as {email} · internal use only</div>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="adm-btn ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="adm-tabs">
        <button type="button" className={`adm-tab ${view === "subscribers" ? "active" : ""}`} onClick={() => { setView("subscribers"); setSelectedHousehold(null); }}>
          <LayoutDashboard size={14} /> Subscribers &amp; trials
        </button>
        <button type="button" className={`adm-tab ${view === "data" ? "active" : ""}`} onClick={() => setView("data")}>
          <Database size={14} /> Data browser
        </button>
        <button type="button" className={`adm-tab ${view === "support" ? "active" : ""}`} onClick={() => setView("support")}>
          <LifeBuoy size={14} /> Support
        </button>
      </div>

      {loading || !core ? (
        <div className="adm-panel"><div className="adm-empty">Loading live workspace data…</div></div>
      ) : view === "data" ? (
        <DataBrowser data={core} onCoreChanged={() => void load(true)} />
      ) : view === "support" ? (
        <SupportInbox data={core} />
      ) : selectedHousehold != null ? (
        <HouseholdDetail householdId={selectedHousehold} data={core} onBack={() => setSelectedHousehold(null)} refreshCore={() => void load()} />
      ) : (
        <SubscribersView data={core} onSelect={(hid) => setSelectedHousehold(hid)} />
      )}
    </div>
  );
}

/* ------------------------------- entry / gate ------------------------------ */

export default function AdminPortalApp() {
  const [account, setAccount] = useState(() => getAccount());

  // Re-check if the user signs in/out in another tab or the gate finishes late.
  useEffect(() => {
    const recheck = () => setAccount(getAccount());
    window.addEventListener("storage", recheck);
    window.addEventListener("audos:session-established" as any, recheck);
    return () => {
      window.removeEventListener("storage", recheck);
      window.removeEventListener("audos:session-established" as any, recheck);
    };
  }, []);

  const admin = isAdminEmail(account.email);

  return (
    <div className="adm-root">
      <style>{ADM_CSS}</style>
      {!account.email ? (
        <div className="adm-gate">
          <div className="adm-gate-card">
            <Lock size={28} style={{ color: "#8B97A8" }} />
            <h1 className="adm-display" style={{ fontSize: "1.375rem", margin: 0 }}>Sign in required</h1>
            <p className="adm-muted" style={{ fontSize: ".875rem", margin: 0 }}>
              The admin portal needs your OziUno sign-in. Please sign in with your email first, then reopen this app.
            </p>
          </div>
        </div>
      ) : !admin ? (
        <div className="adm-gate">
          <div className="adm-gate-card">
            <Shield size={28} style={{ color: "#F08A84" }} />
            <h1 className="adm-display" style={{ fontSize: "1.375rem", margin: 0 }}>Access restricted</h1>
            <p className="adm-muted" style={{ fontSize: ".875rem", margin: 0 }}>
              This area is for the OziUno team only. Your account (<b style={{ color: "#E8ECF1" }}>{account.email}</b>) doesn't have admin access.
            </p>
            <p className="adm-muted" style={{ fontSize: ".8125rem", margin: 0 }}>
              Looking for your household? Open the OziUno app from the dock instead.
            </p>
          </div>
        </div>
      ) : (
        <AdminShell email={account.email} />
      )}
    </div>
  );
}
