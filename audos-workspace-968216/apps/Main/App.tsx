import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Home, MessageCircle, Package, ShoppingCart, Calendar, Receipt, ChefHat, Wrench,
  PieChart, Users, CheckSquare, Menu, Plus, Trash2, Sparkles, Mic,
  Recycle, Leaf, AlertTriangle, PiggyBank,
  ArrowRight, ArrowUp, Check, User, Copy, Mail, QrCode, KeyRound, Crown, UserPlus, Globe,
  Square, Volume2, VolumeX, RefreshCw, X, Pencil, CreditCard, LifeBuoy,
} from "lucide-react";
import QRCode from "react-qr-code";
import { VoiceAssistant, runOziAgentTurn, voiceEngine, type VoiceMemberCtx } from "./voice";
import {
  normalizeUnit, convertUnits, defaultUnitFor, ingredientKeyOf, normalizeQuantityInput, packageExpansion,
  computeItemStates, committedByItem, householdServings, scaleIngredientQty,
  shoppingRequirement, recommendPackage, shoppingReason, postTxn, confirmMealOutcome,
  recordWaste, recordOpeningBalances, sanitizeIngredient, matchInventoryItem, inferLegacyUnit,
  ledgerToUsage, weeklyConsumption, estimateWeeksRemaining, LEFTOVER_USE_BY_DAYS,
  DEFAULT_RECIPE_YIELD, INV_STATE_LABELS, TXN_LABELS, CANONICAL_UNITS, roundQty,
  type InvState, type ItemStates, type TxnType,
} from "./inventory-engine";

declare global {
  interface Window {
    useWorkspaceDB: <T = Record<string, unknown>>(
      table: string,
      options?: {
        shared?: boolean;
        limit?: number;
        offset?: number;
        orderBy?: { column: string; direction: "asc" | "desc" };
        filters?: Array<{ column: string; operator: string; value: unknown }>;
      }
    ) => { data: T[]; loading: boolean; error: Error | null; total: number; refresh: () => void };
    __workspaceDb: {
      from: (table: string, opts?: { shared?: boolean }) => {
        eq: (col: string, val: unknown) => ReturnType<Window["__workspaceDb"]["from"]>;
        gte: (col: string, val: unknown) => ReturnType<Window["__workspaceDb"]["from"]>;
        lte: (col: string, val: unknown) => ReturnType<Window["__workspaceDb"]["from"]>;
        // NOTE: the injected SDK has NO .is() filter (only eq/neq/gt/gte/lt/lte/like/ilike) —
        // null checks must be done client-side after .get().
        orderBy: (col: string, dir?: "asc" | "desc") => ReturnType<Window["__workspaceDb"]["from"]>;
        limit: (n: number) => ReturnType<Window["__workspaceDb"]["from"]>;
        get: () => Promise<{ data: Record<string, unknown>[]; total?: number }>;
        insert: (row: Record<string, unknown>) => Promise<unknown>;
        bulkInsert: (rows: Record<string, unknown>[]) => Promise<unknown>;
        update: (id: number, row: Record<string, unknown>) => Promise<unknown>;
        delete: (id: number) => Promise<unknown>;
      };
    };
  }
}

/* ---------------------------------------------------------------------------
 * OziUno — household-centric model.
 *
 * OZIUNO
 * │
 * HOUSEHOLD (households table)
 * │
 * ├── Members (household_memberships): each person signs in with their OWN
 * │   email (existing Audos email gate = individual account), and a membership
 * │   row links that account to ONE household with a role.
 * │
 * ├── SHARED DATA (hh_* tables, filtered by household_id, read with
 * │   { shared: true }): pantry, shopping, schedule, bills, budgets,
 * │   maintenance, meal plans, tasks.
 * └── PERSONAL DATA: chat threads/messages stay session-scoped (private per
 *     member); tasks may be marked visibility="personal".
 * ------------------------------------------------------------------------- */

const VIEWS = ["dashboard","onboarding","chat","meals","pantry","shopping","wasteless","schedule","tasks","maintenance","bills","budget","billing","support","family"] as const;
type View = (typeof VIEWS)[number];

type Role = "owner" | "adult" | "teen" | "child" | "guest" | "caregiver";

const ROLE_LABELS: Record<Role, string> = {
  owner: "Household Owner", adult: "Adult", teen: "Teen", child: "Child", guest: "Guest", caregiver: "Caregiver",
};

const ASSIGNABLE_ROLES: Role[] = ["adult", "teen", "child", "guest", "caregiver"];

const ALL_MEMBER_VIEWS: View[] = ["dashboard","chat","meals","pantry","shopping","wasteless","schedule","tasks","maintenance","bills","budget","billing","support","family"];

// Which app sections each role can open. Owner/Adult: everything. Teen &
// Caregiver: day-to-day features, no money. Child: their own world. Guest:
// look, don't run the house.
const ROLE_VIEWS: Record<Role, View[]> = {
  owner: ALL_MEMBER_VIEWS,
  adult: ALL_MEMBER_VIEWS,
  caregiver: ["dashboard","chat","meals","pantry","shopping","wasteless","schedule","tasks","maintenance","support","family"],
  teen: ["dashboard","chat","meals","pantry","shopping","wasteless","schedule","tasks","support","family"],
  child: ["dashboard","chat","meals","schedule","tasks","support","family"],
  guest: ["dashboard","chat","meals","schedule","support","family"],
};

function canSee(role: Role, view: View): boolean {
  if (view === "onboarding") return role === "owner";
  return (ROLE_VIEWS[role] || ROLE_VIEWS.guest).includes(view);
}

const NAV: { label: string; view: View; icon: typeof Home }[] = [
  { label: "Home", view: "dashboard", icon: Home },
  { label: "Chat", view: "chat", icon: MessageCircle },
  { label: "Meals", view: "meals", icon: ChefHat },
  { label: "Inventory", view: "pantry", icon: Package },
  { label: "Shopping", view: "shopping", icon: ShoppingCart },
  { label: "WasteLess", view: "wasteless", icon: Recycle },
  { label: "Schedule", view: "schedule", icon: Calendar },
  { label: "Tasks", view: "tasks", icon: CheckSquare },
  { label: "Maintenance", view: "maintenance", icon: Wrench },
  { label: "Bills", view: "bills", icon: Receipt },
  { label: "Budget", view: "budget", icon: PieChart },
  { label: "Billing", view: "billing", icon: CreditCard },
  { label: "Support", view: "support", icon: LifeBuoy },
  { label: "Family", view: "family", icon: Users },
];

const BUDGET_COLORS = ["#0d9488","#0ea5e9","#2dd4bf","#6366f1","#64748b"];

// Load brand fonts via a <link> in parallel with everything else — a CSS
// @import inside a <style> tag is fetched serially and delays the first paint.
// The shell already preconnects to fonts.googleapis.com, so this is fast, and
// display=swap means text renders immediately in a fallback font.
try {
  if (typeof document !== "undefined" && !document.getElementById("ozi-fonts")) {
    const fontLink = document.createElement("link");
    fontLink.id = "ozi-fonts";
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap";
    document.head.appendChild(fontLink);
  }
} catch { /* document unavailable */ }

const OZI_CSS = `
.ozi-root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f6f8fb;color:#0f1b2d;min-height:100vh;-webkit-font-smoothing:antialiased}
.ozi-display{font-family:"Instrument Serif",Inter,serif;letter-spacing:-0.015em}
.ozi-muted{color:#5b6b81}
.ozi-primary{background:linear-gradient(135deg,#5eead4,#22d3ee);color:#04201c}
.ozi-accent{color:#0d9488}
.ozi-card{background:#ffffff;border-radius:1.25rem;padding:1.25rem;border:1px solid rgba(15,27,45,.06);box-shadow:0 12px 32px rgba(15,27,45,.05)}
.ozi-input{width:100%;border-radius:.875rem;border:1px solid rgba(15,27,45,.12);background:#f8fafc;padding:.75rem 1rem;font-size:.875rem;outline:none}
.ozi-input:focus{border-color:rgba(45,212,191,.55);box-shadow:0 0 0 3px rgba(45,212,191,.14)}
.ozi-btn{display:inline-flex;align-items:center;gap:.5rem;border-radius:9999px;background:linear-gradient(135deg,#5eead4,#22d3ee);color:#04201c;padding:.5rem 1rem;font-size:.875rem;font-weight:700;border:none;cursor:pointer;box-shadow:0 8px 22px rgba(45,212,191,.22);transition:transform .2s ease,box-shadow .2s ease}
.ozi-btn:hover{transform:translateY(-1px);box-shadow:0 12px 28px rgba(45,212,191,.3)}
.ozi-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.ozi-btn-ghost{background:transparent;color:#3b4d63;border:1px solid rgba(15,27,45,.14);box-shadow:none;font-weight:600}
.ozi-btn-ghost:hover{background:rgba(15,27,45,.04);transform:none;box-shadow:none}
.ozi-sidebar{position:fixed;inset:0 auto 0 0;width:14rem;border-right:1px solid rgba(15,27,45,.08);background:#ffffff;display:none;flex-direction:column;z-index:40}
.ozi-main{padding-top:3.5rem}
@media(min-width:1024px){.ozi-sidebar{display:flex}.ozi-main{margin-left:14rem;padding-top:0}.ozi-mobile-header{display:none!important}}
.ozi-mobile-header{position:sticky;top:0;z-index:40;display:flex;height:3.5rem;align-items:center;gap:.75rem;border-bottom:1px solid rgba(15,27,45,.08);background:rgba(255,255,255,.85);backdrop-filter:blur(12px);padding:0 1rem}
.ozi-nav-item{display:flex;align-items:center;gap:.75rem;border-radius:.625rem;padding:.5rem .75rem;font-size:.875rem;color:#3b4d63;text-decoration:none;cursor:pointer;border:none;background:transparent;width:100%;text-align:left}
.ozi-nav-item.active{background:rgba(45,212,191,.16);color:#0f766e;font-weight:600}
.ozi-nav-item:hover:not(.active){background:rgba(45,212,191,.08)}
.ozi-grid{display:grid;gap:1rem}
.ozi-grid-3{grid-template-columns:1fr}
@media(min-width:768px){.ozi-grid-3{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1024px){.ozi-grid-3{grid-template-columns:repeat(3,1fr)}}
.ozi-hero-dark{background:#1A2E28;color:#f5f3ee;border-radius:1rem;padding:1.5rem}
.ozi-progress{height:.5rem;border-radius:9999px;background:#e2e8f0;overflow:hidden}
.ozi-progress>span{display:block;height:100%;background:linear-gradient(90deg,#2dd4bf,#22d3ee);border-radius:9999px;transition:width .3s}
.ozi-progress.over>span{background:#dc2626}
.ozi-drawer{position:fixed;inset:0;z-index:50}
.ozi-drawer-bg{position:absolute;inset:0;background:rgba(15,27,45,.4)}
.ozi-drawer-panel{position:absolute;inset:0 auto 0 0;width:16rem;background:#ffffff;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(15,27,45,.15)}
.ozi-chat-layout{display:flex;min-height:calc(100vh - 3.5rem);max-width:1280px;margin:0 auto}
@media(min-width:1024px){.ozi-chat-layout{min-height:100vh}}
.ozi-chat-sidebar{width:16rem;border-right:1px solid rgba(15,27,45,.08);display:none;flex-shrink:0}
@media(min-width:768px){.ozi-chat-sidebar{display:block}}
.ozi-msg-user{background:#0d9488;color:#f8fafc;border-radius:1rem;border-top-right-radius:.25rem;padding:.625rem 1rem;font-size:.875rem;max-width:80%}
.ozi-msg-ai{font-size:.9375rem;line-height:1.6;max-width:85%;white-space:pre-wrap}
.ozi-tooltip-wrap{position:relative;display:inline-block}
.ozi-tooltip-wrap:hover .ozi-tooltip{display:block}
.ozi-tooltip{display:none;position:absolute;bottom:calc(100% + 6px);right:0;background:#0f1b2d;color:#f8fafc;font-size:.6875rem;padding:.375rem .5rem;border-radius:.375rem;white-space:nowrap;z-index:10}
.ozi-paywall{position:fixed;inset:0;z-index:100;background:#f6f8fb;color:#0f1b2d;overflow-y:auto;display:grid;place-items:center;padding:2.5rem 1.25rem}
.ozi-paywall-card{background:#ffffff;border:1px solid rgba(15,27,45,.08);border-radius:1.375rem;padding:1.5rem;text-align:left;display:flex;flex-direction:column;gap:.375rem;box-shadow:0 12px 32px rgba(15,27,45,.05)}
.ozi-paywall-card.featured{background:linear-gradient(160deg,#f0fdfa,#f0f9ff);border-color:rgba(45,212,191,.5);box-shadow:0 22px 60px rgba(45,212,191,.14)}
.ozi-paywall-badge{align-self:flex-start;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;background:linear-gradient(135deg,#5eead4,#22d3ee);color:#04201c;border-radius:9999px;padding:3px 10px;margin-bottom:.25rem}
.ozi-paywall-btn{margin-top:.75rem;border-radius:9999px;border:none;padding:.625rem 1rem;font-size:.875rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:.5rem}
.ozi-paywall-btn:disabled{cursor:wait;opacity:.55}
.ozi-role-badge{display:inline-flex;align-items:center;gap:.25rem;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;background:rgba(45,212,191,.14);color:#0f766e;border-radius:9999px;padding:2px 8px}
.ozi-role-badge.owner{background:rgba(56,189,248,.18);color:#0369a1}
.ozi-code-chip{display:inline-flex;align-items:center;gap:.5rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.125rem;font-weight:600;letter-spacing:.08em;background:#f8fafc;border:1px dashed rgba(13,148,136,.4);border-radius:.75rem;padding:.625rem 1rem;color:#0d9488}
.ozi-choice-card{background:#ffffff;border-radius:1.25rem;padding:1.5rem;border:1px solid rgba(15,27,45,.06);box-shadow:0 12px 32px rgba(15,27,45,.05);text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:.5rem;transition:box-shadow .15s,transform .15s}
.ozi-choice-card:hover{box-shadow:0 0 0 2px rgba(45,212,191,.45),0 12px 32px rgba(15,27,45,.06);transform:translateY(-2px)}
.ozi-option-card{background:#f8fafc;border:1px solid rgba(15,27,45,.1);border-radius:1rem;padding:1rem;display:flex;flex-direction:column;gap:.5rem}
.ozi-rec{animation:oziPulse 1.2s ease-in-out infinite}
@keyframes oziPulse{0%,100%{opacity:1}50%{opacity:.55}}
`;

/* ------------------------------- utilities ------------------------------- */

function parseNav() {
  const p = new URLSearchParams(window.location.search);
  const view = (p.get("view") || "dashboard") as View;
  const threadId = p.get("threadId");
  return { view: VIEWS.includes(view) ? view : "dashboard", threadId: threadId ? Number(threadId) : null };
}

function parseJoinCodeFromUrl(): string {
  const p = new URLSearchParams(window.location.search);
  return (p.get("join") || "").toUpperCase().trim();
}

function monthKey(d = new Date()) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10);
}

function addDays(n: number) {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}

function dayAt(h: number, m: number) {
  const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString();
}

/* ----------------------------- money & locale ---------------------------- */

// NOTE: the *_ngn column names (amount_ngn, limit_ngn, est_cost_ngn, …) are
// legacy — they store amounts in the HOUSEHOLD'S chosen currency, which is
// Naira only when the household picked Nigeria.
interface CountryDef { code: string; country: string; currency: string; symbol: string }

const COUNTRIES: CountryDef[] = [
  { code: "NG", country: "Nigeria", currency: "NGN", symbol: "₦" },
  { code: "GH", country: "Ghana", currency: "GHS", symbol: "GH₵" },
  { code: "KE", country: "Kenya", currency: "KES", symbol: "KSh " },
  { code: "ZA", country: "South Africa", currency: "ZAR", symbol: "R" },
  { code: "EG", country: "Egypt", currency: "EGP", symbol: "E£" },
  { code: "ET", country: "Ethiopia", currency: "ETB", symbol: "Br " },
  { code: "TZ", country: "Tanzania", currency: "TZS", symbol: "TSh " },
  { code: "UG", country: "Uganda", currency: "UGX", symbol: "USh " },
  { code: "US", country: "United States", currency: "USD", symbol: "$" },
  { code: "CA", country: "Canada", currency: "CAD", symbol: "CA$" },
  { code: "GB", country: "United Kingdom", currency: "GBP", symbol: "£" },
  { code: "IE", country: "Ireland", currency: "EUR", symbol: "€" },
  { code: "DE", country: "Germany", currency: "EUR", symbol: "€" },
  { code: "FR", country: "France", currency: "EUR", symbol: "€" },
  { code: "ES", country: "Spain", currency: "EUR", symbol: "€" },
  { code: "IT", country: "Italy", currency: "EUR", symbol: "€" },
  { code: "NL", country: "Netherlands", currency: "EUR", symbol: "€" },
  { code: "PT", country: "Portugal", currency: "EUR", symbol: "€" },
  { code: "AE", country: "United Arab Emirates", currency: "AED", symbol: "AED " },
  { code: "SA", country: "Saudi Arabia", currency: "SAR", symbol: "SAR " },
  { code: "IN", country: "India", currency: "INR", symbol: "₹" },
  { code: "PK", country: "Pakistan", currency: "PKR", symbol: "₨" },
  { code: "PH", country: "Philippines", currency: "PHP", symbol: "₱" },
  { code: "SG", country: "Singapore", currency: "SGD", symbol: "S$" },
  { code: "AU", country: "Australia", currency: "AUD", symbol: "A$" },
  { code: "NZ", country: "New Zealand", currency: "NZD", symbol: "NZ$" },
  { code: "BR", country: "Brazil", currency: "BRL", symbol: "R$" },
  { code: "MX", country: "Mexico", currency: "MXN", symbol: "MX$" },
  { code: "JM", country: "Jamaica", currency: "JMD", symbol: "J$" },
  { code: "XX", country: "Other / not listed", currency: "USD", symbol: "$" },
];

function countryByCode(code?: string | null): CountryDef {
  return COUNTRIES.find((c) => c.code === (code || "").toUpperCase()) || COUNTRIES[0];
}

function countryByName(name?: string | null): CountryDef {
  return COUNTRIES.find((c) => c.country === name) || COUNTRIES[0];
}

// The signed-in household's display currency. Set when the household (and its
// settings row) resolves; fmtN renders every amount with it. Defaults to
// Naira for households that never picked a country.
let ACTIVE_CURRENCY: { code: string; symbol: string } = { code: "NGN", symbol: "₦" };

function setActiveCurrency(code?: string | null, symbol?: string | null) {
  ACTIVE_CURRENCY = { code: (code || "NGN").toUpperCase(), symbol: symbol || "₦" };
}

function currencySymbol() { return ACTIVE_CURRENCY.symbol.trim(); }

function fmtN(n: number | string) { return `${ACTIVE_CURRENCY.symbol}${Number(n || 0).toLocaleString()}`; }

function weekDays() {
  const today = new Date(); today.setHours(0,0,0,0);
  return Array.from({length:7}, (_, i) => new Date(today.getTime() + i * 86400000).toISOString().slice(0,10));
}

function localDateKey(d = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstName(name: string) { return String(name || "").trim().split(/\s+/)[0] || "there"; }

/**
 * WorkspaceDB's imperative insert() does not reliably return the created row
 * (its shape varies by platform version — sometimes the row, sometimes a
 * wrapper, sometimes just a success flag). Dig an id out of any known shape;
 * callers MUST have a query-back fallback for when this returns 0.
 */
function insertedId(result: unknown): number {
  const fromRow = (row: unknown): number => {
    if (row && typeof row === "object" && "id" in (row as Record<string, unknown>)) {
      const n = Number((row as Record<string, unknown>).id);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    return 0;
  };
  if (Array.isArray(result)) return fromRow(result[0]);
  const direct = fromRow(result);
  if (direct) return direct;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const key of ["data", "row", "rows", "record", "records", "inserted"]) {
      const v = r[key];
      const n = Array.isArray(v) ? fromRow(v[0]) : fromRow(v);
      if (n) return n;
    }
  }
  return 0;
}

const db = () => window.__workspaceDb;
// Household data is stored once and shared: every read/write goes through the
// shared scope and is filtered by household_id (NOT by visitor session).
const hdb = (table: string) => db().from(table, { shared: true });

function getSpaceId(): string {
  const w = window as unknown as { __SPACE_ID__?: string; __APP_ID__?: string };
  return w.__SPACE_ID__ || w.__APP_ID__ || "workspace-968216";
}

function getWorkspaceIdForApi(): string {
  const w = window as unknown as { __WORKSPACE_ID__?: string };
  return w.__WORKSPACE_ID__ || getSpaceId();
}

/** The individual OziUno account = the email-gate login (one per person). */
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

/** Every membership row for an email (optionally scoped to one household), oldest first — used to recognise returning users before any onboarding screen or INSERT. */
async function membershipsForEmail(email: string, householdId?: number): Promise<Membership[]> {
  const q = householdId
    ? hdb("household_memberships").eq("household_id", householdId).eq("email", email)
    : hdb("household_memberships").eq("email", email);
  const { data } = await q.get();
  return (data || []) as unknown as Membership[];
}

function activeMembership(rows: Membership[]): Membership | undefined {
  return rows.find((m) => String(m.status) === "active");
}

/** The most recent name this email was known by, from any prior membership row. */
function lastKnownName(rows: Membership[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const n = String(rows[i]?.name || "").trim();
    if (n) return n;
  }
  return "";
}

function makeHouseholdCode(name: string) {
  const prefix = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8) || "HOME";
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}-${digits}`;
}

function joinLink(code: string) {
  return `${window.location.origin}${window.location.pathname}?join=${encodeURIComponent(code)}`;
}

async function sendInviteEmail(toEmail: string, householdName: string, code: string, inviterName: string, role: Role): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspaces/${getWorkspaceIdForApi()}/schedules/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `OziUno household invite — ${toEmail}`,
        description: `Invite to join ${householdName}`,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        email: {
          to: toEmail,
          subject: `You've been invited to join ${householdName} on OziUno`,
          text: `${inviterName} invited you to join "${householdName}" on OziUno as ${ROLE_LABELS[role]}.\n\nOpen ${joinLink(code)} , sign in with this email address (${toEmail}), and you'll be linked to the household automatically.\n\nIf you're asked for a household code, enter: ${code}`,
          html: `<div style="font-family:Inter,Arial,sans-serif;color:#0f1b2d;line-height:1.6">
            <h2 style="font-weight:600">You've been invited to join ${householdName} on OziUno</h2>
            <p><strong>${inviterName}</strong> invited you to join <strong>${householdName}</strong> as <strong>${ROLE_LABELS[role]}</strong>.</p>
            <p><a href="${joinLink(code)}" style="background:#0d9488;color:#f8fafc;padding:10px 18px;border-radius:9999px;text-decoration:none;display:inline-block">Join ${householdName}</a></p>
            <p>Sign in with this email address (<strong>${toEmail}</strong>) and you'll be linked automatically.</p>
            <p style="color:#5b6b81;font-size:13px">If you're asked for a household code, enter: <strong>${code}</strong></p>
          </div>`,
        },
      }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null) as { success?: boolean } | null;
    return data?.success !== false;
  } catch {
    return false;
  }
}

/* ------------------------------ voice helpers ---------------------------- */

function stripForSpeech(md: string) {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read a reply aloud with OziUno's natural voice (ElevenLabs via the shared
 * voiceEngine; falls back to the browser's built-in speech automatically). */
function speak(text: string) {
  void voiceEngine.tts.speak(stripForSpeech(text)).catch(() => { /* provider handles fallback */ });
}

function stopSpeaking() {
  voiceEngine.tts.stop();
}

/** Hand a dashboard question (typed or spoken) to the chat view so it auto-sends. */
function stashPendingChatMessage(tid: number, text: string, spoken = false) {
  try { sessionStorage.setItem("ozi_pending_chat", JSON.stringify({ tid, text, spoken })); } catch { /* storage unavailable */ }
}

/**
 * Push-to-talk mic: tap to record, tap again to stop. The recording is
 * transcribed server-side via the platform's /api/generate/transcribe
 * endpoint and handed back as text — voice is for convenience and
 * attribution, never identity verification.
 */
function MicButton({ onText, onError, title = "Speak to OziUno", disabled = false }: {
  onText: (text: string) => void;
  onError?: (message: string) => void;
  title?: string;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  useEffect(() => () => {
    try { recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* already stopped */ }
  }, []);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 200) return; // an accidental tap, not speech
        setBusy(true);
        try {
          const formData = new FormData();
          formData.append("audio", blob, "voice-note.webm");
          const res = await fetch("/api/generate/transcribe", { method: "POST", body: formData });
          if (!res.ok) throw new Error("Transcription failed");
          const data = await res.json() as { text?: string };
          const text = (data.text || "").trim();
          if (text) onText(text);
          else onError?.("Didn't catch that — try again, a little closer to the mic.");
        } catch {
          onError?.("Couldn't transcribe that — please try again or type instead.");
        } finally { setBusy(false); }
      };
      recorder.start();
      setRecording(true);
    } catch {
      onError?.("Microphone access was blocked. Allow it in your browser settings, or type instead.");
    }
  };
  const stop = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setRecording(false);
  };
  return (
    <button
      type="button"
      onClick={recording ? stop : start}
      disabled={disabled || busy}
      aria-label={recording ? "Stop recording and send" : title}
      className={recording ? "ozi-rec" : undefined}
      title={recording ? "Stop and send" : title}
      style={{
        width: 40, height: 40, borderRadius: 9999, flexShrink: 0,
        border: recording ? "1px solid #dc2626" : "1px solid rgba(15,27,45,.12)",
        background: recording ? "#dc2626" : "transparent",
        color: recording ? "#f8fafc" : "#3b4d63",
        cursor: busy ? "wait" : "pointer",
        display: "grid", placeItems: "center", opacity: busy ? .6 : 1,
      }}
    >
      {recording ? <Square size={16} /> : <Mic size={18} />}
    </button>
  );
}

const TRIAL_DAYS = 7;

// The 7-day free trial + paywall gate — re-enabled 2026-08 now that paid ads
// are running. Setting this back to false pauses enforcement (as during the
// early-adoption phase): the trial timer, the countdown pill, the trial-expired
// lock screen and the pricing prompts are all bypassed and every user behaves
// as if on an active, unlimited plan. The full paywall system (checkTrial,
// TrialPill, BillingView, PaywallView) stays intact either way.
const TRIAL_ENFORCEMENT_ENABLED = true;

// The agreed OziUno billing plan: 7-day free trial, then $29/month or $250/year.
const PLANS = [
  { key: "monthly", name: "Monthly", price: "$29", cadence: "per month", note: "Flexible — cancel anytime.", featured: false, priceCents: 2900, interval: "month" },
  { key: "yearly", name: "Yearly", price: "$250", cadence: "per year", note: "Save ~28% — one month free.", featured: true, priceCents: 25000, interval: "year" },
];
type Plan = (typeof PLANS)[number];

interface TrialState { checked: boolean; expired: boolean; daysLeft: number; subscribed: boolean; plan: string | null; forHousehold: number | null }

const CHECKOUT_MARKER = "ozi_pending_checkout";

/**
 * Start Stripe checkout for one of the agreed plans. Platform-mode payments
 * work out of the box (no Stripe account setup needed). The 7-day free trial
 * is tracked in-app via trial_status, so checkout itself charges immediately.
 */
async function startPlanCheckout(plan: Plan): Promise<void> {
  const w = window as unknown as { __APP_ID__?: string };
  const res = await fetch("/api/payments/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Id": w.__APP_ID__ || getSpaceId() },
    body: JSON.stringify({
      priceCents: plan.priceCents,
      interval: plan.interval,
      trialDays: 0,
      customerEmail: getAccount().email || undefined,
      billingPlanId: `oziuno-${plan.key}`,
      billingPlanName: `OziUno ${plan.name}`,
      metadata: { product: "oziuno", plan: plan.key },
      successUrl: `${window.location.origin}${window.location.pathname}#app-main`,
      cancelUrl: window.location.href,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.checkoutUrl) throw new Error(String(data?.error || "Checkout could not be started"));
  try { sessionStorage.setItem(CHECKOUT_MARKER, JSON.stringify({ plan: plan.key, sessionId: data.sessionId, ts: Date.now() })); } catch { /* storage unavailable */ }
  window.location.href = String(data.checkoutUrl);
}

/**
 * After returning from Stripe, confirm the checkout session actually paid and
 * flip the HOUSEHOLD's trial_status row to subscribed. The subscription is
 * keyed to household_id (one trial/subscription per household) — when called
 * before the household has resolved, the checkout marker is kept so the next
 * run retries. Returns true when a subscription was activated.
 */
async function finalizeCheckout(householdId: number | null): Promise<boolean> {
  let marker: { plan?: string; sessionId?: string; ts?: number } | null = null;
  try { const raw = sessionStorage.getItem(CHECKOUT_MARKER); marker = raw ? JSON.parse(raw) : null; } catch { /* storage unavailable */ }
  if (!marker?.sessionId) return false;
  try {
    const res = await fetch(`/api/payments/status/${encodeURIComponent(marker.sessionId)}`);
    const data = await res.json();
    if (res.ok && (data?.paymentStatus === "paid" || data?.status === "complete")) {
      if (!householdId) return false; // household not resolved yet — marker is kept, retried once it is
      const { data: rows } = await hdb("trial_status").eq("household_id", householdId).orderBy("created_at", "asc").limit(1).get();
      const row = rows?.[0];
      if (row) await hdb("trial_status").update(Number(row.id), { subscribed: true, plan: marker.plan || "monthly" });
      else await hdb("trial_status").insert({ household_id: householdId, trial_started_at: new Date().toISOString(), subscribed: true, plan: marker.plan || "monthly" });
      sessionStorage.removeItem(CHECKOUT_MARKER);
      return true;
    }
  } catch (err) {
    console.warn("[OziUno] Checkout verification failed (will retry on next load):", err);
  }
  // Abandoned/canceled checkouts: stop checking after a day.
  if (Date.now() - Number(marker.ts || 0) > 86400000) { try { sessionStorage.removeItem(CHECKOUT_MARKER); } catch { /* ignore */ } }
  return false;
}

/* ------------------------- household domain types ------------------------ */

interface Membership {
  id: number;
  household_id: number;
  name: string;
  email: string | null;
  role: Role;
  relation?: string | null;
  age?: number | null;
  dietary_notes?: string | null;
  status: string;
  invited_by?: string | null;
  [key: string]: unknown;
}

interface Household {
  id: number;
  name: string;
  household_code: string;
  owner_email?: string | null;
  owner_name?: string | null;
  adults?: number | null;
  children?: number | null;
  family_size?: number | null;
  monthly_food_budget_ngn?: number | string | null;
  onboarded?: boolean | null;
  [key: string]: unknown;
}

interface HouseholdSettings {
  id: number;
  household_id: number;
  country?: string | null;
  currency_code?: string | null;
  currency_symbol?: string | null;
  [key: string]: unknown;
}

interface HHCtx {
  household: Household;
  member: Membership;
  hid: number;
  isOwner: boolean;
  settings: HouseholdSettings | null;
  go: (v: View, t?: number | null) => void;
  refreshHousehold: () => void;
}

const hhFilter = (hid: number) => [{ column: "household_id", operator: "eq", value: hid }];

/** ISO timestamp → value for <input type="datetime-local"> in LOCAL time. */
function toLocalInputValue(iso: unknown): string {
  const d = new Date(String(iso || ""));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Keep the month's budget in sync with bills: marking a bill paid ADDS its
 * amount to the matching budget category for the current month (creating the
 * category with a 0 limit if it doesn't exist yet); un-marking a bill takes
 * the amount back out. Editing an already-paid bill calls this twice
 * (subtract the old amount/category, add the new one).
 */
async function syncBudgetForBill(hid: number, category: string, amount: number, direction: 1 | -1) {
  try {
    const amt = Number(amount) || 0;
    if (!amt) return;
    const month = monthKey();
    const cat = String(category || "other").toLowerCase().trim() || "other";
    const { data } = await hdb("hh_budgets").eq("household_id", hid).eq("month", month).eq("category", cat).get();
    const existing = data?.[0];
    if (existing) {
      await hdb("hh_budgets").update(Number(existing.id), { spent_ngn: Math.max(0, Number(existing.spent_ngn || 0) + direction * amt) });
    } else if (direction > 0) {
      await hdb("hh_budgets").insert({ household_id: hid, month, category: cat, limit_ngn: 0, spent_ngn: amt });
    }
  } catch (err) {
    console.warn("[OziUno] Budget sync failed:", err);
  }
}

/** Shared spending categories — ONE list drives both the Bills form and the Budget category picker so they always match. */
const BILL_CATS = ["utility", "rent", "food", "school", "transport", "health", "subscription", "other"];

/* --------------------------- household inventory -------------------------- */

/**
 * Unified Household Inventory: hh_inventory_items covers EVERY category (food
 * and non-food), each item optionally assigned to a storage location inside a
 * room (hh_rooms → hh_storage_locations). Legacy hh_pantry_items is never
 * modified — its rows are copied in once per household (category "pantry",
 * legacy_pantry_id kept so old shopping-list links keep working).
 */
const INV_CATS: { key: string; label: string; short: string; icon: string; food?: boolean }[] = [
  { key: "pantry", label: "Pantry (Food & Drinks)", short: "Pantry", icon: "🍚", food: true },
  { key: "household", label: "Household Supplies", short: "Household", icon: "🧻" },
  { key: "toiletries", label: "Toiletries & Personal Care", short: "Toiletries", icon: "🧴" },
  { key: "cleaning", label: "Cleaning Supplies", short: "Cleaning", icon: "🧽" },
  { key: "laundry", label: "Laundry Supplies", short: "Laundry", icon: "🧺" },
  { key: "medicine", label: "Medicine Cabinet", short: "Medicine", icon: "💊" },
  { key: "baby", label: "Baby Supplies", short: "Baby", icon: "🍼" },
  { key: "pet", label: "Pet Supplies", short: "Pets", icon: "🐾" },
  { key: "home_maintenance", label: "Home Maintenance", short: "Maintenance", icon: "🔧" },
  { key: "seasonal", label: "Seasonal Storage", short: "Seasonal", icon: "📦" },
];

/** Only the Pantry category is edible — meal planning & meal-driven consumption read these rows. */
function invCatIsFood(key: unknown): boolean { return String(key || "pantry") === "pantry"; }
function foodItems(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.filter((r) => invCatIsFood(r.category));
}

/** Normalise any stored category value to a valid inventory key (legacy shopping rows carry food types like "dairy"). */
function invCatKey(v: unknown): string {
  const k = String(v || "").toLowerCase().trim();
  if (INV_CATS.some((c) => c.key === k) || k.startsWith("custom:")) return k;
  return "pantry";
}

function invCatLabel(key: unknown, custom?: Record<string, unknown>[]): string {
  const k = String(key || "pantry");
  const builtIn = INV_CATS.find((c) => c.key === k);
  if (builtIn) return builtIn.short;
  if (k.startsWith("custom:")) {
    const row = (custom ?? []).find((c) => `custom:${c.id}` === k);
    if (row) return String(row.name);
    return "Custom";
  }
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : "Pantry";
}

function invCatIcon(key: unknown, custom?: Record<string, unknown>[]): string {
  const k = String(key || "pantry");
  const builtIn = INV_CATS.find((c) => c.key === k);
  if (builtIn) return builtIn.icon;
  if (k.startsWith("custom:")) {
    const row = (custom ?? []).find((c) => `custom:${c.id}` === k);
    if (row?.icon) return String(row.icon);
  }
  return "🏷️";
}

/** Estimated days of stock left from the item's own consumption rate
 * (typical_days_to_deplete anchored at the last restock); null when unknown. */
function invDaysRemaining(item: Record<string, unknown>, now = new Date()): number | null {
  const qty = Number(item.quantity) || 0;
  if (qty <= 0) return 0;
  const typical = Number(item.typical_days_to_deplete) || 0;
  if (!typical) return null;
  const anchor = new Date(String(item.last_restocked_at || item.created_at || ""));
  if (Number.isNaN(anchor.getTime())) return null;
  return Math.max(0, typical - wlDayDiff(anchor, now));
}

/** Low-stock test across ALL categories: explicit warn/empty status, zero
 * stock, at/below the preferred minimum, or an estimated ≤3 days remaining. */
function invIsLow(item: Record<string, unknown>): boolean {
  const qty = Number(item.quantity) || 0;
  if (["warn", "empty"].includes(String(item.status || "").toLowerCase())) return true;
  if (qty <= 0) return true;
  const min = Number(item.min_stock_level);
  if (Number.isFinite(min) && min > 0 && qty <= min) return true;
  const left = invDaysRemaining(item);
  return left !== null && left <= 3;
}

/** Default spatial map seeded for every household on first Inventory access — fully editable afterwards. */
const DEFAULT_ROOMS: { name: string; icon: string; locations: string[] }[] = [
  { name: "Kitchen", icon: "🍳", locations: ["Pantry", "Fridge", "Freezer", "Kitchen Cupboard"] },
  { name: "Bathroom", icon: "🚿", locations: ["Bathroom Cabinet", "Under-sink Storage"] },
  { name: "Laundry Room", icon: "🧺", locations: ["Cleaning Cupboard", "Laundry Shelf"] },
  { name: "Living Room", icon: "🛋️", locations: ["Storage Unit"] },
  { name: "Bedroom", icon: "🛏️", locations: ["Wardrobe", "Bedside Drawer"] },
  { name: "Garage", icon: "🚗", locations: ["Tool Shelf", "Storage Rack", "Garage Shelf"] },
  { name: "Storage Room", icon: "📦", locations: ["Storage Boxes", "Shelving"] },
];

/**
 * One-time, idempotent inventory setup per household:
 *  1) seeds the default rooms & storage locations when none exist yet;
 *  2) copies legacy hh_pantry_items rows into hh_inventory_items (category
 *     "pantry", legacy_pantry_id set) IF the household's inventory is still
 *     empty — hh_pantry_items itself is never altered.
 * Safe to call from several places: an in-flight promise per household plus
 * the emptiness/legacy-id checks keep it from double-copying.
 */
const invReadyByHousehold = new Map<number, Promise<boolean>>();
function ensureInventoryReady(hid: number): Promise<boolean> {
  const inFlight = invReadyByHousehold.get(hid);
  if (inFlight) return inFlight;
  const job = (async () => {
    let changed = false;
    try {
      // 1) Rooms & storage locations.
      const { data: rooms } = await hdb("hh_rooms").eq("household_id", hid).get();
      if (!(rooms ?? []).length) {
        for (let i = 0; i < DEFAULT_ROOMS.length; i++) {
          await hdb("hh_rooms").insert({ household_id: hid, name: DEFAULT_ROOMS[i].name, icon: DEFAULT_ROOMS[i].icon, sort_order: i });
        }
        const { data: created } = await hdb("hh_rooms").eq("household_id", hid).get();
        const locRows: Record<string, unknown>[] = [];
        for (const def of DEFAULT_ROOMS) {
          const room = (created ?? []).find((r) => String(r.name) === def.name);
          if (!room) continue;
          def.locations.forEach((loc, j) => locRows.push({ household_id: hid, room_id: Number(room.id), name: loc, sort_order: j }));
        }
        if (locRows.length) await hdb("hh_storage_locations").bulkInsert(locRows);
        changed = true;
      }
      // 2) Legacy pantry migration (copy, never move — hh_pantry_items stays intact).
      const [invRes, legacyRes] = await Promise.all([
        hdb("hh_inventory_items").eq("household_id", hid).limit(1000).get(),
        hdb("hh_pantry_items").eq("household_id", hid).limit(1000).get(),
      ]);
      const migrated = new Set((invRes.data ?? []).map((r) => Number(r.legacy_pantry_id)).filter((n) => Number.isFinite(n) && n > 0));
      const pending = (legacyRes.data ?? []).filter((p) => !migrated.has(Number(p.id)));
      if (!(invRes.data ?? []).length && pending.length) {
        // Migrated food defaults to the Kitchen's Pantry shelf when it exists.
        let pantryLocId: number | null = null;
        try {
          const { data: locs } = await hdb("hh_storage_locations").eq("household_id", hid).get();
          const loc = (locs ?? []).find((l) => String(l.name).toLowerCase() === "pantry");
          if (loc) pantryLocId = Number(loc.id);
        } catch { /* location is optional */ }
        await hdb("hh_inventory_items").bulkInsert(pending.map((p) => ({
          household_id: hid, name: String(p.name), category: "pantry",
          subcategory: p.category != null ? String(p.category) : null,
          storage_location_id: pantryLocId,
          quantity: Number(p.quantity) || 0, unit: String(p.unit || "unit"),
          status: String(p.status || "ok"),
          typical_days_to_deplete: p.typical_days_to_deplete != null ? Number(p.typical_days_to_deplete) : null,
          expires_at: p.expires_at || null, last_restocked_at: p.last_restocked_at || null,
          notes: p.notes || null, added_by: p.added_by || null,
          legacy_pantry_id: Number(p.id),
        })));
        changed = true;
      }
      // 3) Taxonomy backfill (idempotent, high-confidence only): fill missing
      //    ingredient_key, upgrade placeholder units ("unit") from the
      //    hardcoded taxonomy, and FLAG suspicious units (eggs in kg) for
      //    member review — quantities and real units are never rewritten.
      const { data: invAll } = await hdb("hh_inventory_items").eq("household_id", hid).limit(1000).get();
      for (const it of invAll ?? []) {
        const patch: Record<string, unknown> = {};
        if (!it.ingredient_key) {
          const key = ingredientKeyOf(it.name);
          if (key) patch.ingredient_key = key;
        }
        const inferred = inferLegacyUnit(it as never);
        if (inferred.unit) patch.unit = inferred.unit;
        if (inferred.flag && it.unit_review !== true) patch.unit_review = true;
        if (Object.keys(patch).length) {
          await hdb("hh_inventory_items").update(Number(it.id), patch);
          changed = true;
        }
      }
      // 4) Ledger opening balances: every item without ledger history gets an
      //    opening_balance transaction equal to its current stock (bookkeeping
      //    only — quantities are untouched, existing data preserved).
      const opened = await recordOpeningBalances(hid);
      if (opened > 0) changed = true;
    } catch (err) {
      console.warn("[OziUno] Inventory setup failed:", err);
      invReadyByHousehold.delete(hid); // allow a retry on the next call
    }
    return changed;
  })();
  invReadyByHousehold.set(hid, job);
  return job;
}

/** Record a purchase in hh_inventory_purchase_history — feeds the Budget view's per-category spend and consumption analytics. */
async function logInventoryPurchase(hid: number, row: { item_id?: number | null; item_name: string; category?: string | null; qty: number; unit: string; price?: number; store?: string | null; added_by?: string | null }) {
  try {
    await hdb("hh_inventory_purchase_history").insert({
      household_id: hid, item_id: row.item_id ?? null, item_name: row.item_name,
      category: invCatKey(row.category), qty: row.qty, unit: row.unit,
      price_ngn: Number(row.price) || 0, store: row.store || null,
      purchased_at: new Date().toISOString(), added_by: row.added_by || null,
    });
  } catch (err) {
    console.warn("[OziUno] Purchase log failed:", err);
  }
}

/* ---------------------- meal commitments & confirmation -------------------- */

/**
 * CRITICAL PRINCIPLE: a planned meal is a FORECAST/COMMITMENT — never an
 * actual consumption event. Planning a meal only writes hh_meal_ingredients
 * rows (status "committed", scaled to the household size). Actual inventory
 * is reduced ONLY when a member confirms the meal happened (MealCheckins →
 * confirmMealOutcome), which posts consumption transactions to the
 * hh_inventory_ledger. Cancelling a meal releases its commitments and leaves
 * inventory untouched. AI is used solely to PROPOSE the ingredient list of a
 * named dish — units are forced through the hardcoded taxonomy, quantities
 * are scaled deterministically in code, and nothing touches stock without a
 * confirmed event.
 */

/** A meal slot counts as "due for check-in" once its time has comfortably passed. */
function mealSlotPassed(dateKey: string, meal: string, now = new Date()): boolean {
  const today = localDateKey(now);
  if (dateKey < today) return true;
  if (dateKey > today) return false;
  const hour = now.getHours();
  return meal === "breakfast" ? hour >= 10 : meal === "lunch" ? hour >= 15 : hour >= 21;
}

/** Effective servings for a meal: explicit per-meal override, else the
 * household's declared composition (children ≈ half a serving), upgraded to
 * the live roster when it has grown past it. */
function servingsForMeal(household: Household, members: Record<string, unknown>[], meal?: Record<string, unknown> | null): number {
  const override = Number(meal?.servings);
  if (override > 0) return override;
  const rosterAdults = members.filter((m) => String(m.role) !== "child").length;
  const rosterChildren = members.filter((m) => String(m.role) === "child").length;
  let adults = Number(household.adults) || 0;
  let children = Number(household.children) || 0;
  if (rosterAdults + rosterChildren > adults + children) { adults = rosterAdults; children = rosterChildren; }
  if (adults + children === 0) adults = Math.max(1, Number(household.family_size) || 1);
  return householdServings(adults, children);
}

/** Marker name for meals whose dish uses no tracked ingredients — keeps the
 * commitment builder idempotent without ever touching inventory. */
const NO_INGREDIENTS_MARKER = "(no tracked ingredients)";

/**
 * AI proposes STRUCTURED base ingredients for named dishes (per
 * DEFAULT_RECIPE_YIELD servings). Output is sanitized through the controlled
 * unit system — the AI never decides units for taxonomy items and never
 * touches inventory.
 */
async function extractIngredientsForMeals(
  meals: Record<string, unknown>[],
  prefs: Record<string, unknown>[],
  country: string,
): Promise<Map<number, { name: string; ingredient_key: string; quantity: number; unit: string; optional: boolean; preparation_state: string | null }[]>> {
  const out = new Map<number, { name: string; ingredient_key: string; quantity: number; unit: string; optional: boolean; preparation_state: string | null }[]>();
  if (!meals.length) return out;
  const text = await aiComplete(
    'You are OziUno\'s recipe analyst. Return STRICT JSON only: {"meals":[{"meal_id":1,"ingredients":[{"name":"Rice","quantity":500,"unit":"g","optional":false,"preparation_state":"raw"}]}]}. ' +
    `For EACH meal listed, break the ACTUAL dish named into its main ingredients with realistic quantities for ${DEFAULT_RECIPE_YIELD} servings of everyday home cooking in ${country}. ` +
    "Use ONLY these units: pcs, g, kg, ml, L, loaves, rolls, bars, tubes, packs, bottles. NEVER include an ingredient that is not clearly part of that dish. " +
    "Skip water, salt-to-taste and trace seasonings. 3–8 ingredients per meal; a dish may have none you can name (empty array). quantity must be a NUMBER. Include every meal_id exactly once.",
    `Meals: ${JSON.stringify(meals.map((m) => ({ meal_id: Number(m.id), title: m.title, meal: m.meal, recipe: String(m.recipe_md || "").slice(0, 240) || undefined })))}`,
    true,
  );
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : text) as { meals?: { meal_id?: number; ingredients?: Record<string, unknown>[] }[] };
  for (const m of parsed.meals ?? []) {
    const mid = Number(m.meal_id);
    if (!meals.some((x) => Number(x.id) === mid) || out.has(mid)) continue;
    const rows: { name: string; ingredient_key: string; quantity: number; unit: string; optional: boolean; preparation_state: string | null }[] = [];
    for (const raw of m.ingredients ?? []) {
      const s = sanitizeIngredient(raw as { name?: unknown; quantity?: unknown; unit?: unknown; optional?: unknown; preparation_state?: unknown }, prefs as never);
      if (s) rows.push(s);
    }
    out.set(mid, rows.slice(0, 10));
  }
  return out;
}

/**
 * Build PLANNED requirements (commitments) for meals that don't have them
 * yet: recent + upcoming planned meals get structured hh_meal_ingredients
 * rows, scaled to the household and matched to inventory items. This NEVER
 * changes inventory quantities — commitments are a forecast layer only.
 */
let commitmentsInFlight = false;
async function ensureMealCommitments(hid: number, household: Household): Promise<number> {
  if (commitmentsInFlight) return 0;
  commitmentsInFlight = true;
  try {
    const now = new Date();
    const today = localDateKey(now);
    const weekAgo = localDateKey(new Date(now.getTime() - 7 * 86400000));
    const weekAhead = localDateKey(new Date(now.getTime() + 7 * 86400000));
    const [mealsRes, ingRes, invRes, memberRes, prefsRes] = await Promise.all([
      hdb("hh_meal_plans").eq("household_id", hid).orderBy("date", "desc").limit(1000).get(),
      hdb("hh_meal_ingredients").eq("household_id", hid).limit(1000).get(),
      hdb("hh_inventory_items").eq("household_id", hid).limit(1000).get(),
      hdb("household_memberships").eq("household_id", hid).eq("status", "active").limit(200).get(),
      hdb("hh_ingredient_prefs").eq("household_id", hid).limit(200).get(),
    ]);
    const covered = new Set((ingRes.data ?? []).map((r) => Number(r.meal_plan_id)));
    const pending = (mealsRes.data ?? []).filter((m) => {
      const dateKey = String(m.date).slice(0, 10);
      return dateKey >= weekAgo && dateKey <= weekAhead
        && String(m.status || "planned") === "planned"
        && !covered.has(Number(m.id));
    }).slice(0, 24);
    if (!pending.length) return 0;
    const foodInv = foodItems(invRes.data ?? []);
    const country = (await loadHouseholdSettings(hid))?.country || "Nigeria";
    const extracted = await extractIngredientsForMeals(pending, prefsRes.data ?? [], country);
    const servings = servingsForMeal(household, memberRes.data ?? []);
    let created = 0;
    for (const meal of pending) {
      const mid = Number(meal.id);
      const mealServings = Number(meal.servings) > 0 ? Number(meal.servings) : servings;
      const rows = extracted.get(mid) ?? [];
      if (!rows.length) {
        // Marker row → this meal is committed with no tracked ingredients.
        await hdb("hh_meal_ingredients").insert({
          household_id: hid, meal_plan_id: mid, name: NO_INGREDIENTS_MARKER, ingredient_key: "",
          quantity: 0, unit: "pcs", recipe_yield: DEFAULT_RECIPE_YIELD, required_qty: 0, required_unit: "pcs",
          optional: true, status: "cancelled",
        });
        continue;
      }
      for (const ing of rows) {
        const required = scaleIngredientQty(ing.quantity, DEFAULT_RECIPE_YIELD, mealServings);
        const item = matchInventoryItem(foodInv, ing.name);
        // Express the requirement in the matched item's own unit when a real
        // conversion exists; otherwise keep the recipe unit (never assume 1:1).
        let requiredQty = required;
        let requiredUnit = ing.unit;
        if (item) {
          const pkg = packageExpansion(item as never);
          if (pkg) {
            const conv = convertUnits(required, ing.unit, pkg.unit);
            if (conv != null) { requiredQty = Math.round((conv / pkg.size) * 100) / 100; requiredUnit = String(item.unit || ing.unit); }
          } else {
            const conv = convertUnits(required, ing.unit, String(item.unit || ""));
            if (conv != null) { requiredQty = Math.round(conv * 100) / 100; requiredUnit = String(item.unit || ing.unit); }
          }
        }
        await hdb("hh_meal_ingredients").insert({
          household_id: hid, meal_plan_id: mid, name: ing.name, ingredient_key: ing.ingredient_key,
          quantity: ing.quantity, unit: ing.unit, recipe_yield: DEFAULT_RECIPE_YIELD,
          required_qty: requiredQty, required_unit: requiredUnit,
          optional: ing.optional, preparation_state: ing.preparation_state,
          matched_item_id: item ? Number(item.id) : null, status: "committed",
        });
        created++;
      }
    }
    return created;
  } catch (err) {
    console.warn("[OziUno] Meal commitment sync failed:", err);
    return 0;
  } finally {
    commitmentsInFlight = false;
  }
}

/** Meals whose slot has passed but whose outcome is unconfirmed — the
 * check-in queue ("Did you have …?"). Never deducts anything by itself. */
function pendingCheckins(meals: Record<string, unknown>[], now = new Date()): Record<string, unknown>[] {
  const weekAgo = localDateKey(new Date(now.getTime() - 7 * 86400000));
  const today = localDateKey(now);
  return (meals ?? [])
    .filter((m) => {
      const dateKey = String(m.date).slice(0, 10);
      return dateKey >= weekAgo && dateKey <= today
        && String(m.status || "planned") === "planned"
        && mealSlotPassed(dateKey, String(m.meal), now);
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 6);
}

/** Merge the legacy hh_consumption_log rows with ledger consumption rows into
 * the shape computeConsumptionStats expects — history is never thrown away. */
function usageRowsForStats(legacyLog: Record<string, unknown>[], ledger: Record<string, unknown>[]): Record<string, unknown>[] {
  const fromLedger = ledgerToUsage(ledger ?? []).map((u) => ({
    item_name: u.item_name, qty_used: u.qty_used, unit: u.unit, created_at: new Date(u.at).toISOString(),
  }));
  return [...(legacyLog ?? []), ...fromLedger];
}

/**
 * Ticking a shopping item as purchased restocks the inventory through a
 * PURCHASE transaction in the ledger (un-ticking posts a compensating RETURN
 * transaction). Package conversions use each product's explicit package size.
 * Every purchase is also recorded in hh_inventory_purchase_history for
 * budget tracking; un-ticking removes the most recent matching history row.
 */
async function applyPurchaseToPantry(hid: number, item: Record<string, unknown>, direction: 1 | -1, buyerName: string): Promise<string> {
  try {
    const qty = Number(item.quantity) || 1;
    const { data: invRows } = await hdb("hh_inventory_items").eq("household_id", hid).get();
    const linked = Number(item.linked_pantry_id);
    const nameKey = String(item.name || "").toLowerCase().trim();
    // linked_pantry_id may hold a new inventory id OR a pre-migration
    // hh_pantry_items id — legacy_pantry_id bridges the old links.
    const target = (invRows || []).find((p) => Number(p.id) === linked)
      || (invRows || []).find((p) => Number(p.legacy_pantry_id) === linked)
      || matchInventoryItem(invRows || [], item.name)
      || (invRows || []).find((p) => String(p.name || "").toLowerCase().trim() === nameKey);
    const today = localDateKey();
    if (direction > 0) {
      void logInventoryPurchase(hid, {
        item_id: target ? Number(target.id) : null, item_name: String(item.name),
        category: target ? String(target.category || "pantry") : String(item.category || ""),
        qty, unit: String(item.unit || "unit"), price: (Number(item.est_cost_ngn) || 0) * qty, added_by: buyerName,
      });
    } else {
      void (async () => {
        try {
          const { data: hist } = await hdb("hh_inventory_purchase_history").eq("household_id", hid).eq("item_name", String(item.name)).orderBy("purchased_at", "desc").limit(1).get();
          if (hist?.[0]) await hdb("hh_inventory_purchase_history").delete(Number(hist[0].id));
        } catch { /* history is best-effort */ }
      })();
    }
    if (target) {
      // Convert the bought amount into the item's own unit where a REAL
      // conversion exists (kg↔g, L↔ml, dozen↔pcs, explicit package sizes);
      // otherwise treat the line's number as being in the item's unit.
      const lineUnit = String(item.unit || "");
      const pkg = packageExpansion(target as never);
      const conv = convertUnits(qty, lineUnit, pkg ? pkg.unit : String(target.unit || ""));
      let delta = qty;
      if (conv != null) {
        delta = pkg ? conv / pkg.size : conv;
      }
      const res = await postTxn(hid, target, {
        type: direction > 0 ? "purchase" : "return",
        delta: (direction > 0 ? 1 : -1) * Math.abs(delta),
        reason: direction > 0
          ? `Bought: ${qty} ${lineUnit || "unit"} ${String(item.name)} (shopping list)`
          : `Purchase un-ticked: ${String(item.name)}`,
        createdBy: buyerName,
        ...(direction > 0 ? { extraItemPatch: { last_restocked_at: today } } : {}),
      });
      if (!res.ok) return "";
      return direction > 0
        ? `Inventory restocked: ${String(target.name)} is now ${res.newQty} ${String(target.unit || "")}.`
        : `Inventory adjusted: ${String(target.name)} back to ${res.newQty} ${String(target.unit || "")}.`;
    }
    if (direction > 0) {
      // New product: create the item, then record the purchase transaction.
      const normalized = normalizeQuantityInput(qty, String(item.unit || ""), String(item.name));
      const inserted = await hdb("hh_inventory_items").insert({
        household_id: hid, name: String(item.name), category: invCatKey(item.category),
        ingredient_key: ingredientKeyOf(item.name),
        quantity: 0, unit: normalized.unit, status: "empty", last_restocked_at: today, added_by: buyerName,
        ...(normalized.package_name ? { package_name: normalized.package_name, package_size: normalized.package_size, package_unit: normalized.package_unit } : {}),
      });
      let newId = insertedId(inserted);
      if (!newId) {
        const { data: again } = await hdb("hh_inventory_items").eq("household_id", hid).orderBy("created_at", "desc").limit(1).get();
        newId = Number(again?.[0]?.id) || 0;
      }
      if (newId) {
        const fresh = { id: newId, name: item.name, quantity: 0, unit: normalized.unit, min_stock_level: null };
        await postTxn(hid, fresh as Record<string, unknown>, {
          type: "purchase", delta: normalized.qty,
          reason: `Bought: ${qty} ${String(item.unit || "unit")} ${String(item.name)} (new item)`, createdBy: buyerName,
        });
      }
      return `Added ${String(item.name)} (${normalized.qty} ${normalized.unit}) to the inventory.`;
    }
    return "";
  } catch (err) {
    console.warn("[OziUno] Inventory restock failed:", err);
    return "";
  }
}

/* -------------------------------- WasteLess ------------------------------- */

type WasteSeverity = "use_today" | "use_soon" | "likely_wasted" | "info" | "positive";

const WASTE_SEVERITY_LABELS: Record<WasteSeverity, string> = {
  use_today: "Use today", use_soon: "Use soon", likely_wasted: "Likely wasted", info: "Insight", positive: "Saved",
};

interface WasteRisk { severity: "use_today" | "use_soon" | "likely_wasted"; reason: string }

function wlNorm(v: unknown): string { return String(v ?? "").toLowerCase().trim(); }

function wlDayDiff(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Waste-risk assessment for one pantry item. Prefers a recorded expiry date;
 * without one it falls back to a staleness heuristic (how long the stock has
 * sat vs how quickly this household usually finishes it).
 */
function assessPantryRisk(item: Record<string, unknown>, now = new Date()): WasteRisk | null {
  const qty = Number(item.quantity) || 0;
  if (qty <= 0) return null;
  if (item.expires_at) {
    const exp = new Date(String(item.expires_at));
    if (!Number.isNaN(exp.getTime())) {
      const d = wlDayDiff(now, exp);
      if (d < 0) return { severity: "likely_wasted", reason: `expired ${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago` };
      if (d === 0) return { severity: "use_today", reason: "expires today" };
      if (d === 1) return { severity: "use_today", reason: "expires tomorrow" };
      if (d <= 3) return { severity: "use_soon", reason: `expires in ${d} days` };
      return null;
    }
  }
  // No expiry recorded — staleness vs the household's usual pace.
  const typical = Number(item.typical_days_to_deplete) || 0;
  if (!typical) return null;
  const anchor = new Date(String(item.last_restocked_at || item.created_at || ""));
  if (Number.isNaN(anchor.getTime())) return null;
  const age = wlDayDiff(anchor, now);
  if (age >= Math.ceil(typical * 1.75)) return { severity: "likely_wasted", reason: `sitting ${age} days — you usually finish it in ${typical}` };
  if (age >= Math.ceil(typical * 1.25)) return { severity: "use_soon", reason: `${age} days old — you usually finish it in ${typical}` };
  return null;
}

interface ConsumptionStat {
  name: string; unit: string;
  buyEveryDays: number | null;
  dailyUse: number | null;
  daysLeft: number | null;
  avgCost: number;
  buyCount: number;
}

/** Per-item consumption profile from real household history (purchases + meal-usage ledger). */
function computeConsumptionStats(
  pantry: Record<string, unknown>[],
  shopping: Record<string, unknown>[],
  log: Record<string, unknown>[],
  windowDays = 30,
): Map<string, ConsumptionStat> {
  const stats = new Map<string, ConsumptionStat>();
  const ensure = (name: string, unit: string): ConsumptionStat => {
    const key = wlNorm(name);
    let s = stats.get(key);
    if (!s) { s = { name, unit, buyEveryDays: null, dailyUse: null, daysLeft: null, avgCost: 0, buyCount: 0 }; stats.set(key, s); }
    return s;
  };
  // Purchase cadence + typical cost, from bought shopping lines.
  const buys = new Map<string, { dates: number[]; costs: number[]; unit: string; name: string }>();
  for (const row of shopping) {
    if (!row.checked) continue;
    const key = wlNorm(row.name);
    if (!key) continue;
    const t = new Date(String(row.created_at || "")).getTime();
    const b = buys.get(key) || { dates: [], costs: [], unit: String(row.unit || "unit"), name: String(row.name) };
    if (Number.isFinite(t)) b.dates.push(t);
    const c = Number(row.est_cost_ngn) || 0;
    if (c > 0) b.costs.push(c);
    buys.set(key, b);
  }
  for (const [, b] of buys) {
    const s = ensure(b.name, b.unit);
    s.buyCount = b.dates.length;
    if (b.dates.length >= 2) {
      const sorted = b.dates.sort((x, y) => x - y);
      const span = (sorted[sorted.length - 1] - sorted[0]) / 86400000;
      if (span > 0) s.buyEveryDays = Math.max(1, Math.round(span / (sorted.length - 1)));
    }
    if (b.costs.length) s.avgCost = Math.round(b.costs.reduce((a, c) => a + c, 0) / b.costs.length);
  }
  // Consumption pace from the meal ledger.
  const used = new Map<string, { qty: number; first: number; name: string; unit: string }>();
  for (const row of log) {
    const q = Number(row.qty_used) || 0;
    const key = wlNorm(row.item_name);
    if (!key || q <= 0) continue;
    const t = new Date(String(row.created_at || "")).getTime();
    const u = used.get(key) || { qty: 0, first: Number.isFinite(t) ? t : Date.now(), name: String(row.item_name), unit: String(row.unit || "unit") };
    u.qty += q;
    if (Number.isFinite(t) && t < u.first) u.first = t;
    used.set(key, u);
  }
  for (const [, u] of used) {
    const s = ensure(u.name, u.unit);
    const spanDays = Math.min(windowDays, Math.max(1, (Date.now() - u.first) / 86400000));
    s.dailyUse = Math.round((u.qty / spanDays) * 100) / 100;
  }
  // Days of stock left at the current pace.
  for (const item of pantry) {
    const s = stats.get(wlNorm(item.name));
    if (!s || !s.dailyUse) continue;
    const qty = Number(item.quantity) || 0;
    s.daysLeft = qty > 0 ? Math.round(qty / s.dailyUse) : 0;
    if (!s.unit || s.unit === "unit") s.unit = String(item.unit || s.unit || "unit");
  }
  return stats;
}

/** Gamified 0–100 household score: at-risk items pull it down, acting on insights pushes it back up. */
function computeWasteScore(risks: WasteRisk[], resolvedThisMonth: number): number {
  let penalty = 0;
  for (const r of risks) penalty += r.severity === "likely_wasted" ? 12 : r.severity === "use_today" ? 6 : 3;
  const bonus = Math.min(15, resolvedThisMonth * 3);
  return Math.max(5, Math.min(100, 100 - Math.min(70, penalty) + bonus));
}

/** WasteLess tip for the shopping list: right-size the purchase from real usage. Empty string when there's no history yet. */
async function purchaseAdviceFor(hid: number, itemName: string): Promise<string> {
  try {
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const [pantryRes, shopRes, logRes, ledgerRes] = await Promise.all([
      hdb("hh_inventory_items").eq("household_id", hid).get(),
      hdb("hh_shopping_items").eq("household_id", hid).get(),
      hdb("hh_consumption_log").eq("household_id", hid).gte("created_at", monthAgo).get(),
      hdb("hh_inventory_ledger").eq("household_id", hid).gte("created_at", monthAgo).limit(500).get(),
    ]);
    const stats = computeConsumptionStats(pantryRes.data || [], shopRes.data || [], usageRowsForStats(logRes.data || [], ledgerRes.data || []));
    const s = stats.get(wlNorm(itemName));
    if (!s || !s.dailyUse || !s.buyEveryDays) return "";
    const suggested = Math.max(1, Math.ceil(s.dailyUse * s.buyEveryDays));
    return `WasteLess tip: you use about ${Math.round(s.dailyUse * 7 * 10) / 10} ${s.unit}/week of ${itemName} and shop roughly every ${s.buyEveryDays} days — ${suggested} ${s.unit} should last until your next shop.`;
  } catch {
    return "";
  }
}

/**
 * Generate today's WasteLess insight records for a household and persist the
 * NEW ones to hh_wasteless_insights (so they survive between sessions and the
 * morning briefing can read them). Existing active or same-day rows are never
 * duplicated — (type + item + severity) is the dedup key.
 */
async function syncWasteInsights(
  hid: number,
  pantry: Record<string, unknown>[],
  shopping: Record<string, unknown>[],
  log: Record<string, unknown>[],
  existing: Record<string, unknown>[],
): Promise<number> {
  const today = localDateKey();
  const seen = new Set(
    existing
      .filter((i) => String(i.status) === "active" || String(i.insight_date || "").slice(0, 10) === today)
      .map((i) => `${String(i.insight_type)}|${wlNorm(i.item_name)}|${String(i.severity)}`),
  );
  const stats = computeConsumptionStats(pantry, shopping, log);
  const rows: Record<string, unknown>[] = [];
  const push = (row: { insight_type: string; item_name: string | null; pantry_item_id?: number | null; shopping_item_id?: number | null; message: string; severity: WasteSeverity; est_value_ngn?: number }) => {
    const key = `${row.insight_type}|${wlNorm(row.item_name)}|${row.severity}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      household_id: hid, insight_type: row.insight_type, item_name: row.item_name,
      pantry_item_id: row.pantry_item_id ?? null, shopping_item_id: row.shopping_item_id ?? null,
      message: row.message, severity: row.severity, status: "active",
      est_value_ngn: Math.round(row.est_value_ngn || 0), insight_date: today,
    });
  };

  // 1) Waste-risk alerts.
  let monthlyWasteEstimate = 0;
  for (const item of pantry) {
    const risk = assessPantryRisk(item);
    if (!risk) continue;
    const s = stats.get(wlNorm(item.name));
    const value = (s && s.avgCost) || 0;
    if (risk.severity === "likely_wasted") monthlyWasteEstimate += value;
    push({
      insight_type: "risk", item_name: String(item.name), pantry_item_id: Number(item.id),
      message: `${String(item.name)} (${Number(item.quantity) || 0} ${String(item.unit || "unit")}) ${risk.reason}.`,
      severity: risk.severity, est_value_ngn: value,
    });
  }

  // 2) Consumption patterns for the items bought most often.
  const patterns = [...stats.values()]
    .filter((s) => s.buyEveryDays && s.dailyUse)
    .sort((a, b) => b.buyCount - a.buyCount)
    .slice(0, 3);
  for (const s of patterns) {
    const left = s.daysLeft != null ? (s.daysLeft > 0 ? ` At your current pace you have about ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left.` : " You're out — time to restock.") : "";
    push({
      insight_type: "pattern", item_name: s.name,
      message: `You buy ${s.name} roughly every ${s.buyEveryDays} days and use about ${Math.round((s.dailyUse || 0) * 7 * 10) / 10} ${s.unit}/week.${left}`,
      severity: "info",
    });
  }

  // 3) Smart purchase recommendations: flag list lines the pantry doesn't need yet.
  for (const row of shopping) {
    if (row.checked) continue;
    const match = pantry.find((p) => Number(p.id) === Number(row.linked_pantry_id)) || pantry.find((p) => wlNorm(p.name) === wlNorm(row.name));
    if (!match) continue;
    const s = stats.get(wlNorm(match.name));
    const qty = Number(match.quantity) || 0;
    const ample = s && s.dailyUse ? qty / s.dailyUse >= 10 : qty >= 3 && String(match.status) === "ok";
    if (!ample || assessPantryRisk(match)) continue;
    const lasts = s && s.dailyUse ? ` — your current ${qty} ${String(match.unit || "unit")} covers about ${Math.round(qty / s.dailyUse)} days` : ` — you still have ${qty} ${String(match.unit || "unit")}`;
    push({
      insight_type: "recommendation", item_name: String(row.name), shopping_item_id: Number(row.id), pantry_item_id: Number(match.id),
      message: `${String(row.name)} is on the list but you're well stocked${lasts}. Buying more now often ends up wasted.`,
      severity: "info",
    });
  }

  // 4) Savings estimate — only when there is a real number to show.
  if (monthlyWasteEstimate > 0) {
    push({
      insight_type: "savings", item_name: null,
      message: `If you used everything you bought this month, you'd keep about ${fmtN(monthlyWasteEstimate)} — that's what the "likely wasted" items above are worth.`,
      severity: "info", est_value_ngn: monthlyWasteEstimate,
    });
  }

  if (rows.length) await hdb("hh_wasteless_insights").bulkInsert(rows.slice(0, 12));
  return rows.length;
}

/* --------------------------- household settings -------------------------- */

async function loadHouseholdSettings(hid: number): Promise<HouseholdSettings | null> {
  try {
    const { data } = await hdb("household_settings").eq("household_id", hid).get();
    return (data?.[0] as unknown as HouseholdSettings) || null;
  } catch {
    return null;
  }
}

async function saveHouseholdCountry(hid: number, def: CountryDef): Promise<void> {
  const { data } = await hdb("household_settings").eq("household_id", hid).get();
  const existing = data?.[0];
  if (existing) {
    await hdb("household_settings").update(Number(existing.id), { country: def.country, currency_code: def.currency, currency_symbol: def.symbol });
  } else {
    await hdb("household_settings").insert({ household_id: hid, country: def.country, currency_code: def.currency, currency_symbol: def.symbol });
  }
  setActiveCurrency(def.currency, def.symbol);
}

/* ------------------------------ demo seeding ----------------------------- */

async function seedHousehold(hid: number, ownerName: string, currency = "NGN") {
  const month = monthKey();
  // Demo amounts that read sensibly in the chosen currency.
  const naira = currency === "NGN";
  await hdb("hh_inventory_items").bulkInsert([
    { household_id: hid, name: "Oat Milk", category: "pantry", subcategory: "dairy", quantity: 1, unit: "L", status: "warn", typical_days_to_deplete: 7, min_stock_level: 1, added_by: ownerName },
    { household_id: hid, name: "Fresh Eggs", category: "pantry", subcategory: "dairy", quantity: 0, unit: "dozen", status: "empty", typical_days_to_deplete: 9, min_stock_level: 1, added_by: ownerName },
    { household_id: hid, name: "Cooking Gas", category: "household", subcategory: "utility", quantity: 5, unit: "days", status: "warn", typical_days_to_deplete: 30, added_by: ownerName },
    { household_id: hid, name: "Jasmine Rice", category: "pantry", subcategory: "grain", quantity: 3, unit: "kg", status: "ok", typical_days_to_deplete: 30, min_stock_level: 1, added_by: ownerName },
    { household_id: hid, name: "Tomatoes", category: "pantry", subcategory: "produce", quantity: 6, unit: "unit", status: "ok", typical_days_to_deplete: 6, added_by: ownerName },
    { household_id: hid, name: "Washing Powder", category: "laundry", quantity: 1, unit: "pack", status: "ok", typical_days_to_deplete: 21, min_stock_level: 1, preferred_purchase_qty: 2, added_by: ownerName },
    { household_id: hid, name: "Toilet Paper", category: "household", quantity: 6, unit: "rolls", status: "ok", typical_days_to_deplete: 14, min_stock_level: 4, preferred_purchase_qty: 12, added_by: ownerName },
  ]);
  await hdb("hh_schedule_events").bulkInsert([
    { household_id: hid, title: "School Bus Pickup", notes: "Front Gate", starts_at: dayAt(7,30), category: "school", member_name: null, added_by: ownerName },
    { household_id: hid, title: "Grocery Delivery", notes: "Pre-paid", starts_at: dayAt(11,0), category: "delivery", member_name: null, added_by: ownerName },
  ]);
  await hdb("hh_bills").bulkInsert([
    { household_id: hid, name: "Electricity", amount_ngn: naira ? 12500 : 40, due_date: addDays(2), category: "utility", paid: false, assigned_to: null, added_by: ownerName },
    { household_id: hid, name: "Water", amount_ngn: naira ? 4200 : 15, due_date: addDays(8), category: "utility", paid: false, assigned_to: null, added_by: ownerName },
    { household_id: hid, name: "Internet", amount_ngn: naira ? 22000 : 60, due_date: addDays(12), category: "utility", paid: false, assigned_to: null, added_by: ownerName },
  ]);
  await hdb("hh_maintenance_tasks").bulkInsert([
    { household_id: hid, asset: "Generator", category: "appliance", last_serviced_at: addDays(-20), interval_days: 30, next_due_at: addDays(10), notes: "Change oil", added_by: ownerName },
    { household_id: hid, asset: "Water Tank Cleaning", category: "home", last_serviced_at: addDays(-150), interval_days: 180, next_due_at: addDays(30), notes: null, added_by: ownerName },
  ]);
  await hdb("hh_budgets").bulkInsert([
    { household_id: hid, month, category: "food", limit_ngn: naira ? 60000 : 400, spent_ngn: 0 },
    { household_id: hid, month, category: "utility", limit_ngn: naira ? 45000 : 150, spent_ngn: 0 },
    { household_id: hid, month, category: "maintenance", limit_ngn: naira ? 20000 : 80, spent_ngn: 0 },
  ]);
}

/* --------------------------------- AI bits ------------------------------- */

async function aiComplete(system: string, user: string, json = false): Promise<string> {
  const res = await fetch("/proxy/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      stream: false, ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error("AI unavailable");
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

/**
 * Role-aware household context for the AI. Rows keep their `added_by` field so
 * the assistant can attribute actions ("James added milk this morning").
 * Children/guests never receive bills or budget data.
 */
async function loadHouseholdContext(hid: number, member: Membership) {
  const restricted = member.role === "child" || member.role === "guest";
  try {
    const [members, inventory, shopping, events, tasks, meals, roomsRes, locsRes, ingRes, leftoverRes] = await Promise.all([
      hdb("household_memberships").eq("household_id", hid).eq("status", "active").get(),
      hdb("hh_inventory_items").eq("household_id", hid).limit(500).get(),
      hdb("hh_shopping_items").eq("household_id", hid).eq("checked", false).get(),
      hdb("hh_schedule_events").eq("household_id", hid).gte("starts_at", new Date().toISOString()).orderBy("starts_at","asc").limit(10).get(),
      // The SDK has no .is() null filter — fetch the household's tasks and keep the open ones below.
      hdb("hh_tasks").eq("household_id", hid).get(),
      hdb("hh_meal_plans").eq("household_id", hid).gte("date", localDateKey()).limit(21).get(),
      hdb("hh_rooms").eq("household_id", hid).get(),
      hdb("hh_storage_locations").eq("household_id", hid).get(),
      hdb("hh_meal_ingredients").eq("household_id", hid).eq("status", "committed").limit(500).get(),
      hdb("hh_leftovers").eq("household_id", hid).eq("status", "available").limit(30).get(),
    ]);
    const committedMap = committedByItem(ingRes.data || []);
    const myEmail = (member.email || "").toLowerCase();
    const visibleTasks = (tasks.data || []).filter((t) => {
      if (t.completed_at) return false; // open tasks only
      if (String(t.visibility) === "personal" && String(t.created_by_email || "").toLowerCase() !== myEmail && String(t.assignee_email || "").toLowerCase() !== myEmail) return false;
      if (member.role === "child") return String(t.assignee_name || "") === member.name || String(t.assignee_email || "").toLowerCase() === myEmail;
      return true;
    });
    // Spatial context: "Room · Storage place" per location id, so the assistant
    // can answer "where did we put X?" and "what's in the garage?" from data.
    const locsById = new Map<number, string>();
    (locsRes.data || []).forEach((l) => {
      const room = (roomsRes.data || []).find((r) => Number(r.id) === Number(l.room_id));
      locsById.set(Number(l.id), room ? `${String(room.name)} · ${String(l.name)}` : String(l.name));
    });
    const invSnapshot = (inventory.data || []).map((p) => {
      const st = computeItemStates(p as never, committedMap.get(Number(p.id)) || 0);
      return {
        name: p.name, category: invCatLabel(p.category),
        location: p.storage_location_id != null ? (locsById.get(Number(p.storage_location_id)) || null) : null,
        on_hand: st.onHand, unit: st.unit,
        committed_to_planned_meals: st.committed > 0 ? st.committed : undefined,
        projected_balance: st.committed > 0 ? st.projected : undefined,
        min_stock_level: st.minStock > 0 ? st.minStock : undefined,
        state: st.state,
        days_remaining: invDaysRemaining(p) ?? undefined,
        expires_at: p.expires_at || undefined,
        added_by: p.added_by,
      };
    });
    const parts = [
      `INVENTORY RULES (follow strictly): on_hand is what the household PHYSICALLY has; committed_to_planned_meals is reserved by upcoming planned meals but NOT consumed yet; projected_balance = on_hand − committed. NEVER describe committed stock as used/finished, NEVER say an item is out of stock unless on_hand is 0, and NEVER invent consumption — inventory only changes when the member confirms a meal, a purchase, waste or a correction. All quantity changes are recorded in an auditable ledger.`,
      `Members: ${JSON.stringify((members.data || []).map((m) => ({ name: m.name, role: m.role, relation: m.relation, dietary_notes: m.dietary_notes })))}`,
      `Rooms & storage (the household's spatial map — each room lists its storage places): ${JSON.stringify((roomsRes.data || []).map((r) => ({ room: r.name, locations: (locsRes.data || []).filter((l) => Number(l.room_id) === Number(r.id)).map((l) => String(l.name)) })))}`,
      `Inventory (EVERYTHING the household owns across ALL categories — food lives in category "Pantry". Use this list to answer "where is X?" (the location field reads "Room · Storage place"), "what do we have in the garage?" (match the location's room), "what's running low?" (state running_low or planned_shortage), "what expires this week?" (expires_at / state expiring_soon), and to build consolidated shopping lists across every category): ${JSON.stringify(invSnapshot)}`,
      `Leftovers (cooked food waiting to be used — suggest meals that use them before their use-by date): ${JSON.stringify((leftoverRes.data || []).map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, use_by: String(l.use_by || "").slice(0, 10) })))}`,
      `Shopping: ${JSON.stringify(shopping.data || [])}`,
      `Schedule: ${JSON.stringify(events.data || [])}`,
      `Tasks: ${JSON.stringify(visibleTasks)}`,
      `MealPlan: ${JSON.stringify(meals.data || [])}`,
    ];
    if (!restricted) {
      const [bills, maintenance, budgets] = await Promise.all([
        hdb("hh_bills").eq("household_id", hid).eq("paid", false).get(),
        hdb("hh_maintenance_tasks").eq("household_id", hid).get(),
        hdb("hh_budgets").eq("household_id", hid).get(),
      ]);
      parts.push(`Bills: ${JSON.stringify(bills.data || [])}`);
      parts.push(`Maintenance: ${JSON.stringify(maintenance.data || [])}`);
      parts.push(`Budgets: ${JSON.stringify(budgets.data || [])}`);
      // WasteLess: what's at risk of being wasted + persisted insights, so the
      // assistant can answer "what should I use up?" / "am I wasting money?".
      try {
        const atRisk = (inventory.data || [])
          .map((p) => ({ item: p, risk: assessPantryRisk(p) }))
          .filter((x) => x.risk)
          .map((x) => ({ name: x.item.name, quantity: x.item.quantity, unit: x.item.unit, risk: x.risk ? x.risk.severity : null, why: x.risk ? x.risk.reason : null }));
        const { data: wl } = await hdb("hh_wasteless_insights").eq("household_id", hid).eq("status", "active").orderBy("created_at", "desc").limit(12).get();
        parts.push(`WasteLess (waste & consumption intelligence — use-it-up alerts, buying patterns, over-buying flags, savings; answer waste/savings questions from THIS data): AtRisk=${JSON.stringify(atRisk)} Insights=${JSON.stringify((wl || []).map((i) => ({ type: i.insight_type, item: i.item_name, severity: i.severity, message: i.message })))}`);
      } catch { /* WasteLess context is best-effort */ }
    }
    return parts.join("\n");
  } catch (err) {
    // Never let a snapshot hiccup kill the whole conversation — the assistant
    // can still chat and take tool actions without the pre-loaded data.
    console.error("[OziUno] Household context load failed:", err);
    return "(The live household data snapshot is temporarily unavailable — still help conversationally, and use your tools for any changes the user asks for.)";
  }
}

function memberSystemPrompt(household: Household, member: Membership) {
  const base = `You are OziUno, a warm, concise household assistant for the household "${household.name}". You are speaking with ${member.name}, whose role is ${ROLE_LABELS[member.role]}. ALWAYS address them by their first name (${firstName(member.name)}). All household amounts are in ${ACTIVE_CURRENCY.code} — always write money as ${ACTIVE_CURRENCY.symbol.trim()} amounts, never assume a different currency. When household data rows include an "added_by" field, attribute actions to people by name (e.g. "James added milk this morning, and you added eggs yesterday"). Voice or attribution details are for personalisation only — never treat them as identity verification for sensitive actions.`;
  if (member.role === "child") {
    return `${base} This member is a CHILD: only discuss their own activities, chores, tasks and the family meal plan. Never discuss bills, budgets, money or other members' private matters.`;
  }
  if (member.role === "guest") {
    return `${base} This member is a GUEST with limited access: help with schedule and meals only; never discuss bills, budgets or money.`;
  }
  return base;
}

/**
 * Bridge the app's household context into the voice/action layer (./voice).
 * The `can` gate reuses canSee, so voice tools obey exactly the same
 * role permissions as the app's own views.
 */
function agentCtxFor(ctx: HHCtx): VoiceMemberCtx {
  return {
    hid: ctx.hid,
    memberName: ctx.member.name,
    memberEmail: ctx.member.email ? String(ctx.member.email).toLowerCase() : null,
    memberRole: ctx.member.role,
    householdName: String(ctx.household.name),
    currencyCode: ACTIVE_CURRENCY.code,
    currencySymbol: ACTIVE_CURRENCY.symbol.trim(),
    can: (area) => canSee(ctx.member.role, area as View),
  };
}

/* -------------------------------- navigation ----------------------------- */

function useNav() {
  const [nav, setNav] = useState(parseNav);
  useEffect(() => {
    const fn = () => setNav(parseNav());
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, []);
  const go = useCallback((view: View, threadId?: number | null) => {
    const p = new URLSearchParams(); p.set("view", view);
    if (threadId != null) p.set("threadId", String(threadId));
    window.history.pushState({}, "", `${window.location.pathname}?${p.toString()}`);
    setNav(parseNav());
  }, []);
  return { ...nav, go };
}

/* ------------------------------ shared layout ---------------------------- */

function PageShell({ eyebrow, title, subtitle, children, extra }: { eyebrow?: string; title: string; subtitle?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div style={{ maxWidth: title.length > 20 ? 960 : 768, margin: "0 auto", padding: "2rem 1rem" }}>
      <header style={{ marginBottom: "2rem", display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          {eyebrow && <p className="ozi-muted" style={{ fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 500 }}>{eyebrow}</p>}
          <h1 className="ozi-display" style={{ fontSize: "1.875rem", marginTop: eyebrow ? ".5rem" : 0 }}>{title}</h1>
          {subtitle && <p className="ozi-muted" style={{ fontSize: ".875rem", marginTop: ".25rem" }}>{subtitle}</p>}
        </div>
        {extra}
      </header>
      {children}
    </div>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`ozi-role-badge${role === "owner" ? " owner" : ""}`}>
      {role === "owner" && <Crown size={10} />} {ROLE_LABELS[role]}
    </span>
  );
}

function TrialPill({ daysLeft }: { daysLeft: number }) {
  return (
    <div style={{ padding: ".75rem 1rem", borderTop: "1px solid rgba(15,27,45,.08)" }}>
      <p className="ozi-muted" style={{ fontSize: 11, letterSpacing: "0.05em" }}>
        Free trial · {daysLeft} day{daysLeft === 1 ? "" : "s"} left
      </p>
    </div>
  );
}

function MemberPill({ member, household }: { member: Membership; household: Household }) {
  return (
    <div style={{ padding: ".75rem 1rem", borderTop: "1px solid rgba(15,27,45,.08)", display: "flex", alignItems: "center", gap: ".625rem" }}>
      <div style={{ width: 32, height: 32, borderRadius: 9999, background: "rgba(13,148,136,.1)", color: "#0d9488", display: "grid", placeItems: "center", flexShrink: 0 }}><User size={16} /></div>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: ".8125rem", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{member.name}</p>
        <p className="ozi-muted" style={{ fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ROLE_LABELS[member.role]} · {household.name}</p>
      </div>
    </div>
  );
}

function TopNav({ view, go, trialDaysLeft, member, household }: { view: View; go: (v: View, t?: number|null) => void; trialDaysLeft?: number | null; member: Membership; household: Household }) {
  const [open, setOpen] = useState(false);
  const navItems = NAV.filter((n) => canSee(member.role, n.view));
  const isActive = (v: View) => v === "dashboard" ? view === "dashboard" : view === v;
  const NavLinks = ({ onPick }: { onPick?: () => void }) => (
    <>
      {navItems.map(({ label, view: v, icon: Icon }) => (
        <button key={v} className={`ozi-nav-item${isActive(v) ? " active" : ""}`} onClick={() => { go(v); onPick?.(); }}>
          <Icon size={16} /> {label}
        </button>
      ))}
    </>
  );
  return (
    <>
      <aside className="ozi-sidebar">
        <button className="ozi-nav-item" style={{ padding: "1.25rem 1rem", cursor: "pointer" }} onClick={() => go("dashboard")}>
          <div className="ozi-primary" style={{ width: 32, height: 32, borderRadius: 12, display: "grid", placeItems: "center" }}><span className="ozi-display">O</span></div>
          <div><div className="ozi-display" style={{ fontSize: "1.125rem" }}>OziUno</div><div className="ozi-muted" style={{ fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase" }}>{household.name}</div></div>
        </button>
        <nav style={{ flex: 1, overflowY: "auto", padding: "0 .75rem 1rem" }}><NavLinks /></nav>
        <MemberPill member={member} household={household} />
        {trialDaysLeft != null && <TrialPill daysLeft={trialDaysLeft} />}
      </aside>
      <header className="ozi-mobile-header">
        <button aria-label="Menu" onClick={() => setOpen(true)} style={{ width: 36, height: 36, border: "none", background: "transparent", borderRadius: 8 }}><Menu size={20} /></button>
        <button onClick={() => go("dashboard")} style={{ display: "flex", alignItems: "center", gap: 8, border: "none", background: "transparent" }}>
          <div className="ozi-primary" style={{ width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center" }}><span className="ozi-display" style={{ fontSize: ".875rem" }}>O</span></div>
          <span className="ozi-display" style={{ fontSize: "1.125rem" }}>OziUno</span>
        </button>
        <span className="ozi-muted" style={{ marginLeft: "auto", fontSize: ".75rem" }}>{firstName(member.name)}</span>
      </header>
      {open && (
        <div className="ozi-drawer" onClick={() => setOpen(false)}>
          <div className="ozi-drawer-bg" />
          <aside className="ozi-drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: "1.25rem 1rem" }}>
              <span className="ozi-display" style={{ fontSize: "1.125rem" }}>OziUno</span>
              <p className="ozi-muted" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 2 }}>{household.name}</p>
            </div>
            <nav style={{ flex: 1, overflowY: "auto", padding: "0 .75rem 1rem" }}><NavLinks onPick={() => setOpen(false)} /></nav>
            <MemberPill member={member} household={household} />
            {trialDaysLeft != null && <TrialPill daysLeft={trialDaysLeft} />}
          </aside>
        </div>
      )}
    </>
  );
}

/* --------------------------- auth / household gate ----------------------- */

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: "3.5rem 1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: ".75rem", marginBottom: "2rem" }}>
        <div className="ozi-primary" style={{ width: 40, height: 40, borderRadius: 14, display: "grid", placeItems: "center" }}><span className="ozi-display" style={{ fontSize: "1.25rem" }}>O</span></div>
        <div>
          <p className="ozi-display" style={{ fontSize: "1.25rem" }}>OziUno</p>
          <p className="ozi-muted" style={{ fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase" }}>Your household operating system</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function SignInNotice() {
  return (
    <AuthShell>
      <h1 className="ozi-display" style={{ fontSize: "1.875rem" }}>Sign in to continue</h1>
      <p className="ozi-muted" style={{ fontSize: ".9375rem", marginTop: ".75rem", lineHeight: 1.6 }}>
        OziUno gives every family member their own individual login. Please sign in with your email
        (you'll get a one-time code) — then you can create your household or join an existing one.
      </p>
      <button className="ozi-btn" style={{ marginTop: "1.5rem" }} onClick={() => window.location.reload()}>
        <ArrowRight size={16} /> Reload to sign in
      </button>
    </AuthShell>
  );
}

function WelcomeChoice({ email, initialJoinCode, onCreated, onJoined }: {
  email: string;
  initialJoinCode: string;
  onCreated: () => void;
  onJoined: () => void;
}) {
  const [mode, setMode] = useState<"choice" | "create" | "join">(initialJoinCode ? "join" : "choice");
  if (mode === "create") return <CreateHouseholdFlow email={email} onDone={onCreated} onBack={() => setMode("choice")} />;
  if (mode === "join") return <JoinHouseholdFlow email={email} initialCode={initialJoinCode} onDone={onJoined} onBack={() => setMode("choice")} />;
  return (
    <AuthShell>
      <h1 className="ozi-display" style={{ fontSize: "2rem" }}>Welcome to OziUno</h1>
      <p className="ozi-muted" style={{ fontSize: ".9375rem", marginTop: ".5rem", marginBottom: "1.75rem", lineHeight: 1.6 }}>
        You're signed in as <strong style={{ color: "#0f1b2d" }}>{email}</strong>. OziUno is built around your
        <em> household</em> — one shared home that every family member joins with their own login.
      </p>
      <div style={{ display: "grid", gap: "1rem" }}>
        <button className="ozi-choice-card" onClick={() => setMode("create")}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(13,148,136,.1)", color: "#0d9488", display: "grid", placeItems: "center" }}><Home size={20} /></div>
          <p style={{ fontSize: "1.0625rem", fontWeight: 600 }}>Create your household</p>
          <p className="ozi-muted" style={{ fontSize: ".875rem" }}>Start fresh — name your household (e.g. "The Johnson Family"), become the Household Owner, and invite everyone else.</p>
        </button>
        <button className="ozi-choice-card" onClick={() => setMode("join")}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(56,189,248,.16)", color: "#0369a1", display: "grid", placeItems: "center" }}><UserPlus size={20} /></div>
          <p style={{ fontSize: "1.0625rem", fontWeight: 600 }}>Join an existing household</p>
          <p className="ozi-muted" style={{ fontSize: ".875rem" }}>Someone already set up your home on OziUno? Join with an email invitation, a household code, or a QR code.</p>
        </button>
      </div>
    </AuthShell>
  );
}

function CreateHouseholdFlow({ email, onDone, onBack }: { email: string; onDone: () => void; onBack: () => void }) {
  const [yourName, setYourName] = useState("");
  const [hhName, setHhName] = useState("");
  const [countryCode, setCountryCode] = useState("NG");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Returning users: pre-fill their name from any earlier membership row so
  // they never have to retype it.
  useEffect(() => {
    void (async () => {
      try {
        const known = lastKnownName(await membershipsForEmail(email));
        if (known) setYourName((prev) => prev || known);
      } catch { /* prefill is best-effort */ }
    })();
  }, [email]);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!yourName.trim() || !hhName.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const account = getAccount();
      // Guard: if this email is already an active member of a household (e.g.
      // this screen was reached after a transient lookup failure), never
      // create a second household — re-resolve into the existing one instead.
      const already = activeMembership(await membershipsForEmail(email));
      if (already) { onDone(); return; }
      let code = makeHouseholdCode(hhName);
      for (let i = 0; i < 5; i++) {
        const { data: clash } = await hdb("households").eq("household_code", code).get();
        if (!clash?.length) break;
        code = makeHouseholdCode(hhName);
      }
      const inserted = await hdb("households").insert({
        name: hhName.trim(), household_code: code, owner_email: email, owner_name: yourName.trim(),
        adults: 1, children: 0, family_size: 1, monthly_food_budget_ngn: 0,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", onboarded: false,
      });
      let hid = insertedId(inserted);
      if (!hid) {
        // insert() didn't hand back the row — recover it via its unique code.
        const { data: lookup } = await hdb("households").eq("household_code", code).get();
        hid = Number(lookup?.[0]?.id) || 0;
      }
      if (!hid) throw new Error("Could not determine the new household's id");
      await hdb("household_memberships").insert({
        household_id: hid, name: yourName.trim(), email, role: "owner", relation: null,
        status: "active", invited_by: null, joined_at: new Date().toISOString(),
        account_session_id: account.sessionId,
      });
      const def = countryByCode(countryCode);
      try { await saveHouseholdCountry(hid, def); } catch (settingsErr) { console.warn("[OziUno] Saving country failed:", settingsErr); }
      try { await seedHousehold(hid, yourName.trim(), def.currency); } catch (seedErr) { console.warn("[OziUno] Demo seed failed:", seedErr); }
      onDone();
    } catch (err) {
      console.error("[OziUno] Create household failed:", err);
      setError("We couldn't create your household. Please try again.");
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <button className="ozi-btn-ghost ozi-btn" onClick={onBack} style={{ marginBottom: "1.5rem" }}>← Back</button>
      <h1 className="ozi-display" style={{ fontSize: "2rem" }}>Create your household</h1>
      <p className="ozi-muted" style={{ fontSize: ".9375rem", marginTop: ".5rem", lineHeight: 1.6 }}>
        You'll become the <strong style={{ color: "#0369a1" }}>Household Owner</strong> with full control —
        you can then invite family members and choose what each person can see and do.
      </p>
      <form onSubmit={create} style={{ display: "grid", gap: "1rem", marginTop: "1.5rem" }}>
        <div>
          <label className="ozi-muted" style={{ fontSize: ".75rem", fontWeight: 500 }}>Your name</label>
          <input value={yourName} onChange={(e) => setYourName(e.target.value)} placeholder="e.g. Sarah Johnson" className="ozi-input" style={{ marginTop: ".375rem" }} />
        </div>
        <div>
          <label className="ozi-muted" style={{ fontSize: ".75rem", fontWeight: 500 }}>Household name</label>
          <input value={hhName} onChange={(e) => setHhName(e.target.value)} placeholder='e.g. The Johnson Family' className="ozi-input" style={{ marginTop: ".375rem" }} />
        </div>
        <div>
          <label className="ozi-muted" style={{ fontSize: ".75rem", fontWeight: 500 }}>Country</label>
          <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} className="ozi-input" style={{ marginTop: ".375rem" }}>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.country} ({c.currency} {c.symbol.trim()})</option>)}
          </select>
          <p className="ozi-muted" style={{ fontSize: ".75rem", marginTop: ".375rem" }}>Sets the currency for your household's bills, budgets and shopping. You can change it later in Family.</p>
        </div>
        {error && <p role="alert" style={{ color: "#dc2626", fontSize: ".875rem" }}>{error}</p>}
        <button type="submit" disabled={busy || !yourName.trim() || !hhName.trim()} className="ozi-btn" style={{ justifyContent: "center" }}>
          {busy ? "Creating your household…" : "Create household & become Owner"}
        </button>
      </form>
    </AuthShell>
  );
}

function JoinHouseholdFlow({ email, initialCode, onDone, onBack }: { email: string; initialCode: string; onDone: () => void; onBack: () => void }) {
  const [code, setCode] = useState(initialCode);
  const [yourName, setYourName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<Household | null>(null);
  const [foundInvite, setFoundInvite] = useState<Membership | null>(null);

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault();
    const c = code.toUpperCase().trim();
    if (!c || busy) return;
    setBusy(true); setError(""); setFound(null); setFoundInvite(null);
    try {
      const { data } = await hdb("households").eq("household_code", c).get();
      const hh = data?.[0] as Household | undefined;
      if (!hh) { setError("No household found with that code. Double-check it and try again."); return; }
      const mine = await membershipsForEmail(email, Number(hh.id));
      if (activeMembership(mine)) {
        // Already a member of this household (e.g. re-opened the invite link
        // or re-scanned the QR code) — no name prompt, no new row: go in.
        onDone();
        return;
      }
      const invite = mine.find((m) => String(m.status) === "invited");
      setFound(hh);
      if (invite) { setFoundInvite(invite); setYourName(String(invite.name || "")); }
      else {
        const known = lastKnownName(mine) || lastKnownName(await membershipsForEmail(email));
        setYourName((prev) => prev || known || firstName(email.split("@")[0]));
      }
    } catch (err) {
      console.error("[OziUno] Household code lookup failed:", err);
      setError("Something went wrong looking up that code. Please try again.");
    } finally { setBusy(false); }
  };

  const confirmJoin = async () => {
    if (!found || !yourName.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const account = getAccount();
      // Re-check right before writing so repeated logins can never add a
      // second row for the same person: if a row already exists for this
      // email + household (invited, removed, …), reactivate it instead of
      // inserting a duplicate.
      const mine = await membershipsForEmail(email, Number(found.id));
      if (activeMembership(mine)) { onDone(); return; }
      const reusable = foundInvite || mine.find((m) => String(m.status) === "invited") || mine[mine.length - 1];
      if (reusable) {
        await hdb("household_memberships").update(Number(reusable.id), {
          status: "active", name: yourName.trim(), joined_at: new Date().toISOString(), account_session_id: account.sessionId,
        });
      } else {
        await hdb("household_memberships").insert({
          household_id: Number(found.id), name: yourName.trim(), email, role: "adult", relation: null,
          status: "active", invited_by: null, joined_at: new Date().toISOString(), account_session_id: account.sessionId,
        });
      }
      onDone();
    } catch (err) {
      console.error("[OziUno] Join household failed:", err);
      setError("We couldn't link you to that household. Please try again.");
      setBusy(false);
    }
  };

  // Auto-look up when arriving from an invite link (?join=CODE).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialCode) void lookup(); }, []);

  return (
    <AuthShell>
      <button className="ozi-btn-ghost ozi-btn" onClick={onBack} style={{ marginBottom: "1.5rem" }}>← Back</button>
      <h1 className="ozi-display" style={{ fontSize: "2rem" }}>Join a household</h1>
      <p className="ozi-muted" style={{ fontSize: ".9375rem", marginTop: ".5rem", marginBottom: "1.5rem", lineHeight: 1.6 }}>Three ways to get linked to your family's home on OziUno.</p>

      {found ? (
        <div className="ozi-card" style={{ display: "grid", gap: "1rem" }}>
          <p style={{ fontSize: "1.0625rem" }}>
            Join <strong>{String(found.name)}</strong>{foundInvite ? <> as <strong>{ROLE_LABELS[(foundInvite.role as Role) || "adult"]}</strong> (invited by {String(foundInvite.invited_by || "the Household Owner")})</> : " as an Adult member"}?
          </p>
          <div>
            <label className="ozi-muted" style={{ fontSize: ".75rem", fontWeight: 500 }}>Your name</label>
            <input value={yourName} onChange={(e) => setYourName(e.target.value)} placeholder="Your name" className="ozi-input" style={{ marginTop: ".375rem" }} />
          </div>
          {error && <p role="alert" style={{ color: "#dc2626", fontSize: ".875rem" }}>{error}</p>}
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
            <button className="ozi-btn" disabled={busy || !yourName.trim()} onClick={confirmJoin}><Check size={16} /> {busy ? "Joining…" : `Join ${String(found.name)}`}</button>
            <button className="ozi-btn ozi-btn-ghost" disabled={busy} onClick={() => { setFound(null); setFoundInvite(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          <div className="ozi-option-card">
            <p style={{ fontSize: ".875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: ".5rem" }}><KeyRound size={16} color="#0d9488" /> Option 1 — Household code</p>
            <p className="ozi-muted" style={{ fontSize: ".8125rem" }}>Ask the Household Owner for the short code (it looks like <span style={{ fontFamily: "monospace" }}>JOHNSON-4827</span>).</p>
            <form onSubmit={lookup} style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. JOHNSON-4827" className="ozi-input" style={{ flex: 1, minWidth: 180, fontFamily: "monospace", letterSpacing: ".05em" }} />
              <button type="submit" className="ozi-btn" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Find household"}</button>
            </form>
            {error && <p role="alert" style={{ color: "#dc2626", fontSize: ".8125rem" }}>{error}</p>}
          </div>
          <div className="ozi-option-card">
            <p style={{ fontSize: ".875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: ".5rem" }}><Mail size={16} color="#0d9488" /> Option 2 — Email invitation</p>
            <p className="ozi-muted" style={{ fontSize: ".8125rem" }}>
              If someone invited <strong>{email}</strong> by email, you'd be linked automatically the moment you signed in.
              No invite showed up for this address — check you signed in with the exact email that was invited, or use the household code instead.
            </p>
          </div>
          <div className="ozi-option-card">
            <p style={{ fontSize: ".875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: ".5rem" }}><QrCode size={16} color="#0d9488" /> Option 3 — QR code</p>
            <p className="ozi-muted" style={{ fontSize: ".8125rem" }}>
              Ask the Household Owner to open their <strong>Family</strong> screen — it shows the household's QR code.
              Scan it with your phone camera: it opens OziUno with the household code already filled in, so you just
              sign in and confirm.
            </p>
          </div>
        </div>
      )}
    </AuthShell>
  );
}

function InviteAccept({ invites, onAccepted, onCreateInstead }: {
  invites: { membership: Membership; household: Household }[];
  onAccepted: () => void;
  onCreateInstead: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accept = async (invite: { membership: Membership; household: Household }) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const account = getAccount();
      await hdb("household_memberships").update(Number(invite.membership.id), {
        status: "active", joined_at: new Date().toISOString(), account_session_id: account.sessionId,
      });
      onAccepted();
    } catch (err) {
      console.error("[OziUno] Accept invite failed:", err);
      setError("We couldn't accept that invitation. Please try again.");
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <h1 className="ozi-display" style={{ fontSize: "2rem" }}>You've been invited</h1>
      <p className="ozi-muted" style={{ fontSize: ".9375rem", marginTop: ".5rem", marginBottom: "1.5rem" }}>Accept an invitation to join your family's household — everything they've set up will be waiting for you.</p>
      <div style={{ display: "grid", gap: "1rem" }}>
        {invites.map((inv) => (
          <div key={String(inv.membership.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: "1.0625rem", fontWeight: 600 }}>{String(inv.household.name)}</p>
              <p className="ozi-muted" style={{ fontSize: ".8125rem" }}>
                Invited by {String(inv.membership.invited_by || "the Household Owner")} · joining as <RoleBadge role={(inv.membership.role as Role) || "adult"} />
              </p>
            </div>
            <button className="ozi-btn" disabled={busy} onClick={() => accept(inv)}><Check size={16} /> {busy ? "Joining…" : "Accept & join"}</button>
          </div>
        ))}
      </div>
      {error && <p role="alert" style={{ color: "#dc2626", fontSize: ".875rem", marginTop: "1rem" }}>{error}</p>}
      <button className="ozi-btn ozi-btn-ghost" style={{ marginTop: "1.5rem" }} disabled={busy} onClick={onCreateInstead}>
        Or create / join a different household
      </button>
    </AuthShell>
  );
}

/* ------------------------- household setup (owner) ----------------------- */

function OnboardingView({ ctx, onComplete }: { ctx: HHCtx; onComplete: () => void }) {
  const { household } = ctx;
  const [adults, setAdults] = useState(Number(household.adults ?? 2));
  const [children, setChildren] = useState(Number(household.children ?? 0));
  const [countryCode, setCountryCode] = useState(ctx.settings?.country ? countryByName(ctx.settings.country).code : "NG");
  const selectedCountry = countryByCode(countryCode);
  const [foodBudget, setFoodBudget] = useState(String(household.monthly_food_budget_ngn || (ctx.settings && ctx.settings.currency_code !== "NGN" ? 400 : 60000)));
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const finish = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setSubmitError("");
    try {
      await saveHouseholdCountry(ctx.hid, selectedCountry);
      await hdb("households").update(ctx.hid, {
        adults, children, family_size: adults + children,
        monthly_food_budget_ngn: Number(foodBudget) || 0, onboarded: true,
      });
      onComplete();
    } catch (error) {
      console.error("[OziUno] Household setup failed:", error);
      setSubmitError("We couldn't save your household setup. Please try again.");
    } finally { setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 512, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1 className="ozi-display" style={{ fontSize: "2rem" }}>Set up {String(household.name)}</h1>
      <p className="ozi-muted" style={{ fontSize: ".875rem", marginTop: ".5rem" }}>These details apply to the whole household — every member you invite shares them.</p>
      <form onSubmit={finish} style={{ display: "grid", gap: "1rem", marginTop: "1.5rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".75rem" }}>
          <div>
            <label className="ozi-muted" style={{ fontSize: ".75rem" }}>Adults</label>
            <input type="number" min={0} value={adults} onChange={(e) => setAdults(Number(e.target.value)||0)} className="ozi-input" style={{ marginTop: ".25rem" }} />
          </div>
          <div>
            <label className="ozi-muted" style={{ fontSize: ".75rem" }}>Children</label>
            <input type="number" min={0} value={children} onChange={(e) => setChildren(Number(e.target.value)||0)} className="ozi-input" style={{ marginTop: ".25rem" }} />
          </div>
        </div>
        <div>
          <label className="ozi-muted" style={{ fontSize: ".75rem" }}>Country & currency</label>
          <select value={countryCode} onChange={(e) => setCountryCode(e.target.value)} className="ozi-input" style={{ marginTop: ".25rem" }}>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.country} ({c.currency} {c.symbol.trim()})</option>)}
          </select>
        </div>
        <div>
          <label className="ozi-muted" style={{ fontSize: ".75rem" }}>Monthly food budget ({selectedCountry.symbol.trim()})</label>
          <input type="number" min={0} value={foodBudget} onChange={(e) => setFoodBudget(e.target.value)} className="ozi-input" style={{ marginTop: ".25rem" }} />
        </div>
        {submitError && <p role="alert" style={{ color: "#dc2626", fontSize: ".875rem" }}>{submitError}</p>}
        <button type="submit" disabled={busy} className="ozi-btn" style={{ justifyContent: "center" }}>{busy ? "Saving…" : "Enter OziUno"}</button>
      </form>
    </div>
  );
}

/* --------------------------------- views --------------------------------- */

/**
 * Meal check-ins — the ONLY bridge from planned to actual consumption
 * (Section 11). After a planned meal's slot passes, OziUno asks
 * "Did you have [meal]?" with four low-friction outcomes:
 *   Yes → consumption transactions for the scaled ingredients
 *   No → nothing deducted, commitments released
 *   Partly → percentage-based partial consumption + optional leftover record
 *   Different meal → the ACTUAL dish's ingredients are consumed instead
 * Nothing is ever deducted without one of these confirmations.
 */
function MealCheckins({ ctx, onChanged, compact }: { ctx: HHCtx; onChanged?: () => void; compact?: boolean }) {
  const { hid, member } = ctx;
  const { data: meals, refresh: rMeals } = window.useWorkspaceDB("hh_meal_plans", { shared: true, filters: hhFilter(hid), orderBy: { column: "date", direction: "desc" }, limit: 200 });
  const { data: inv, refresh: rInv } = window.useWorkspaceDB("hh_inventory_items", { shared: true, filters: hhFilter(hid), limit: 500 });
  const pending = useMemo(() => pendingCheckins(meals ?? []), [meals]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [mode, setMode] = useState<"partial" | "different" | null>(null);
  const [fraction, setFraction] = useState(0.5);
  const [leftName, setLeftName] = useState("");
  const [leftQty, setLeftQty] = useState("");
  const [leftUnit, setLeftUnit] = useState("g");
  const [altTitle, setAltTitle] = useState("");
  const [notice, setNotice] = useState("");

  const shown = compact ? pending.slice(0, 1) : pending;
  if (!shown.length && !notice) return null;

  /** Committed ingredient rows for a meal — generated on the spot when the
   * commitment builder hasn't covered this meal yet. */
  const loadIngredients = async (meal: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const mid = Number(meal.id);
    const fetchRows = async () => {
      const { data } = await hdb("hh_meal_ingredients").eq("household_id", hid).eq("meal_plan_id", mid).get();
      return data ?? [];
    };
    let rows = await fetchRows();
    if (!rows.length) {
      await ensureMealCommitments(hid, ctx.household);
      rows = await fetchRows();
    }
    return rows.filter((r) => String(r.status || "committed") === "committed" && String(r.name) !== NO_INGREDIENTS_MARKER);
  };

  const finish = (msg: string) => {
    setNotice(msg); setExpandedId(null); setMode(null); setAltTitle("");
    rMeals(); rInv(); onChanged?.();
    try { window.dispatchEvent(new CustomEvent("ozi:data-changed")); } catch { /* ignore */ }
  };

  const answer = async (meal: Record<string, unknown>, outcome: Parameters<typeof confirmMealOutcome>[4]) => {
    const mid = Number(meal.id);
    if (busyId) return;
    setBusyId(mid); setNotice("");
    try {
      const ingredients = await loadIngredients(meal);
      const res = await confirmMealOutcome(hid, meal, ingredients, inv ?? [], outcome, member.name);
      if (outcome.kind === "no") finish(`Noted — ${String(meal.title)} was skipped. Nothing was deducted from your inventory.`);
      else if (outcome.kind === "partial") finish(`Recorded. ${res.consumed.length ? `Used: ${res.consumed.join(", ")}.` : "No tracked ingredients were deducted."}${res.leftovers.length ? ` Leftover saved: ${res.leftovers.join(", ")} (use within ${LEFTOVER_USE_BY_DAYS} days).` : ""}`);
      else if (outcome.kind === "different") finish(`Got it — recorded ${outcome.replacementTitle} instead. ${res.consumed.length ? `Used: ${res.consumed.join(", ")}.` : ""}`);
      else finish(`Enjoy! ${res.consumed.length ? `Inventory updated from the ledger: ${res.consumed.join(", ")}.` : "This meal used no tracked inventory items."}`);
    } catch (err) {
      console.error("[OziUno] Meal check-in failed:", err);
      setNotice("That didn't save — please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const openPartial = async (meal: Record<string, unknown>) => {
    setExpandedId(Number(meal.id)); setMode("partial"); setFraction(0.5);
    setLeftName(`Leftover ${String(meal.title)}`); setLeftQty(""); setLeftUnit("g");
  };

  const submitDifferent = async (meal: Record<string, unknown>) => {
    const title = altTitle.trim();
    if (!title || busyId) return;
    setBusyId(Number(meal.id));
    try {
      const { data: prefs } = await hdb("hh_ingredient_prefs").eq("household_id", hid).limit(200).get();
      const country = ctx.settings?.country || "Nigeria";
      const extracted = await extractIngredientsForMeals([{ id: meal.id, title, meal: meal.meal, recipe_md: "" }], prefs ?? [], country);
      const servings = servingsForMeal(ctx.household, [], meal);
      const scaled = (extracted.get(Number(meal.id)) ?? []).filter((i) => !i.optional).map((i) => ({
        name: i.name, ingredient_key: i.ingredient_key,
        required_qty: scaleIngredientQty(i.quantity, DEFAULT_RECIPE_YIELD, servings), unit: i.unit,
      }));
      setBusyId(null);
      await answer(meal, { kind: "different", replacementTitle: title, ingredients: scaled });
    } catch (err) {
      console.error("[OziUno] Replacement meal failed:", err);
      setNotice("Couldn't work out that dish — please try again.");
      setBusyId(null);
    }
  };

  return (
    <div style={{ marginBottom: "1rem" }}>
      {notice && <p role="status" style={{ fontSize: ".8125rem", marginBottom: ".5rem", color: "#0d9488" }}>{notice}</p>}
      {shown.map((meal) => {
        const mid = Number(meal.id);
        const isOpen = expandedId === mid;
        const busy = busyId === mid;
        const dateLabel = new Date(String(meal.date).slice(0, 10)).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
        return (
          <div key={mid} className="ozi-card" style={{ borderLeft: "3px solid #0d9488", marginBottom: ".5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: ".75rem", flexWrap: "wrap" }}>
              <ChefHat size={18} style={{ color: "#0d9488", flexShrink: 0 }} />
              <p style={{ flex: 1, fontSize: ".875rem", margin: 0, minWidth: 180 }}>
                Did you have <b>{String(meal.title)}</b>? <span className="ozi-muted">({String(meal.meal)}, {dateLabel})</span>
              </p>
              {!isOpen && (
                <span style={{ display: "inline-flex", gap: ".375rem", flexWrap: "wrap" }}>
                  <button className="ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busy} onClick={() => void answer(meal, { kind: "yes" })}><Check size={13} /> Yes</button>
                  <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busy} onClick={() => void answer(meal, { kind: "no" })}><X size={13} /> No</button>
                  <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busy} onClick={() => void openPartial(meal)}>Partly</button>
                  <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busy} onClick={() => { setExpandedId(mid); setMode("different"); setAltTitle(""); }}>Different meal</button>
                </span>
              )}
            </div>
            {isOpen && mode === "partial" && (
              <div style={{ marginTop: ".75rem", display: "grid", gap: ".5rem" }}>
                <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>How much of it was eaten?</p>
                <div style={{ display: "flex", gap: ".375rem", flexWrap: "wrap" }}>
                  {[0.25, 0.5, 0.75].map((f) => (
                    <button key={f} className={fraction === f ? "ozi-btn" : "ozi-btn-ghost ozi-btn"} style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} onClick={() => setFraction(f)}>{Math.round(f * 100)}%</button>
                  ))}
                </div>
                <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>Keep a leftover? (optional — gets a {LEFTOVER_USE_BY_DAYS}-day use-by reminder)</p>
                <div style={{ display: "flex", gap: ".375rem", flexWrap: "wrap" }}>
                  <input value={leftName} onChange={(e) => setLeftName(e.target.value)} placeholder="e.g. Cooked rice" className="ozi-input" style={{ flex: 2, minWidth: 140 }} />
                  <input value={leftQty} onChange={(e) => setLeftQty(e.target.value)} type="number" min={0} step="any" placeholder="Amount" className="ozi-input" style={{ width: 90 }} />
                  <input value={leftUnit} onChange={(e) => setLeftUnit(e.target.value)} placeholder="g / portions" className="ozi-input" style={{ width: 100 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: ".5rem" }}>
                  <button className="ozi-muted" style={{ border: "none", background: "transparent", cursor: "pointer" }} onClick={() => { setExpandedId(null); setMode(null); }}>Cancel</button>
                  <button className="ozi-btn" style={{ fontSize: ".75rem" }} disabled={busy} onClick={() => void answer(meal, {
                    kind: "partial", fraction,
                    leftovers: Number(leftQty) > 0 ? [{ name: leftName.trim() || `Leftover ${String(meal.title)}`, qty: Number(leftQty), unit: leftUnit.trim() || "g" }] : [],
                  })}><Check size={13} /> Save</button>
                </div>
              </div>
            )}
            {isOpen && mode === "different" && (
              <form style={{ marginTop: ".75rem", display: "flex", gap: ".5rem", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); void submitDifferent(meal); }}>
                <input autoFocus value={altTitle} onChange={(e) => setAltTitle(e.target.value)} placeholder="What did you have instead? e.g. Beans and plantain" className="ozi-input" style={{ flex: 1, minWidth: 200 }} />
                <button type="button" className="ozi-muted" style={{ border: "none", background: "transparent", cursor: "pointer" }} onClick={() => { setExpandedId(null); setMode(null); }}>Cancel</button>
                <button type="submit" className="ozi-btn" style={{ fontSize: ".75rem" }} disabled={busy || !altTitle.trim()}>{busy ? "Recording…" : "Record it"}</button>
              </form>
            )}
          </div>
        );
      })}
      {compact && pending.length > 1 && (
        <p className="ozi-muted" style={{ fontSize: ".6875rem", margin: 0 }}>{pending.length - 1} more meal{pending.length - 1 === 1 ? "" : "s"} to confirm — see Meals.</p>
      )}
    </div>
  );
}

/** Available leftovers with use-by reminders — feeds tomorrow's plan instead
 * of the bin ("You have 500 g leftover rice. Include it in tomorrow's plan?"). */
function LeftoversPanel({ ctx, onChanged }: { ctx: HHCtx; onChanged?: () => void }) {
  const { hid, member } = ctx;
  const { data, refresh } = window.useWorkspaceDB("hh_leftovers", { shared: true, filters: [...hhFilter(hid), { column: "status", operator: "eq", value: "available" }], orderBy: { column: "use_by", direction: "asc" }, limit: 30 });
  const [notice, setNotice] = useState("");
  const rows = data ?? [];
  if (!rows.length && !notice) return null;
  const resolve = async (row: Record<string, unknown>, status: "used" | "wasted", msg: string) => {
    await hdb("hh_leftovers").update(Number(row.id), { status });
    setNotice(msg); refresh(); onChanged?.();
  };
  const planIt = async (row: Record<string, unknown>) => {
    const { data: planned } = await hdb("hh_meal_plans").eq("household_id", hid).gte("date", localDateKey()).get();
    const taken = new Set((planned ?? []).map((m) => `${String(m.date).slice(0, 10)}|${String(m.meal)}`));
    let slot: { date: string; meal: string } | null = null;
    for (let d = 0; d < 3 && !slot; d++) {
      const date = localDateKey(new Date(Date.now() + d * 86400000));
      for (const meal of ["dinner", "lunch", "breakfast"]) {
        if (!taken.has(`${date}|${meal}`)) { slot = { date, meal }; break; }
      }
    }
    if (!slot) { setNotice("The next 3 days are fully planned — swap a meal for it in Meals."); return; }
    await hdb("hh_meal_plans").insert({ household_id: hid, date: slot.date, meal: slot.meal, title: `Use up: ${String(row.name)}`, recipe_md: `Uses the leftover ${String(row.name)} (${Number(row.qty) || ""} ${String(row.unit || "")}) before its use-by date.`, added_by: member.name });
    setNotice(`Planned "${String(row.name)}" into ${slot.meal} on ${slot.date}.`);
    onChanged?.();
  };
  return (
    <div style={{ marginBottom: "1rem" }}>
      {notice && <p role="status" style={{ fontSize: ".8125rem", marginBottom: ".5rem", color: "#0d9488" }}>{notice}</p>}
      {rows.map((row) => {
        const useBy = String(row.use_by || "").slice(0, 10);
        const daysLeft = useBy ? Math.round((new Date(useBy).getTime() - new Date(localDateKey()).getTime()) / 86400000) : null;
        return (
          <div key={String(row.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".75rem", flexWrap: "wrap", marginBottom: ".5rem", borderLeft: "3px solid #f59e0b" }}>
            <Leaf size={16} style={{ color: "#b45309", flexShrink: 0 }} />
            <p style={{ flex: 1, fontSize: ".8125rem", margin: 0, minWidth: 180 }}>
              Leftover: <b>{String(row.name)}</b>{Number(row.qty) > 0 ? ` — ${Number(row.qty)} ${String(row.unit || "")}` : ""}
              {daysLeft !== null ? <span className="ozi-muted"> · use within {Math.max(0, daysLeft)} day{daysLeft === 1 ? "" : "s"}</span> : null}
            </p>
            <span style={{ display: "inline-flex", gap: ".375rem", flexWrap: "wrap" }}>
              <button className="ozi-btn" style={{ fontSize: ".7rem", padding: ".25rem .6rem" }} onClick={() => void planIt(row)}><ChefHat size={12} /> Plan it</button>
              <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".7rem", padding: ".25rem .6rem" }} onClick={() => void resolve(row, "used", `Nice — ${String(row.name)} eaten, nothing wasted.`)}><Check size={12} /> Eaten</button>
              <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".7rem", padding: ".25rem .6rem" }} onClick={() => void resolve(row, "wasted", `${String(row.name)} marked as wasted.`)}><Trash2 size={12} /> Binned</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DashboardView({ ctx }: { ctx: HHCtx }) {
  const { hid, member, go } = ctx;
  const { data: pantry } = window.useWorkspaceDB("hh_inventory_items", { shared: true, filters: hhFilter(hid), orderBy: { column: "name", direction: "asc" }, limit: 500 });
  const { data: bills, refresh: rBills } = window.useWorkspaceDB("hh_bills", { shared: true, filters: hhFilter(hid), orderBy: { column: "due_date", direction: "asc" } });
  // Only today-onwards events — past ones never reach the dashboard board.
  const { data: events } = window.useWorkspaceDB("hh_schedule_events", { shared: true, filters: [...hhFilter(hid), { column: "starts_at", operator: "gte", value: localDateKey() }], orderBy: { column: "starts_at", direction: "asc" } });
  const { data: tasks } = window.useWorkspaceDB("hh_tasks", { shared: true, filters: hhFilter(hid), orderBy: { column: "due_at", direction: "asc" } });
  const [value, setValue] = useState("");
  const [now, setNow] = useState(() => new Date());
  const today = localDateKey(now);
  const { data: todayMeals } = window.useWorkspaceDB("hh_meal_plans", {
    shared: true,
    filters: [...hhFilter(hid), { column: "date", operator: "eq", value: today }],
    orderBy: { column: "meal", direction: "asc" },
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const hour = now.getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const mealPeriod = hour < 12 ? "breakfast" : hour < 17 ? "lunch" : "dinner";
  const mealPeriodLabel = mealPeriod.charAt(0).toUpperCase() + mealPeriod.slice(1);
  const currentMenuItem = todayMeals?.find((meal) => String(meal.meal).toLowerCase() === mealPeriod);
  const startThread = async (title: string, spoken = false) => {
    // Chat threads stay PERSONAL (session-scoped) — each member has their own conversations.
    const inserted = await db().from("chat_threads").insert({ title: title.slice(0, 60) || "New conversation" });
    let tid = insertedId(inserted);
    if (!tid) {
      // insert() didn't hand back the row — the newest session-scoped thread is ours.
      const { data: latest } = await db().from("chat_threads").orderBy("created_at", "desc").limit(1).get();
      tid = Number(latest?.[0]?.id) || 0;
    }
    if (tid) {
      stashPendingChatMessage(tid, title, spoken);
      go("chat", tid);
    }
  };
  const isChild = member.role === "child";
  const myEmail = (member.email || "").toLowerCase();
  const visibleEvents = (events ?? []).filter((ev) => !isChild || !ev.member_name || String(ev.member_name) === member.name);
  // Upcoming only: an event drops off the board the moment its start time
  // passes (the `now` minute-ticker keeps this live without a reload).
  const upcoming = visibleEvents
    .filter((ev) => {
      const t = new Date(String(ev.starts_at)).getTime();
      return Number.isFinite(t) && t >= now.getTime();
    })
    .slice(0, 4);
  const myTasks = (tasks ?? []).filter((t) => !t.completed_at && (String(t.assignee_name || "") === member.name || String(t.assignee_email || "").toLowerCase() === myEmail));
  const nextBill = bills?.find((b) => !b.paid);
  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 className="ozi-display" style={{ fontSize: "2rem", marginBottom: ".25rem" }}>{timeGreeting}, {firstName(member.name)}.</h1>
      <p className="ozi-muted" style={{ fontSize: ".875rem", marginBottom: "1rem" }}>Here's what's happening in {String(ctx.household.name)} today.</p>
      <form onSubmit={(e) => { e.preventDefault(); const t = value.trim(); if (t) { setValue(""); startThread(t); } }} style={{ marginBottom: "1.5rem", display: "flex", gap: ".5rem", alignItems: "center" }}>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ask or say anything to OziUno…" className="ozi-input" style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("ozi:open-voice"))}
          aria-label="Talk to OziUno — open the voice assistant"
          title="Talk to OziUno"
          style={{ width: 44, height: 44, borderRadius: 9999, flexShrink: 0, border: "none", cursor: "pointer", color: "#f8fafc", background: "radial-gradient(circle at 30% 30%, #2dd4bf, #0d9488)", boxShadow: "0 4px 14px rgba(13,148,136,.35)", display: "grid", placeItems: "center" }}
        >
          <Mic size={19} />
        </button>
      </form>
      <MealCheckins ctx={ctx} compact />
      <LeftoversPanel ctx={ctx} />
      {member.role === "owner" && (pantry ?? []).some((p) => invIsLow(p)) && (() => {
        const lowItems = (pantry ?? []).filter((p) => invIsLow(p));
        return (
          <div className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".75rem", flexWrap: "wrap", marginBottom: "1rem", borderLeft: "3px solid #f59e0b" }}>
            <Package size={18} style={{ color: "#b45309", flexShrink: 0 }} />
            <p style={{ flex: 1, fontSize: ".8125rem", margin: 0, minWidth: 200 }}>
              <b>Replenishment needed:</b> {lowItems.slice(0, 6).map((p) => String(p.name)).join(", ")}{lowItems.length > 6 ? ` and ${lowItems.length - 6} more` : ""} {lowItems.length === 1 ? "is" : "are"} running low across your inventory — OziUno tracks usage and keeps these on the shopping list.
            </p>
            <button className="ozi-btn" style={{ fontSize: ".75rem", padding: ".375rem .75rem" }} onClick={() => go("shopping")}>View shopping list</button>
          </div>
        );
      })()}
      <div className="ozi-grid ozi-grid-3">
        <section className="ozi-card"><h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase" }}>{isChild ? "Your schedule" : "Schedule"}</h2>
          {upcoming.map((ev) => (
            <div key={String(ev.id)} style={{ marginBottom: ".5rem" }}>
              <p style={{ fontSize: ".875rem", fontWeight: 500 }}>{String(ev.title)}{ev.member_name ? <span className="ozi-muted" style={{ fontWeight: 400 }}> · {String(ev.member_name)}</span> : null}</p>
              <p className="ozi-muted" style={{ fontSize: ".75rem" }}>{new Date(String(ev.starts_at)).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
            </div>
          ))}
          {!upcoming.length && <p className="ozi-muted">Nothing coming up.</p>}
        </section>
        {canSee(member.role, "pantry") ? (
          <section className="ozi-card"><h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase" }}>Inventory</h2>
            <p className="ozi-display" style={{ fontSize: "1.5rem" }}>{(pantry ?? []).length} item{(pantry ?? []).length === 1 ? "" : "s"}</p>
            <p className="ozi-muted" style={{ fontSize: ".75rem", marginBottom: ".5rem" }}>
              {(() => {
                if (!(pantry ?? []).length) return "Nothing tracked yet — start with what's in the kitchen.";
                const low = (pantry ?? []).filter((p) => invIsLow(p)).length;
                const exp = (pantry ?? []).filter((p) => assessPantryRisk(p)).length;
                return low || exp ? `${low} running low · ${exp} expiring soon` : "All stocked up across every category.";
              })()}
            </p>
            <button className="ozi-btn" style={{ fontSize: ".75rem", padding: ".375rem .75rem" }} onClick={() => go("pantry")}><Package size={14} /> Open Inventory</button>
          </section>
        ) : (
          <section className="ozi-card"><h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase" }}>Your tasks</h2>
            {myTasks.slice(0, 5).map((t) => <p key={String(t.id)} style={{ fontSize: ".875rem" }}>{String(t.title)}</p>)}
            {!myTasks.length && <p className="ozi-muted">Nothing assigned to you. Enjoy!</p>}
          </section>
        )}
        {canSee(member.role, "bills") ? (
          <section className="ozi-card"><h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase" }}>Bills</h2>
            {nextBill ? (<><p className="ozi-display">{fmtN(Number(nextBill.amount_ngn))}</p>
              <p className="ozi-muted" style={{ fontSize: ".75rem", marginBottom: ".5rem" }}>{String(nextBill.name)}{nextBill.assigned_to ? ` · assigned to ${String(nextBill.assigned_to)}` : ""}</p>
              <button className="ozi-btn" onClick={async () => { await hdb("hh_bills").update(Number(nextBill.id), { paid: true, paid_at: new Date().toISOString() }); await syncBudgetForBill(hid, String(nextBill.category), Number(nextBill.amount_ngn), 1); rBills(); }}>Pay</button></>) : <p className="ozi-muted">All paid.</p>}
          </section>
        ) : (
          <section className="ozi-card"><h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase" }}>Meals today</h2>
            {(todayMeals ?? []).map((m) => <p key={String(m.id)} style={{ fontSize: ".875rem", textTransform: "capitalize" }}>{String(m.meal)}: {String(m.title)}</p>)}
            {!todayMeals?.length && <p className="ozi-muted">No meals planned yet.</p>}
          </section>
        )}
        {canSee(member.role, "wasteless") && (() => {
          const atRisk = (pantry ?? []).filter((p) => assessPantryRisk(p));
          const worst = atRisk.find((p) => { const r = assessPantryRisk(p); return r && r.severity === "use_today"; }) || atRisk[0];
          const worstRisk = worst ? assessPantryRisk(worst) : null;
          return (
            <section className="ozi-card" style={{ borderLeft: "3px solid #0d9488" }}>
              <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", display: "flex", alignItems: "center", gap: ".375rem" }}><Recycle size={13} /> WasteLess</h2>
              {atRisk.length ? (
                <>
                  <p className="ozi-display" style={{ fontSize: "1.5rem" }}>{atRisk.length} item{atRisk.length === 1 ? "" : "s"} to use up</p>
                  <p className="ozi-muted" style={{ fontSize: ".75rem", marginBottom: ".5rem" }}>{worst && worstRisk ? `${String(worst.name)} ${worstRisk.reason}. ` : ""}Use them before they're wasted.</p>
                </>
              ) : (
                <>
                  <p className="ozi-display" style={{ fontSize: "1.5rem" }}>Nothing at risk</p>
                  <p className="ozi-muted" style={{ fontSize: ".75rem", marginBottom: ".5rem" }}>Your pantry looks healthy — keep it up.</p>
                </>
              )}
              <button className="ozi-btn" onClick={() => go("wasteless")}><Leaf size={14} /> Open WasteLess</button>
            </section>
          );
        })()}
        <section className="ozi-hero-dark" style={{ gridColumn: "1 / -1" }}>
          <p style={{ color: "#D4AF37", fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: ".5rem" }}>
            Today's menu board · {mealPeriodLabel}
          </p>
          <h3 className="ozi-display" style={{ fontSize: "1.5rem" }}>
            {currentMenuItem ? String(currentMenuItem.title) : `No ${mealPeriod} planned yet`}
          </h3>
          <p style={{ color: "rgba(245,243,238,.68)", fontSize: ".8125rem", marginTop: ".375rem" }}>
            {currentMenuItem?.recipe_md ? String(currentMenuItem.recipe_md) : `Add today's ${mealPeriod} in Meals to show it here.`}
          </p>
          <button onClick={() => go("meals")} style={{ border: 0, background: "transparent", color: "#D4AF37", padding: ".75rem 0 0", fontSize: ".75rem", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: ".375rem" }}>
            View today's meals <ArrowRight size={14} />
          </button>
        </section>
      </div>
    </div>
  );
}

function ChatView({ ctx, threadId }: { ctx: HHCtx; threadId: number | null }) {
  const { go, household, member } = ctx;
  const { data: threads, refresh: rThreads } = window.useWorkspaceDB("chat_threads", { orderBy: { column: "updated_at", direction: "desc" } });
  const { data: messages, refresh: rMsgs } = window.useWorkspaceDB("chat_messages", {
    filters: threadId ? [{ column: "thread_id", operator: "eq", value: threadId }] : [],
    orderBy: { column: "created_at", direction: "asc" }, limit: 200,
  });
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [micError, setMicError] = useState("");
  const [voiceReplies, setVoiceReplies] = useState(() => {
    try { return localStorage.getItem("ozi_voice_replies") === "1"; } catch { return false; }
  });
  const setVoiceRepliesPersist = (on: boolean) => {
    setVoiceReplies(on);
    try { localStorage.setItem("ozi_voice_replies", on ? "1" : "0"); } catch { /* storage unavailable */ }
    if (!on) stopSpeaking();
  };
  useEffect(() => () => stopSpeaking(), []);
  const sendText = async (raw: string, opts?: { spoken?: boolean; tid?: number }) => {
    const text = raw.trim(); if (!text || streaming) return;
    let tid = opts?.tid ?? threadId;
    if (!tid) {
      const inserted = await db().from("chat_threads").insert({ title: text.slice(0, 60) });
      tid = insertedId(inserted);
      if (!tid) {
        // insert() didn't hand back the row — the newest session-scoped thread is ours.
        const { data: latest } = await db().from("chat_threads").orderBy("created_at", "desc").limit(1).get();
        tid = Number(latest?.[0]?.id) || 0;
      }
      if (!tid) return;
      go("chat", tid);
    }
    setInput(""); setStreaming(true);
    await db().from("chat_messages").insert({ thread_id: tid, role: "user", content: text });
    rMsgs();
    try {
      const context = await loadHouseholdContext(ctx.hid, member);
      // Recent turns give the assistant conversational memory ("make that two bottles").
      const history = (messages ?? [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-12)
        .map((m) => ({ role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant", content: String(m.content) }));
      // Same tool-calling agent as the voice orb — the typed chat takes real
      // actions too (add to the list, plan a meal, complete a chore, …).
      const { reply } = await runOziAgentTurn({
        system: memberSystemPrompt(household, member) + "\n\nLive household data (JSON snapshot):\n" + context,
        history,
        userText: text,
        ctx: agentCtxFor(ctx),
        spoken: !!opts?.spoken,
      });
      if (reply.trim()) {
        await db().from("chat_messages").insert({ thread_id: tid, role: "assistant", content: reply.trim() });
        // Spoken questions always get a spoken answer; the speaker toggle covers typed ones too.
        if (opts?.spoken || voiceReplies) speak(reply.trim());
      }
      await db().from("chat_threads").update(tid, { updated_at: new Date().toISOString() });
    } catch (err) {
      console.error("[OziUno] Chat turn failed:", err);
      await db().from("chat_messages").insert({ thread_id: tid, role: "assistant", content: "Sorry, I couldn't complete that just yet. Would you like me to try again?" }).catch(() => {});
    } finally { setStreaming(false); rMsgs(); rThreads(); }
  };
  const send = () => { void sendText(input); };
  // A question typed or spoken on the dashboard lands here as a pending
  // message — send it into the new thread automatically.
  useEffect(() => {
    if (!threadId) return;
    try {
      const raw = sessionStorage.getItem("ozi_pending_chat");
      if (!raw) return;
      const pending = JSON.parse(raw) as { tid?: number; text?: string; spoken?: boolean };
      if (Number(pending.tid) !== threadId || !pending.text) return;
      sessionStorage.removeItem("ozi_pending_chat");
      void sendText(pending.text, { spoken: pending.spoken, tid: threadId });
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  return (
    <div className="ozi-chat-layout">
      <aside className="ozi-chat-sidebar"><nav style={{ padding: ".5rem" }}>
        <p className="ozi-muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em", padding: ".5rem .75rem" }}>Your private chats</p>
        {(threads ?? []).map((t) => (
          <button key={String(t.id)} onClick={() => go("chat", Number(t.id))} className="ozi-nav-item">{String(t.title)}</button>
        ))}
      </nav></aside>
      <div style={{ flex: 1, padding: "1rem", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {!(messages ?? []).length && (
            <p className="ozi-muted" style={{ fontSize: ".875rem", padding: "1rem 0" }}>
              Hi {firstName(member.name)} — I can answer questions about {String(household.name)} and actually do things for you: try "add milk to the shopping list" or "remind me to clean the kitchen tomorrow". Tap the mic to talk instead of typing — I can read my replies out loud too.
            </p>
          )}
          {(messages ?? []).map((m) => (
            <div key={String(m.id)} style={{ marginBottom: ".75rem" }} className={m.role === "user" ? "ozi-msg-user" : "ozi-msg-ai"}>{String(m.content)}</div>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Speak or type to OziUno…" className="ozi-input" />
          <MicButton
            title="Speak to OziUno"
            disabled={streaming}
            onError={setMicError}
            onText={(t) => { setMicError(""); if (!voiceReplies) setVoiceRepliesPersist(true); void sendText(t, { spoken: true }); }}
          />
          <span className="ozi-tooltip-wrap">
            <button
              type="button"
              onClick={() => setVoiceRepliesPersist(!voiceReplies)}
              aria-label={voiceReplies ? "Turn voice replies off" : "Turn voice replies on"}
              style={{ width: 40, height: 40, borderRadius: 9999, flexShrink: 0, border: "1px solid rgba(15,27,45,.12)", background: voiceReplies ? "rgba(13,148,136,.1)" : "transparent", color: voiceReplies ? "#0d9488" : "#5b6b81", cursor: "pointer", display: "grid", placeItems: "center" }}
            >
              {voiceReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <span className="ozi-tooltip">{voiceReplies ? "OziUno reads replies aloud — tap to mute" : "Tap to have OziUno read replies aloud"}</span>
          </span>
          <button type="submit" disabled={!input.trim() || streaming} className="ozi-btn"><ArrowUp size={16} /></button>
        </form>
        {micError && <p role="alert" className="ozi-muted" style={{ fontSize: ".75rem", marginTop: ".5rem" }}>{micError}</p>}
      </div>
    </div>
  );
}

/* ----------------------------- entry editing ----------------------------- */

interface EditField {
  key: string;
  label: string;
  type?: "text" | "number" | "date" | "datetime-local" | "select";
  options?: { value: string; label: string }[];
  placeholder?: string;
}

/**
 * Shared edit dialog so every list (bills, budget, pantry, shopping,
 * schedule, tasks, maintenance) can EDIT an entry in place instead of
 * deleting it and re-entering the same information.
 */
function EditEntryModal({ title, fields, initial, onSave, onClose }: {
  title: string; fields: EditField[]; initial: Record<string, string>;
  onSave: (values: Record<string, string>) => Promise<void>; onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try { await onSave(values); onClose(); }
    catch (err) { console.error("[OziUno] Edit failed:", err); setError("Couldn't save the changes — check the fields and try again."); setBusy(false); }
  };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 55, display: "grid", placeItems: "center", background: "rgba(0,0,0,.4)", padding: "1rem" }} onClick={busy ? undefined : onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="ozi-card" style={{ width: "100%", maxWidth: 384, maxHeight: "85vh", overflowY: "auto" }}>
        <p className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".75rem" }}>{title}</p>
        <div style={{ display: "grid", gap: ".5rem" }}>
          {fields.map((f) => (
            <label key={f.key} style={{ display: "grid", gap: ".25rem" }}>
              <span className="ozi-muted" style={{ fontSize: ".6875rem", textTransform: "uppercase", letterSpacing: ".05em" }}>{f.label}</span>
              {f.type === "select" ? (
                <select value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} className="ozi-input" style={{ textTransform: "capitalize" }}>
                  {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} type={f.type || "text"} placeholder={f.placeholder} className="ozi-input" {...(f.type === "number" ? { min: 0, step: "any" } : {})} />
              )}
            </label>
          ))}
        </div>
        {error && <p role="alert" style={{ fontSize: ".75rem", color: "#b91c1c", margin: ".5rem 0 0" }}>{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: ".5rem", marginTop: "1rem" }}>
          <button type="button" onClick={onClose} disabled={busy} className="ozi-muted" style={{ border: "none", background: "transparent", cursor: "pointer" }}>Cancel</button>
          <button type="submit" disabled={busy} className="ozi-btn">{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </div>
  );
}

/** Pencil button that sits next to the existing inline delete buttons. */
function EditBtn({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-label="Edit" title="Edit" style={{ border: "none", background: "transparent", cursor: "pointer" }}><Pencil size={15} /></button>;
}

/** Five-state status chip driven by the inventory engine: Sufficient /
 * Running low / Out of stock / Planned shortage / Expiring soon. An item is
 * NEVER shown as out of stock merely because a meal plan needs it. */
const INV_STATE_STYLE: Record<InvState, { bg: string; fg: string }> = {
  sufficient: { bg: "rgba(13,148,136,.12)", fg: "#0d9488" },
  running_low: { bg: "rgba(245,158,11,.22)", fg: "#b45309" },
  out_of_stock: { bg: "rgba(15,27,45,.14)", fg: "#3b4d63" },
  planned_shortage: { bg: "rgba(249,115,22,.14)", fg: "#c2410c" },
  expiring_soon: { bg: "rgba(220,38,38,.12)", fg: "#dc2626" },
};

function InvStateChip({ state }: { state: InvState }) {
  const s = INV_STATE_STYLE[state] || INV_STATE_STYLE.sufficient;
  return <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", borderRadius: 9999, padding: "2px 8px", background: s.bg, color: s.fg, flexShrink: 0 }}>{INV_STATE_LABELS[state] || state}</span>;
}

/**
 * Rooms & storage screen — the household's spatial map. Room cards expand to
 * their storage locations and the items kept in each; owners can add, rename
 * and delete rooms and locations (items in a deleted place simply become
 * "no location", never deleted).
 */
function RoomsPanel({ ctx, items, rooms, locations, customCats, onChanged }: {
  ctx: HHCtx;
  items: Record<string, unknown>[];
  rooms: Record<string, unknown>[];
  locations: Record<string, unknown>[];
  customCats: Record<string, unknown>[];
  onChanged: () => void;
}) {
  const { hid } = ctx;
  const [openRoom, setOpenRoom] = useState<number | null>(null);
  const itemsAtLoc = (locId: number) => items.filter((i) => Number(i.storage_location_id) === locId);
  const locsOfRoom = (roomId: number) => locations.filter((l) => Number(l.room_id) === roomId);
  const roomItemCount = (roomId: number) => locsOfRoom(roomId).reduce((s, l) => s + itemsAtLoc(Number(l.id)).length, 0);
  const unassigned = items.filter((i) => i.storage_location_id == null || !locations.some((l) => Number(l.id) === Number(i.storage_location_id)));

  const addRoom = async () => {
    const name = (window.prompt("Name the new room (e.g. Home Office):") || "").trim();
    if (!name) return;
    const icon = (window.prompt("Pick an emoji for it (optional):") || "").trim() || "🚪";
    await hdb("hh_rooms").insert({ household_id: hid, name, icon, sort_order: rooms.length });
    onChanged();
  };
  const renameRoom = async (room: Record<string, unknown>) => {
    const name = (window.prompt("Rename this room:", String(room.name)) || "").trim();
    if (!name) return;
    await hdb("hh_rooms").update(Number(room.id), { name });
    onChanged();
  };
  const deleteRoom = async (room: Record<string, unknown>) => {
    if (!window.confirm(`Delete ${String(room.name)}? Its storage places are removed too — items kept there stay in the inventory as "no location".`)) return;
    for (const l of locsOfRoom(Number(room.id))) {
      for (const it of itemsAtLoc(Number(l.id))) await hdb("hh_inventory_items").update(Number(it.id), { storage_location_id: null });
      await hdb("hh_storage_locations").delete(Number(l.id));
    }
    await hdb("hh_rooms").delete(Number(room.id));
    if (openRoom === Number(room.id)) setOpenRoom(null);
    onChanged();
  };
  const addLocation = async (room: Record<string, unknown>) => {
    const name = (window.prompt(`Name the new storage place in ${String(room.name)} (e.g. Top Shelf):`) || "").trim();
    if (!name) return;
    await hdb("hh_storage_locations").insert({ household_id: hid, room_id: Number(room.id), name, sort_order: locsOfRoom(Number(room.id)).length });
    onChanged();
  };
  const renameLocation = async (loc: Record<string, unknown>) => {
    const name = (window.prompt("Rename this storage place:", String(loc.name)) || "").trim();
    if (!name) return;
    await hdb("hh_storage_locations").update(Number(loc.id), { name });
    onChanged();
  };
  const deleteLocation = async (loc: Record<string, unknown>) => {
    if (!window.confirm(`Delete ${String(loc.name)}? Items kept there stay in the inventory as "no location".`)) return;
    for (const it of itemsAtLoc(Number(loc.id))) await hdb("hh_inventory_items").update(Number(it.id), { storage_location_id: null });
    await hdb("hh_storage_locations").delete(Number(loc.id));
    onChanged();
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: ".5rem", marginBottom: "1rem" }}>
        <p className="ozi-muted" style={{ fontSize: ".8125rem", margin: 0 }}>Tap a room to see its storage places and what's kept in each.</p>
        <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".375rem .75rem" }} onClick={() => void addRoom()}><Plus size={14} /> Add room</button>
      </div>
      <div className="ozi-grid ozi-grid-3">
        {rooms.map((room) => {
          const rid = Number(room.id);
          const open = openRoom === rid;
          const locs = locsOfRoom(rid);
          return (
            <section key={String(room.id)} className="ozi-card" style={{ gridColumn: open ? "1 / -1" : undefined, cursor: open ? "default" : "pointer" }} onClick={() => { if (!open) setOpenRoom(rid); }}>
              <div style={{ display: "flex", alignItems: "center", gap: ".625rem" }}>
                <span style={{ fontSize: "1.5rem", lineHeight: 1 }}>{String(room.icon || "🚪")}</span>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: ".9375rem", fontWeight: 600, margin: 0 }}>{String(room.name)}</p>
                  <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>{locs.length} storage place{locs.length === 1 ? "" : "s"} · {roomItemCount(rid)} item{roomItemCount(rid) === 1 ? "" : "s"}</p>
                </div>
                {open ? (
                  <span style={{ display: "inline-flex", gap: ".125rem" }} onClick={(e) => e.stopPropagation()}>
                    <EditBtn onClick={() => void renameRoom(room)} />
                    <button onClick={() => void deleteRoom(room)} aria-label="Delete room" title="Delete room" style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={15} /></button>
                    <button onClick={() => setOpenRoom(null)} aria-label="Close room" title="Close" style={{ border: "none", background: "transparent", cursor: "pointer" }}><X size={16} /></button>
                  </span>
                ) : (
                  <ArrowRight size={16} style={{ color: "#5b6b81" }} />
                )}
              </div>
              {open && (
                <div style={{ marginTop: "1rem", display: "grid", gap: ".625rem" }} onClick={(e) => e.stopPropagation()}>
                  {locs.map((loc) => {
                    const stored = itemsAtLoc(Number(loc.id));
                    return (
                      <div key={String(loc.id)} className="ozi-option-card">
                        <div style={{ display: "flex", alignItems: "center", gap: ".5rem" }}>
                          <p style={{ fontSize: ".8125rem", fontWeight: 600, margin: 0, flex: 1 }}>{String(loc.name)} <span className="ozi-muted" style={{ fontWeight: 400 }}>· {stored.length} item{stored.length === 1 ? "" : "s"}</span></p>
                          <EditBtn onClick={() => void renameLocation(loc)} />
                          <button onClick={() => void deleteLocation(loc)} aria-label="Delete storage place" title="Delete storage place" style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={14} /></button>
                        </div>
                        {stored.length ? (
                          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".25rem" }}>
                            {stored.map((it) => (
                              <li key={String(it.id)} style={{ display: "flex", alignItems: "center", gap: ".5rem", fontSize: ".8125rem" }}>
                                <span>{invCatIcon(it.category, customCats)}</span>
                                <span style={{ flex: 1 }}>{String(it.name)}</span>
                                <span className="ozi-muted" style={{ fontSize: ".75rem" }}>{Number(it.quantity) || 0} {String(it.unit || "unit")}</span>
                                <InvStateChip state={computeItemStates(it as never, 0).state} />
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>Nothing stored here yet — assign items to it from the inventory list.</p>
                        )}
                      </div>
                    );
                  })}
                  <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".375rem .75rem", justifySelf: "start" }} onClick={() => void addLocation(room)}><Plus size={14} /> Add storage place</button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {unassigned.length > 0 && (
        <div className="ozi-card" style={{ marginTop: "1rem" }}>
          <p style={{ fontSize: ".8125rem", fontWeight: 600, margin: "0 0 .25rem" }}>📍 No location yet · {unassigned.length} item{unassigned.length === 1 ? "" : "s"}</p>
          <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>{unassigned.slice(0, 10).map((i) => String(i.name)).join(", ")}{unassigned.length > 10 ? ` and ${unassigned.length - 10} more` : ""} — edit an item to give it a home.</p>
        </div>
      )}
    </div>
  );
}

/** Per-item transaction history — the auditable ledger behind every number. */
function LedgerHistoryModal({ hid, item, onClose }: { hid: number; item: Record<string, unknown>; onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { data } = await hdb("hh_inventory_ledger").eq("household_id", hid).eq("item_id", Number(item.id)).orderBy("created_at", "desc").limit(30).get();
        if (alive) setRows(data ?? []);
      } catch { if (alive) setRows([]); }
    })();
    return () => { alive = false; };
  }, [hid, item]);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 55, display: "grid", placeItems: "center", background: "rgba(0,0,0,.4)", padding: "1rem" }} onClick={onClose}>
      <div className="ozi-card" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, maxHeight: "80vh", overflowY: "auto" }}>
        <p className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".25rem" }}>Ledger — {String(item.name)}</p>
        <p className="ozi-muted" style={{ fontSize: ".6875rem", marginBottom: ".75rem" }}>Every stock change is a recorded transaction — nothing is ever overwritten silently.</p>
        {rows === null && <p className="ozi-muted" style={{ fontSize: ".8125rem" }}>Loading…</p>}
        {rows !== null && !rows.length && <p className="ozi-muted" style={{ fontSize: ".8125rem" }}>No transactions yet.</p>}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".375rem" }}>
          {(rows ?? []).map((l) => {
            const d = Number(l.qty_delta) || 0;
            return (
              <li key={String(l.id)} style={{ border: "1px solid rgba(15,27,45,.08)", borderRadius: 8, padding: ".5rem .625rem" }}>
                <p style={{ fontSize: ".8125rem", margin: 0, display: "flex", justifyContent: "space-between", gap: ".5rem" }}>
                  <span style={{ fontWeight: 600 }}>{TXN_LABELS[String(l.txn_type) as TxnType] || String(l.txn_type)}</span>
                  <span style={{ color: d < 0 ? "#dc2626" : "#0d9488", fontWeight: 600 }}>{d > 0 ? "+" : ""}{d} {String(l.unit || "")}</span>
                </p>
                <p className="ozi-muted" style={{ fontSize: ".6875rem", margin: "2px 0 0" }}>
                  {new Date(String(l.occurred_at || l.created_at)).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  {" · balance "}{Number(l.balance_after)} {String(l.unit || "")}
                  {l.created_by ? ` · ${String(l.created_by)}` : ""}
                </p>
                {l.reason ? <p className="ozi-muted" style={{ fontSize: ".6875rem", margin: "2px 0 0", fontStyle: "italic" }}>{String(l.reason)}</p> : null}
              </li>
            );
          })}
        </ul>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: ".75rem" }}>
          <button type="button" className="ozi-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function InventoryView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  // First-run setup: seed default rooms/locations, copy legacy pantry rows in,
  // backfill ingredient keys + placeholder units, record opening balances.
  const [setupTick, setSetupTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void ensureInventoryReady(hid).then((changed) => { if (alive && changed) setSetupTick((t) => t + 1); });
    return () => { alive = false; };
  }, [hid]);
  const { data, refresh } = window.useWorkspaceDB("hh_inventory_items", { shared: true, filters: hhFilter(hid), orderBy: { column: "name", direction: "asc" }, limit: 500 });
  const { data: rooms, refresh: rRooms } = window.useWorkspaceDB("hh_rooms", { shared: true, filters: hhFilter(hid), orderBy: { column: "sort_order", direction: "asc" }, limit: 50 });
  const { data: locations, refresh: rLocs } = window.useWorkspaceDB("hh_storage_locations", { shared: true, filters: hhFilter(hid), orderBy: { column: "sort_order", direction: "asc" }, limit: 200 });
  const { data: customCats, refresh: rCats } = window.useWorkspaceDB("hh_inventory_categories", { shared: true, filters: hhFilter(hid), orderBy: { column: "name", direction: "asc" }, limit: 50 });
  // Commitments (planned, unconfirmed meal requirements) + recent ledger.
  const { data: mealIngredients, refresh: refreshIngredients } = window.useWorkspaceDB("hh_meal_ingredients", { shared: true, filters: [...hhFilter(hid), { column: "status", operator: "eq", value: "committed" }], limit: 500 });
  const { data: ledger, refresh: refreshLedger } = window.useWorkspaceDB("hh_inventory_ledger", { shared: true, filters: hhFilter(hid), orderBy: { column: "created_at", direction: "desc" }, limit: 300 });
  const refreshAll = useCallback(() => { refresh(); rRooms(); rLocs(); refreshIngredients(); refreshLedger(); }, [refresh, rRooms, rLocs, refreshIngredients, refreshLedger]);
  // Refetch exactly once per completed setup pass — the ref guard keeps
  // changing refresh identities from ever re-triggering this effect.
  const lastSetupTickRef = useRef(0);
  useEffect(() => {
    if (setupTick > 0 && lastSetupTickRef.current !== setupTick) { lastSetupTickRef.current = setupTick; refreshAll(); }
  }, [setupTick, refreshAll]);

  const items = data ?? [];
  // Only commitments belonging to still-planned FUTURE-or-recent meals count;
  // ingredient rows are cancelled/consumed at confirmation time.
  const committedMap = useMemo(() => committedByItem(mealIngredients ?? []), [mealIngredients]);
  const statesById = useMemo(() => {
    const m = new Map<number, ItemStates>();
    for (const it of items) m.set(Number(it.id), computeItemStates(it as never, committedMap.get(Number(it.id)) || 0));
    return m;
  }, [items, committedMap]);
  const usageStats = useMemo(() => weeklyConsumption(ledgerToUsage(ledger ?? [])), [ledger]);
  const usedByItem = useMemo(() => {
    const m = new Map<number, number>();
    const twoWeeksAgo = Date.now() - 14 * 86400000;
    (ledger ?? []).forEach((l) => {
      if (String(l.txn_type) !== "consumption") return;
      const t = new Date(String(l.occurred_at || l.created_at || "")).getTime();
      if (!Number.isFinite(t) || t < twoWeeksAgo) return;
      const q = -(Number(l.qty_delta) || 0);
      if (q > 0 && l.item_id != null) m.set(Number(l.item_id), Math.round(((m.get(Number(l.item_id)) || 0) + q) * 100) / 100);
    });
    return m;
  }, [ledger]);

  const locById = useMemo(() => {
    const m = new Map<number, string>();
    (locations ?? []).forEach((l) => {
      const room = (rooms ?? []).find((r) => Number(r.id) === Number(l.room_id));
      m.set(Number(l.id), room ? `${String(room.name)} · ${String(l.name)}` : String(l.name));
    });
    return m;
  }, [locations, rooms]);

  const [tab, setTab] = useState("all");
  const [showRooms, setShowRooms] = useState(false);
  const [notice, setNotice] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [historyFor, setHistoryFor] = useState<Record<string, unknown> | null>(null);

  const tabDefs = useMemo(() => ([
    { key: "all", label: "All", icon: "🏠" },
    ...INV_CATS.map((c) => ({ key: c.key, label: c.short, icon: c.icon })),
    ...(customCats ?? []).map((c) => ({ key: `custom:${c.id}`, label: String(c.name), icon: String(c.icon || "🏷️") })),
  ]), [customCats]);

  const stateOf = (it: Record<string, unknown>): ItemStates => statesById.get(Number(it.id)) || computeItemStates(it as never, 0);
  const lowCount = items.filter((i) => ["running_low", "planned_shortage"].includes(stateOf(i).state)).length;
  const expiringCount = items.filter((i) => stateOf(i).state === "expiring_soon" || !!assessPantryRisk(i)).length;
  const outCount = items.filter((i) => stateOf(i).state === "out_of_stock").length;
  const visible = tab === "all" ? items : items.filter((i) => invCatKey(i.category) === tab);
  const groups = tab === "all"
    ? tabDefs.filter((t) => t.key !== "all").map((t) => ({ ...t, rows: items.filter((i) => invCatKey(i.category) === t.key) })).filter((g) => g.rows.length)
    : [{ ...(tabDefs.find((t) => t.key === tab) || { key: tab, label: invCatLabel(tab, customCats), icon: invCatIcon(tab, customCats) }), rows: visible }];

  // Recompute this week's planned requirements (commitments). NOTHING is
  // deducted here — consumption only happens via meal check-ins.
  const syncNow = async () => {
    if (syncBusy) return;
    setSyncBusy(true); setNotice("");
    const created = await ensureMealCommitments(hid, ctx.household);
    setSyncBusy(false);
    setNotice(created > 0
      ? `Planned requirements updated from your meal plan (${created} ingredient line${created === 1 ? "" : "s"}). Nothing was deducted — confirm meals in the check-in card to record actual consumption.`
      : "Planned requirements are already up to date. Inventory only changes when you confirm a meal, purchase, waste or correction.");
    refreshAll();
  };

  const addCustomCategory = async () => {
    const name = (window.prompt("Name the new category (e.g. Craft Supplies):") || "").trim();
    if (!name) return;
    const icon = (window.prompt("Pick an emoji for it (optional):") || "").trim() || "🏷️";
    await hdb("hh_inventory_categories").insert({ household_id: hid, name, icon });
    rCats();
    setNotice(`Category “${name}” added — pick it when adding or editing items.`);
  };

  const markUsed = async (item: Record<string, unknown>) => {
    await postTxn(hid, item, { type: "consumption", delta: -1, reason: "Marked as used by hand", createdBy: member.name });
    refresh(); refreshLedger();
  };

  const markWaste = async (item: Record<string, unknown>) => {
    const unit = String(item.unit || "pcs");
    const raw = window.prompt(`How much ${String(item.name)} was wasted/spoiled? (in ${unit})`, String(Number(item.quantity) || 1));
    const qty = Number(raw);
    if (!raw || !(qty > 0)) return;
    const why = (window.prompt("What happened? (optional — e.g. spoiled, expired, burnt)") || "Spoiled / wasted").trim();
    const res = await recordWaste(hid, item, qty, unit, why, member.name);
    if (res.ok) setNotice(`Recorded ${Math.abs(res.applied)} ${unit} of ${String(item.name)} as waste — WasteLess tracks this to help you save money.`);
    refresh(); refreshLedger();
  };

  const addToList = async (item: Record<string, unknown>) => {
    const { data: existing } = await hdb("hh_shopping_items").eq("household_id", hid).eq("checked", false).get();
    const already = (existing ?? []).some((row) => Number(row.linked_pantry_id) === Number(item.id) || String(row.name || "").toLowerCase().trim() === String(item.name || "").toLowerCase().trim());
    if (already) { setNotice(`${String(item.name)} is already on the shopping list.`); return; }
    const st = stateOf(item);
    const req = shoppingRequirement({ onHand: st.onHand, committed: st.committed, minStock: st.minStock });
    const buyQty = Math.max(Number(item.preferred_purchase_qty) || 0, req, 1);
    const pkg = recommendPackage(buyQty, st.unit, item as never);
    await hdb("hh_shopping_items").insert({
      household_id: hid, name: item.name, category: invCatKey(item.category), unit: pkg.unit || item.unit || "pcs",
      quantity: pkg.qty || buyQty, source: "pantry_low", linked_pantry_id: Number(item.id),
      checked: false, est_cost_ngn: 0, added_by: member.name,
      reason: shoppingReason({ name: String(item.name), unit: st.unit, onHand: st.onHand, committed: st.committed, minStock: st.minStock, requirement: buyQty }),
      needed_qty: req > 0 ? req : buyQty, needed_unit: st.unit,
    });
    setNotice(`Added ${String(item.name)} to the shopping list.`);
  };

  const catOptions = [
    ...INV_CATS.map((c) => ({ value: c.key, label: `${c.icon} ${c.label}` })),
    ...(customCats ?? []).map((c) => ({ value: `custom:${c.id}`, label: `${String(c.icon || "🏷️")} ${String(c.name)}` })),
  ];
  const locOptions = [
    { value: "", label: "No location" },
    ...(locations ?? []).map((l) => ({ value: String(l.id), label: locById.get(Number(l.id)) || String(l.name) })),
  ];
  const itemFields: EditField[] = [
    { key: "name", label: "Item name" },
    { key: "category", label: "Category", type: "select", options: catOptions },
    { key: "location", label: "Storage location (room · place)", type: "select", options: locOptions },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "unit", label: "Unit (pcs, kg, g, L, ml, dozen, rolls…) — leave blank for the smart default" },
    { key: "min", label: "Minimum stock — alert at or below this (optional)", type: "number" },
    { key: "buyQty", label: "Preferred purchase quantity (optional)", type: "number" },
    { key: "pkgName", label: "Package name (e.g. dozen, bag) — optional" },
    { key: "pkgSize", label: "Package size (e.g. 12 or 5) — optional", type: "number" },
    { key: "pkgUnit", label: "Package base unit (e.g. pcs, kg) — optional" },
    { key: "rate", label: "Usually lasts … days (optional)", type: "number" },
    { key: "expires", label: "Expiry date (optional)", type: "date" },
    { key: "notes", label: "Notes (optional)" },
  ];
  const valuesFor = (item: Record<string, unknown> | null): Record<string, string> => ({
    name: String(item?.name || ""),
    category: invCatKey(item?.category ?? (tab !== "all" ? tab : "pantry")),
    location: item?.storage_location_id != null ? String(item.storage_location_id) : "",
    quantity: String(item?.quantity ?? 1),
    unit: String(item?.unit || ""),
    min: item?.min_stock_level != null ? String(item.min_stock_level) : "",
    buyQty: item?.preferred_purchase_qty != null ? String(item.preferred_purchase_qty) : "",
    pkgName: String(item?.package_name || ""),
    pkgSize: item?.package_size != null ? String(item.package_size) : "",
    pkgUnit: String(item?.package_unit || ""),
    rate: item?.typical_days_to_deplete != null ? String(item.typical_days_to_deplete) : "",
    expires: String(item?.expires_at || "").slice(0, 10),
    notes: String(item?.notes || ""),
  });
  /**
   * Saving an item goes through the controlled model:
   *  - blank unit → hardcoded taxonomy default (Eggs → pcs, never kg)
   *  - "dozen" entries normalize to pcs (2 dozen = 24 pcs, package remembered)
   *  - duplicate names (spelling variations) are refused, not silently merged
   *  - quantity changes on EXISTING items post a manual_adjustment transaction
   *    to the ledger — balances are never overwritten without history
   *  - correcting a unit is remembered as a household preference
   */
  const saveItem = async (v: Record<string, string>, existing: Record<string, unknown> | null) => {
    if (!v.name.trim()) throw new Error("name required");
    const name = v.name.trim();
    if (!existing) {
      const dupe = matchInventoryItem(items, name) || items.find((i) => String(i.name || "").toLowerCase().trim() === name.toLowerCase());
      if (dupe) throw new Error(`${String(dupe.name)} is already in the inventory — edit it instead of adding a duplicate.`);
    }
    const rawUnit = v.unit.trim() || defaultUnitFor(name) || "pcs";
    const normalized = normalizeQuantityInput(Number(v.quantity) || 0, rawUnit, name);
    const qty = normalized.qty;
    const unit = normalized.unit;
    const min = Number(v.min) || 0;
    const pkgName = (v.pkgName || "").trim() || normalized.package_name || null;
    const pkgSize = Number(v.pkgSize) > 0 ? Number(v.pkgSize) : (normalized.package_size ?? null);
    const pkgUnit = (v.pkgUnit || "").trim() ? normalizeUnit(v.pkgUnit) : (normalized.package_unit ?? null);
    const patch: Record<string, unknown> = {
      name,
      ingredient_key: ingredientKeyOf(name),
      category: invCatKey(v.category),
      storage_location_id: v.location ? Number(v.location) : null,
      unit,
      min_stock_level: min > 0 ? min : null,
      preferred_purchase_qty: Number(v.buyQty) > 0 ? Number(v.buyQty) : null,
      package_name: pkgName, package_size: pkgSize, package_unit: pkgUnit,
      typical_days_to_deplete: Number(v.rate) > 0 ? Math.round(Number(v.rate)) : null,
      expires_at: v.expires || null,
      notes: v.notes.trim() || null,
      unit_review: false,
    };
    if (existing) {
      const oldQty = Number(existing.quantity) || 0;
      const oldUnit = String(existing.unit || "");
      await hdb("hh_inventory_items").update(Number(existing.id), patch);
      if (qty !== oldQty) {
        await postTxn(hid, { ...existing, ...patch, quantity: oldQty }, {
          type: "manual_adjustment", delta: qty - oldQty,
          reason: `Stock corrected by ${member.name}: ${oldQty} → ${qty} ${unit}`, createdBy: member.name,
          allowNegative: false,
        });
      }
      // A corrected unit becomes a household-level preference (asked once, remembered).
      if (normalizeUnit(oldUnit) !== unit) {
        try {
          const key = ingredientKeyOf(name);
          const { data: prefRows } = await hdb("hh_ingredient_prefs").eq("household_id", hid).eq("ingredient_key", key).get();
          if (prefRows?.[0]) await hdb("hh_ingredient_prefs").update(Number(prefRows[0].id), { preferred_unit: unit, display_name: name });
          else await hdb("hh_ingredient_prefs").insert({ household_id: hid, ingredient_key: key, display_name: name, preferred_unit: unit, package_name: pkgName, package_size: pkgSize, package_unit: pkgUnit });
        } catch { /* preference learning is best-effort */ }
      }
    } else {
      await hdb("hh_inventory_items").insert({ household_id: hid, added_by: member.name, quantity: qty, status: qty <= 0 ? "empty" : (min > 0 && qty <= min) ? "warn" : "ok", ...patch });
      await recordOpeningBalances(hid); // ledger opening entry for the new item
    }
    refresh(); refreshLedger();
  };

  return (
    <PageShell
      eyebrow="Inventory"
      title="Everything the house holds."
      subtitle="Food, supplies, medicine and more — one shared inventory with a full transaction ledger. Planned meals show as committed stock (never deducted); inventory only changes when you confirm a meal, a purchase, waste or a correction."
      extra={
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button className={showRooms ? "ozi-btn" : "ozi-btn-ghost ozi-btn"} onClick={() => setShowRooms((s) => !s)}><Home size={16} /> {showRooms ? "Back to items" : "Rooms"}</button>
          <button className="ozi-btn" disabled={syncBusy} onClick={() => void syncNow()}><RefreshCw size={16} /> {syncBusy ? "Updating plan…" : "Update planned needs"}</button>
        </div>
      }
    >
      {notice && <p role="status" className="ozi-muted" style={{ fontSize: ".8125rem", marginBottom: "1rem" }}>{notice}</p>}
      <MealCheckins ctx={ctx} onChanged={refreshAll} />
      {showRooms ? (
        <RoomsPanel ctx={ctx} items={items} rooms={rooms ?? []} locations={locations ?? []} customCats={customCats ?? []} onChanged={refreshAll} />
      ) : (
        <>
          <div className="ozi-grid ozi-grid-3" style={{ marginBottom: "1rem" }}>
            <section className="ozi-card" style={{ padding: "1rem" }}>
              <h2 className="ozi-muted" style={{ fontSize: ".6875rem", textTransform: "uppercase", display: "flex", alignItems: "center", gap: ".375rem" }}><Package size={12} /> Low / short</h2>
              <p className="ozi-display" style={{ fontSize: "1.625rem" }}>{lowCount}</p>
              <p className="ozi-muted" style={{ fontSize: ".6875rem" }}>{lowCount ? "Running low or short for planned meals." : "Everything covers its minimum and the meal plan."}</p>
            </section>
            <section className="ozi-card" style={{ padding: "1rem" }}>
              <h2 className="ozi-muted" style={{ fontSize: ".6875rem", textTransform: "uppercase", display: "flex", alignItems: "center", gap: ".375rem" }}><AlertTriangle size={12} /> Expiring soon</h2>
              <p className="ozi-display" style={{ fontSize: "1.625rem" }}>{expiringCount}</p>
              <p className="ozi-muted" style={{ fontSize: ".6875rem" }}>{expiringCount ? "Use them up before they're wasted — WasteLess has ideas." : "Nothing at risk right now."}</p>
            </section>
            <section className="ozi-card" style={{ padding: "1rem" }}>
              <h2 className="ozi-muted" style={{ fontSize: ".6875rem", textTransform: "uppercase", display: "flex", alignItems: "center", gap: ".375rem" }}><X size={12} /> Out of stock</h2>
              <p className="ozi-display" style={{ fontSize: "1.625rem" }}>{outCount}</p>
              <p className="ozi-muted" style={{ fontSize: ".6875rem" }}>{outCount ? "Completely out — restock on your next shop." : "Nothing has run out."}</p>
            </section>
          </div>
          <div style={{ display: "flex", gap: ".375rem", overflowX: "auto", paddingBottom: ".375rem", marginBottom: ".75rem", WebkitOverflowScrolling: "touch" }}>
            {tabDefs.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} className={tab === t.key ? "ozi-btn" : "ozi-btn-ghost ozi-btn"} style={{ fontSize: ".75rem", padding: ".375rem .75rem", whiteSpace: "nowrap", flexShrink: 0 }}>
                <span aria-hidden="true">{t.icon}</span> {t.label}
              </button>
            ))}
            <button onClick={() => void addCustomCategory()} className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".375rem .75rem", whiteSpace: "nowrap", flexShrink: 0 }} title="Add a custom category"><Plus size={13} /> Custom</button>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
            <button className="ozi-btn" onClick={() => setAdding(true)}><Plus size={16} /> Add item</button>
          </div>
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: "1.25rem" }}>
              {tab === "all" && <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".5rem" }}>{g.icon} {g.label} · {g.rows.length}</h2>}
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
                {g.rows.map((item) => {
                  const st = stateOf(item);
                  const locTag = item.storage_location_id != null ? locById.get(Number(item.storage_location_id)) : null;
                  const stat = usageStats.get(String(item.ingredient_key || ingredientKeyOf(item.name)));
                  const weeksLeft = stat ? estimateWeeksRemaining(st.onHand, stat.perWeek) : null;
                  const pkgX = packageExpansion(item as never);
                  const pkgNote = pkgX ? ` (${Math.round(st.onHand * pkgX.size * 100) / 100} ${normalizeUnit(pkgX.unit)})` : "";
                  return (
                    <li key={String(item.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".625rem", padding: ".75rem", flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <p style={{ fontSize: ".875rem", fontWeight: 500, margin: 0, display: "flex", alignItems: "center", gap: ".375rem", flexWrap: "wrap" }}>
                          {String(item.name)}
                          <InvStateChip state={st.state} />
                          {item.unit_review === true ? <span title="This unit looks unusual for this item — tap the pencil to review it." style={{ fontSize: 10, fontWeight: 600, borderRadius: 9999, padding: "2px 8px", background: "rgba(245,158,11,.2)", color: "#b45309" }}>Check unit</span> : null}
                        </p>
                        <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>
                          On hand {st.onHand} {st.unit}{pkgNote}
                          {st.committed > 0 ? <span style={{ color: "#b45309" }}> • planned {st.committed} {st.unit}</span> : ""}
                          {st.committed > 0 ? ` • projected ${st.projected} ${st.unit}` : ""}
                          {st.minStock > 0 ? ` • min ${st.minStock}` : ""}
                          {locTag ? ` • 📍 ${locTag}` : ""}
                          {weeksLeft !== null && st.onHand > 0 ? ` • ≈${weeksLeft} wk left (estimate)` : ""}
                          {usedByItem.has(Number(item.id)) ? <span style={{ color: "#b45309" }}> • −{usedByItem.get(Number(item.id))} {st.unit} eaten (2 wks)</span> : null}
                          {st.expiringDays !== null && st.expiringDays <= 3 && st.onHand > 0 ? <span style={{ color: "#dc2626", fontWeight: 600 }}> • {st.expiringDays < 0 ? `expired ${Math.abs(st.expiringDays)}d ago` : st.expiringDays === 0 ? "expires today" : `expires in ${st.expiringDays}d`}</span> : null}
                          {item.added_by && String(item.added_by) !== member.name ? ` • added by ${String(item.added_by)}` : ""}
                        </p>
                      </div>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: ".25rem", flexShrink: 0, flexWrap: "wrap" }}>
                        <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".6875rem", padding: ".25rem .625rem" }} title="Record 1 used (consumption transaction)" onClick={() => void markUsed(item)} disabled={(Number(item.quantity) || 0) <= 0}><Check size={12} /> Used</button>
                        <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".6875rem", padding: ".25rem .625rem" }} title="Record spoiled/wasted stock" onClick={() => void markWaste(item)} disabled={(Number(item.quantity) || 0) <= 0}><Trash2 size={12} /> Waste</button>
                        <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".6875rem", padding: ".25rem .625rem" }} title="Add to the shopping list" onClick={() => void addToList(item)}><ShoppingCart size={12} /> List</button>
                        <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".6875rem", padding: ".25rem .625rem" }} title="Transaction history (ledger)" onClick={() => setHistoryFor(item)}>Ledger</button>
                        <EditBtn onClick={() => setEditing(item)} />
                        <button onClick={async () => { if (!window.confirm(`Remove ${String(item.name)} and its tracking from the inventory?`)) return; await hdb("hh_inventory_items").delete(Number(item.id)); refresh(); }} aria-label="Delete" style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={16} /></button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {!visible.length && (
            <div className="ozi-card" style={{ textAlign: "center", padding: "2rem" }}>
              <Package size={26} style={{ color: "#0d9488", margin: "0 auto .5rem" }} />
              <p style={{ fontSize: ".9375rem", fontWeight: 600 }}>{tab === "all" ? "Your inventory is empty." : `Nothing in ${invCatLabel(tab, customCats)} yet.`}</p>
              <p className="ozi-muted" style={{ fontSize: ".8125rem", marginTop: ".375rem" }}>Add your first item — or tick things off the shopping list as bought and they'll appear here automatically.</p>
            </div>
          )}
        </>
      )}
      {historyFor && <LedgerHistoryModal hid={hid} item={historyFor} onClose={() => setHistoryFor(null)} />}
      {(adding || editing) && (
        <EditEntryModal
          title={editing ? `Edit ${String(editing.name)}` : "Add inventory item"}
          fields={itemFields}
          initial={valuesFor(editing)}
          onSave={async (v) => { await saveItem(v, editing); }}
          onClose={() => { setAdding(false); setEditing(null); }}
        />
      )}
    </PageShell>
  );
}

function ShoppingView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  const { data, refresh } = window.useWorkspaceDB("hh_shopping_items", { shared: true, filters: hhFilter(hid), orderBy: { column: "name", direction: "asc" } });
  const { data: invItems, refresh: refreshInv } = window.useWorkspaceDB("hh_inventory_items", { shared: true, filters: hhFilter(hid), limit: 500 });
  const { data: rooms } = window.useWorkspaceDB("hh_rooms", { shared: true, filters: hhFilter(hid), limit: 50 });
  const { data: locs } = window.useWorkspaceDB("hh_storage_locations", { shared: true, filters: hhFilter(hid), limit: 200 });
  const { data: mealIngredients } = window.useWorkspaceDB("hh_meal_ingredients", { shared: true, filters: [...hhFilter(hid), { column: "status", operator: "eq", value: "committed" }], limit: 500 });
  // Inventory context per line — "Laundry · Laundry Room · Cleaning Cupboard · 1 pack left".
  const invContext = (it: Record<string, unknown>): string => {
    const linked = Number(it.linked_pantry_id);
    const nameKey = String(it.name || "").toLowerCase().trim();
    const item = (invItems ?? []).find((p) => Number(p.id) === linked)
      || (invItems ?? []).find((p) => Number(p.legacy_pantry_id) === linked)
      || (invItems ?? []).find((p) => String(p.name || "").toLowerCase().trim() === nameKey);
    if (!item) return "";
    const bits: string[] = [invCatLabel(item.category)];
    if (item.storage_location_id != null) {
      const loc = (locs ?? []).find((l) => Number(l.id) === Number(item.storage_location_id));
      if (loc) {
        const room = (rooms ?? []).find((r) => Number(r.id) === Number(loc.room_id));
        bits.push(room ? `${String(room.name)} · ${String(loc.name)}` : String(loc.name));
      }
    }
    const qty = Number(item.quantity) || 0;
    bits.push(qty > 0 ? `${qty} ${String(item.unit || "unit")} left` : "out at home");
    return ` • ${bits.join(" · ")}`;
  };
  const [name, setName] = useState(""); const [cost, setCost] = useState("");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [purchaseNotice, setPurchaseNotice] = useState("");
  const [autoFillBusy, setAutoFillBusy] = useState(false);
  const [autoFillMessage, setAutoFillMessage] = useState("");
  const total = (data ?? []).filter((i) => !i.checked).reduce((s, i) => s + Number(i.est_cost_ngn) * Number(i.quantity), 0);
  const add = async (e: FormEvent) => {
    e.preventDefault(); if (!name.trim()) return;
    const added = name.trim();
    await hdb("hh_shopping_items").insert({ household_id: hid, name: added, est_cost_ngn: Number(cost)||0, quantity: 1, unit: defaultUnitFor(added) || "pcs", category: "general", source: "manual", checked: false, added_by: member.name, reason: `Added by ${member.name}.` });
    setName(""); setCost(""); refresh();
    // WasteLess: right-size the purchase from the household's real usage.
    void purchaseAdviceFor(hid, added).then((tip) => { if (tip) setPurchaseNotice(tip); });
  };
  /**
   * Smart list generation (Section 9). Per item:
   *   requirement = planned meals (committed) + minimum stock − on hand − incoming
   * Items whose projected balance already covers the minimum are NOT added —
   * a meal plan alone never puts something on the list when the pantry is
   * sufficient. Every auto line carries a plain-English reason. Unconfirmed
   * lines already on the list count as confirmed incoming stock.
   */
  const genFromPantry = async () => {
    if (autoFillBusy) return;
    setAutoFillBusy(true);
    setAutoFillMessage("");
    try {
      const [{ data: inv }, { data: existing }, { data: ings }, { data: prefs }] = await Promise.all([
        hdb("hh_inventory_items").eq("household_id", hid).limit(1000).get(),
        hdb("hh_shopping_items").eq("household_id", hid).eq("checked", false).get(),
        hdb("hh_meal_ingredients").eq("household_id", hid).eq("status", "committed").limit(500).get(),
        hdb("hh_ingredient_prefs").eq("household_id", hid).limit(200).get(),
      ]);
      const committed = committedByItem(ings ?? []);
      const alreadyIds = new Set((existing ?? []).map((row) => Number(row.linked_pantry_id)).filter(Number.isFinite));
      const names = new Set((existing ?? []).map((row) => String(row.name || "").toLowerCase().trim()));
      // Unchecked list lines linked to an item = incoming stock (in the item's unit when convertible).
      const incomingByItem = new Map<number, number>();
      for (const row of existing ?? []) {
        const pid = Number(row.linked_pantry_id);
        if (!(pid > 0)) continue;
        const it = (inv ?? []).find((p) => Number(p.id) === pid);
        if (!it) continue;
        const conv = convertUnits(Number(row.quantity) || 0, String(row.unit || ""), String(it.unit || ""));
        incomingByItem.set(pid, (incomingByItem.get(pid) || 0) + (conv ?? (Number(row.quantity) || 0)));
      }
      const rows: Record<string, unknown>[] = [];
      for (const item of inv ?? []) {
        const pid = Number(item.id);
        if (alreadyIds.has(pid) || names.has(String(item.name || "").toLowerCase().trim())) continue;
        const st = computeItemStates(item as never, committed.get(pid) || 0);
        let req = shoppingRequirement({ onHand: st.onHand, committed: st.committed, minStock: st.minStock, incoming: incomingByItem.get(pid) || 0 });
        // Out-of-stock items with no minimum still deserve a restock suggestion.
        if (req <= 0 && st.onHand <= 0 && (incomingByItem.get(pid) || 0) <= 0) req = Number(item.preferred_purchase_qty) || 1;
        if (req <= 0) continue;
        const key = String(item.ingredient_key || ingredientKeyOf(item.name));
        const pref = (prefs ?? []).find((p) => String(p.ingredient_key) === key);
        const pkgSource = Number(item.package_size) > 0 && item.package_unit ? item : (pref && Number(pref.package_size) > 0 ? pref : null);
        const pkg = recommendPackage(req, st.unit, pkgSource as never);
        rows.push({
          household_id: hid, name: item.name, category: invCatKey(item.category),
          unit: pkg.unit || st.unit, quantity: pkg.qty || req,
          source: "pantry_low", linked_pantry_id: pid, checked: false, est_cost_ngn: 0, added_by: "OziUno",
          reason: st.onHand <= 0 && st.committed <= 0 && st.minStock <= 0
            ? `You're out of ${String(item.name)} at home.`
            : shoppingReason({ name: String(item.name), unit: st.unit, onHand: st.onHand, committed: st.committed, minStock: st.minStock, requirement: req }) + (pkgSource && pkg.label !== `${req} ${st.unit}` ? ` Suggested package: ${pkg.label}.` : ""),
          needed_qty: req, needed_unit: st.unit,
        });
      }
      if (!rows.length) {
        setAutoFillMessage("Nothing needs buying: your projected stock (on hand minus planned meals) covers every minimum. Meal plans alone never add items you already have.");
        return;
      }
      await hdb("hh_shopping_items").bulkInsert(rows);
      refresh();
      setAutoFillMessage(`Added ${rows.length} item${rows.length === 1 ? "" : "s"} — each with the calculation behind it (planned meals + minimum stock − what you have).`);
    } catch (error) {
      console.error("[OziUno] Smart list generation failed:", error);
      setAutoFillMessage("We couldn't generate the list. Please try again.");
    } finally {
      setAutoFillBusy(false);
    }
  };

  /**
   * "Already have it": the member tells us the REAL current stock — the ledger
   * gets a manual_adjustment transaction (never a silent overwrite) and the
   * line is removed because the need is covered.
   */
  const alreadyHave = async (it: Record<string, unknown>) => {
    const linked = Number(it.linked_pantry_id);
    const nameKey = String(it.name || "").toLowerCase().trim();
    const target = (invItems ?? []).find((p) => Number(p.id) === linked)
      || matchInventoryItem(invItems ?? [], it.name)
      || (invItems ?? []).find((p) => String(p.name || "").toLowerCase().trim() === nameKey);
    const unit = String(target?.unit || it.unit || "pcs");
    const raw = window.prompt(`How much ${String(it.name)} do you actually have at home? (in ${unit})`, target ? String(Number(target.quantity) || 0) : "1");
    if (raw == null) return;
    const actual = Number(raw);
    if (!(actual >= 0)) return;
    if (target) {
      const delta = Math.round((actual - (Number(target.quantity) || 0)) * 100) / 100;
      if (delta !== 0) {
        await postTxn(hid, target, { type: "manual_adjustment", delta, reason: `Stock confirmed while shopping: ${actual} ${unit}`, createdBy: member.name });
      }
    } else if (actual > 0) {
      const normalized = normalizeQuantityInput(actual, unit, String(it.name));
      await hdb("hh_inventory_items").insert({
        household_id: hid, name: String(it.name), category: invCatKey(it.category), ingredient_key: ingredientKeyOf(it.name),
        quantity: normalized.qty, unit: normalized.unit, status: "ok", added_by: member.name,
      });
      await recordOpeningBalances(hid);
    }
    await hdb("hh_shopping_items").delete(Number(it.id));
    setPurchaseNotice(`Updated: you have ${actual} ${unit} of ${String(it.name)} — removed it from the list and recorded the correction in the ledger.`);
    refresh(); refreshInv();
  };
  return (
    <PageShell eyebrow="Shopping" title="The list." subtitle="One consolidated list across every inventory category — ticking an item as bought restocks the inventory automatically." extra={<div style={{ textAlign: "right" }}><p className="ozi-muted" style={{ fontSize: 10, textTransform: "uppercase" }}>Estimated</p><p className="ozi-display" style={{ fontSize: "1.5rem" }}>{fmtN(total)}</p></div>}>
      <div style={{ display: "flex", gap: ".5rem", marginBottom: autoFillMessage ? ".5rem" : "1rem" }}>
        <button type="button" onClick={genFromPantry} disabled={autoFillBusy} className="ozi-btn-ghost" style={{ borderRadius: 9999, padding: ".375rem .75rem", fontSize: ".75rem", cursor: autoFillBusy ? "wait" : "pointer", opacity: autoFillBusy ? .6 : 1 }}><Sparkles size={14} /> {autoFillBusy ? "Checking inventory…" : "Auto-fill low stock"}</button>
        <button type="button" onClick={async () => { const checked = (data??[]).filter(i=>i.checked); for (const i of checked) await hdb("hh_shopping_items").delete(Number(i.id)); refresh(); }} className="ozi-btn-ghost" style={{ borderRadius: 9999, padding: ".375rem .75rem", fontSize: ".75rem", cursor: "pointer" }}>Clear checked</button>
      </div>
      {autoFillMessage && <p role="status" className="ozi-muted" style={{ fontSize: ".75rem", marginBottom: "1rem" }}>{autoFillMessage}</p>}
      {purchaseNotice && <p role="status" style={{ fontSize: ".75rem", marginBottom: "1rem", color: "#0d9488" }}>{purchaseNotice}</p>}
      <form onSubmit={add} className="ozi-card" style={{ display: "flex", flexWrap: "wrap", gap: ".5rem", marginBottom: "1.5rem" }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What to buy" className="ozi-input" style={{ flex: 1, minWidth: 180 }} />
        <input value={cost} onChange={(e) => setCost(e.target.value)} type="number" min={0} placeholder={`${currencySymbol()} cost`} className="ozi-input" style={{ width: 96 }} />
        <button className="ozi-btn"><Plus size={16} /> Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
        {(data ?? []).map((it) => (
          <li key={String(it.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".75rem", padding: ".75rem", opacity: it.checked ? .5 : 1 }}>
            <input type="checkbox" checked={!!it.checked} onChange={async (e) => {
              const nowChecked = e.target.checked;
              await hdb("hh_shopping_items").update(Number(it.id), { checked: nowChecked });
              // Purchased → restock the pantry with the bought quantity (in the
              // pantry item's own unit); un-ticking reverses it.
              const note = await applyPurchaseToPantry(hid, it, nowChecked ? 1 : -1, member.name);
              if (note) setPurchaseNotice(note);
              refresh();
            }} />
            <div style={{ flex: 1 }}><p style={{ fontSize: ".875rem", fontWeight: 500, textDecoration: it.checked ? "line-through" : "none" }}>{String(it.name)}</p>
              <p className="ozi-muted" style={{ fontSize: ".75rem" }}>{it.quantity} {String(it.unit)}{invContext(it)}{it.source === "pantry_low" ? " • needed" : it.source === "ai" ? " • suggested" : ""}{it.added_by ? ` • added by ${String(it.added_by) === member.name ? "you" : String(it.added_by)}` : ""}</p>
              {it.reason ? <p className="ozi-muted" style={{ fontSize: ".6875rem", fontStyle: "italic", marginTop: 2 }}>Why: {String(it.reason)}</p> : null}</div>
            <span className="ozi-muted" style={{ fontSize: ".75rem" }}>{fmtN(Number(it.est_cost_ngn))}</span>
            {!it.checked && <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".6875rem", padding: ".25rem .5rem" }} title="I already have this at home — update the inventory instead" onClick={() => void alreadyHave(it)}>Have it</button>}
            <EditBtn onClick={() => setEditing(it)} />
            <button onClick={async () => { await hdb("hh_shopping_items").delete(Number(it.id)); refresh(); }} style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
      {editing && (
        <EditEntryModal
          title={`Edit ${String(editing.name)}`}
          fields={[
            { key: "name", label: "Item" },
            { key: "quantity", label: "Quantity", type: "number" },
            { key: "unit", label: "Unit" },
            { key: "cost", label: `Est. cost (${currencySymbol()})`, type: "number" },
          ]}
          initial={{ name: String(editing.name || ""), quantity: String(editing.quantity ?? 1), unit: String(editing.unit || "unit"), cost: String(editing.est_cost_ngn ?? 0) }}
          onSave={async (v) => {
            if (!v.name.trim()) throw new Error("name required");
            await hdb("hh_shopping_items").update(Number(editing.id), { name: v.name.trim(), quantity: Number(v.quantity) || 1, unit: v.unit.trim() || "unit", est_cost_ngn: Number(v.cost) || 0 });
            refresh();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </PageShell>
  );
}

const WASTE_GROUPS: { type: string; title: string; blurb: string }[] = [
  { type: "risk", title: "Waste risk alerts", blurb: "Use these before they're wasted." },
  { type: "pattern", title: "Consumption patterns", blurb: "What your household actually uses — and how fast." },
  { type: "recommendation", title: "Smart purchases", blurb: "Right-size what you buy so nothing sits and spoils." },
  { type: "savings", title: "Savings", blurb: "What using everything you buy is worth." },
];

function WasteSeverityChip({ severity }: { severity: WasteSeverity }) {
  const colors: Record<WasteSeverity, { bg: string; fg: string }> = {
    use_today: { bg: "rgba(220,38,38,.12)", fg: "#dc2626" },
    use_soon: { bg: "rgba(245,158,11,.2)", fg: "#b45309" },
    likely_wasted: { bg: "rgba(225,29,72,.12)", fg: "#9f1239" },
    info: { bg: "rgba(13,148,136,.1)", fg: "#0d9488" },
    positive: { bg: "rgba(45,212,191,.16)", fg: "#0d9488" },
  };
  const c = colors[severity] || colors.info;
  return <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", background: c.bg, color: c.fg, borderRadius: 9999, padding: "2px 8px", whiteSpace: "nowrap" }}>{WASTE_SEVERITY_LABELS[severity] || severity}</span>;
}

function WasteLessView({ ctx }: { ctx: HHCtx }) {
  const { hid, member, go } = ctx;
  const monthAgoISO = useMemo(() => new Date(Date.now() - 30 * 86400000).toISOString(), []);
  const { data: pantry, loading: lPantry, refresh: rPantry } = window.useWorkspaceDB("hh_inventory_items", { shared: true, filters: hhFilter(hid), limit: 500 });
  const { data: shopping, loading: lShopping, refresh: rShopping } = window.useWorkspaceDB("hh_shopping_items", { shared: true, filters: hhFilter(hid), limit: 100 });
  const { data: usageLog, loading: lLog } = window.useWorkspaceDB("hh_consumption_log", { shared: true, filters: [...hhFilter(hid), { column: "created_at", operator: "gte", value: monthAgoISO }], limit: 100 });
  const { data: ledger, loading: lLedger, refresh: rLedger } = window.useWorkspaceDB("hh_inventory_ledger", { shared: true, filters: [...hhFilter(hid), { column: "created_at", operator: "gte", value: monthAgoISO }], limit: 500 });
  const { data: insights, loading: lIns, refresh: rInsights } = window.useWorkspaceDB("hh_wasteless_insights", { shared: true, filters: hhFilter(hid), orderBy: { column: "created_at", direction: "desc" }, limit: 100 });
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const syncedRef = useRef(false);

  // Usage for analytics = legacy consumption log + the new transaction ledger.
  const usageRows = useMemo(() => usageRowsForStats(usageLog ?? [], ledger ?? []), [usageLog, ledger]);
  // Waste analytics come from explicit waste_spoilage transactions — waste is
  // never a silent quantity edit, so this is real recorded data.
  const wasteAnalytics = useMemo(() => {
    const stats = computeConsumptionStats(pantry ?? [], shopping ?? [], usageRows);
    const byItem = new Map<string, { name: string; qty: number; unit: string; events: number; estValue: number }>();
    let totalValue = 0;
    for (const l of ledger ?? []) {
      if (String(l.txn_type) !== "waste_spoilage") continue;
      const q = -(Number(l.qty_delta) || 0);
      if (q <= 0) continue;
      const key = wlNorm(l.item_name);
      const s = stats.get(key);
      const value = (s && s.avgCost) || 0;
      totalValue += value;
      const cur = byItem.get(key) || { name: String(l.item_name || key), qty: 0, unit: String(l.unit || ""), events: 0, estValue: 0 };
      cur.qty = Math.round((cur.qty + q) * 100) / 100; cur.events += 1; cur.estValue += value;
      byItem.set(key, cur);
    }
    const top = [...byItem.values()].sort((a, b) => b.estValue - a.estValue || b.events - a.events).slice(0, 5);
    return { top, totalValue: Math.round(totalValue), events: [...byItem.values()].reduce((s, x) => s + x.events, 0) };
  }, [ledger, pantry, shopping, usageRows]);

  // Generate today's insights once per open — the table's dedup key stops repeats.
  useEffect(() => {
    if (syncedRef.current || lPantry || lShopping || lLog || lLedger || lIns) return;
    syncedRef.current = true;
    void (async () => {
      try {
        const added = await syncWasteInsights(hid, pantry ?? [], shopping ?? [], usageRows, insights ?? []);
        if (added) rInsights();
      } catch (err) { console.warn("[OziUno] WasteLess insight sync failed:", err); }
    })();
  }, [hid, lPantry, lShopping, lLog, lLedger, lIns, pantry, shopping, usageRows, insights, rInsights]);

  const active = (insights ?? []).filter((i) => String(i.status) === "active");
  const resolved = (insights ?? []).filter((i) => String(i.status) === "done");
  const ym = monthKey().slice(0, 7);
  const resolvedThisMonth = resolved.filter((i) => String(i.resolved_at || i.updated_at || "").slice(0, 7) === ym);
  const savedTotal = resolved.reduce((s, i) => s + (Number(i.est_value_ngn) || 0), 0);
  const risks = (pantry ?? []).map((p) => assessPantryRisk(p)).filter((r): r is WasteRisk => !!r);
  const monthlyEstimate = active.filter((i) => String(i.insight_type) === "risk" && String(i.severity) === "likely_wasted").reduce((s, i) => s + (Number(i.est_value_ngn) || 0), 0);
  const score = computeWasteScore(risks, resolvedThisMonth.length);
  const hasAnyData = (pantry ?? []).length > 0 || (shopping ?? []).length > 0;

  const resolveInsight = async (ins: Record<string, unknown>, action: string, extraNote?: string) => {
    await hdb("hh_wasteless_insights").update(Number(ins.id), { status: action === "dismissed" ? "dismissed" : "done", action_taken: action, resolved_at: new Date().toISOString() });
    rInsights();
    if (extraNote) setNotice(extraNote);
  };

  // "Used it" records a real consumption transaction (never a silent zero-out).
  const markUsed = async (ins: Record<string, unknown>) => {
    setBusyId(Number(ins.id));
    try {
      const item = (pantry ?? []).find((p) => Number(p.id) === Number(ins.pantry_item_id));
      if (item && (Number(item.quantity) || 0) > 0) {
        await postTxn(hid, item, { type: "consumption", delta: -(Number(item.quantity) || 0), reason: `Used up before waste (WasteLess): ${String(ins.item_name)}`, createdBy: member.name });
      }
      await resolveInsight(ins, "used", `Nice — ${String(ins.item_name)} used before it went to waste${Number(ins.est_value_ngn) ? ` (≈${fmtN(Number(ins.est_value_ngn))} saved)` : ""}. Your WasteLess score just went up.`);
      rPantry(); rLedger();
    } finally { setBusyId(null); }
  };

  // "It spoiled" records an explicit waste_spoilage transaction in the ledger.
  const markWasted = async (ins: Record<string, unknown>) => {
    setBusyId(Number(ins.id));
    try {
      const item = (pantry ?? []).find((p) => Number(p.id) === Number(ins.pantry_item_id));
      if (item && (Number(item.quantity) || 0) > 0) {
        await recordWaste(hid, item, Number(item.quantity) || 0, String(item.unit || "pcs"), `Spoiled: ${String(ins.item_name)} (WasteLess alert)`, member.name);
      }
      await resolveInsight(ins, "wasted", `${String(ins.item_name)} recorded as waste — it now counts in your waste analytics so OziUno can help you buy smarter.`);
      rPantry(); rLedger();
    } finally { setBusyId(null); }
  };

  const addToMealPlan = async (ins: Record<string, unknown>) => {
    setBusyId(Number(ins.id));
    try {
      const { data: planned } = await hdb("hh_meal_plans").eq("household_id", hid).gte("date", localDateKey()).get();
      const taken = new Set((planned ?? []).map((m) => `${String(m.date).slice(0, 10)}|${String(m.meal)}`));
      let slot: { date: string; meal: string } | null = null;
      for (let d = 0; d < 3 && !slot; d++) {
        const date = localDateKey(new Date(Date.now() + d * 86400000));
        for (const meal of ["dinner", "lunch", "breakfast"]) {
          if (!taken.has(`${date}|${meal}`)) { slot = { date, meal }; break; }
        }
      }
      if (!slot) { setNotice("The next 3 days are fully planned — open Meals to swap a dish for it."); go("meals"); return; }
      await hdb("hh_meal_plans").insert({ household_id: hid, date: slot.date, meal: slot.meal, title: `Use-it-up: ${String(ins.item_name)}`, recipe_md: `Planned by WasteLess to use up ${String(ins.item_name)} before it's wasted.`, added_by: member.name });
      await resolveInsight(ins, "planned", `Planned "${String(ins.item_name)}" into ${slot.meal} on ${slot.date}.`);
    } finally { setBusyId(null); }
  };

  const removeFromList = async (ins: Record<string, unknown>) => {
    setBusyId(Number(ins.id));
    try {
      const row = (shopping ?? []).find((s) => Number(s.id) === Number(ins.shopping_item_id));
      if (row) await hdb("hh_shopping_items").delete(Number(row.id));
      await resolveInsight(ins, "removed", `${String(ins.item_name)} removed from the shopping list.`);
      rShopping();
    } finally { setBusyId(null); }
  };

  return (
    <PageShell eyebrow="WasteLess" title="Waste less. Save more." subtitle="OziUno watches your whole household inventory, shopping and meals to catch food and money before they're wasted." extra={<button className="ozi-btn-ghost ozi-btn" onClick={() => { syncedRef.current = false; rPantry(); rShopping(); rLedger(); rInsights(); }}><RefreshCw size={16} /> Refresh</button>}>
      {notice && <p role="status" style={{ fontSize: ".8125rem", marginBottom: "1rem", color: "#0d9488" }}>{notice}</p>}
      <div className="ozi-grid ozi-grid-3" style={{ marginBottom: "1.5rem" }}>
        <section className="ozi-card">
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", display: "flex", alignItems: "center", gap: ".375rem" }}><AlertTriangle size={13} /> Items at risk</h2>
          <p className="ozi-display" style={{ fontSize: "2rem" }}>{risks.length}</p>
          <p className="ozi-muted" style={{ fontSize: ".75rem" }}>{risks.length ? "Use them before they're wasted." : "Nothing about to go to waste."}</p>
        </section>
        <section className="ozi-card">
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", display: "flex", alignItems: "center", gap: ".375rem" }}><PiggyBank size={13} /> Savings</h2>
          <p className="ozi-display" style={{ fontSize: "2rem" }}>{fmtN(savedTotal)}</p>
          <p className="ozi-muted" style={{ fontSize: ".75rem" }}>{monthlyEstimate > 0 ? `Saved so far — plus ${fmtN(monthlyEstimate)} still on the table this month.` : "Saved by using things before they expired."}</p>
        </section>
        <section className="ozi-card">
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", display: "flex", alignItems: "center", gap: ".375rem" }}><Leaf size={13} /> WasteLess score</h2>
          <p className="ozi-display" style={{ fontSize: "2rem" }}>{score}<span className="ozi-muted" style={{ fontSize: ".875rem" }}> / 100</span></p>
          <div className="ozi-progress" style={{ marginTop: ".375rem" }}><span style={{ width: `${score}%` }} /></div>
          <p className="ozi-muted" style={{ fontSize: ".75rem", marginTop: ".375rem" }}>{score >= 85 ? "Excellent — very little goes to waste." : score >= 60 ? "Good — act on the alerts below to climb." : "Lots of easy wins below."}</p>
        </section>
      </div>
      {!hasAnyData && (
        <div className="ozi-card" style={{ textAlign: "center", padding: "2rem" }}>
          <Leaf size={28} style={{ color: "#0d9488", margin: "0 auto .5rem" }} />
          <p style={{ fontSize: "1rem", fontWeight: 600 }}>No history yet — and that's fine.</p>
          <p className="ozi-muted" style={{ fontSize: ".875rem", marginTop: ".375rem" }}>Add inventory items (with expiry dates where you can), keep the shopping list going, and plan meals — WasteLess learns your household's pace and starts catching waste automatically.</p>
          <button className="ozi-btn" style={{ marginTop: "1rem" }} onClick={() => go("pantry")}><Package size={16} /> Set up the inventory</button>
        </div>
      )}
      {WASTE_GROUPS.map((g) => {
        const list = active.filter((i) => String(i.insight_type) === g.type);
        if (!list.length) return null;
        return (
          <div key={g.type} style={{ marginBottom: "2rem" }}>
            <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".25rem" }}>{g.title}</h2>
            <p className="ozi-muted" style={{ fontSize: ".75rem", marginBottom: ".75rem" }}>{g.blurb}</p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
              {list.map((ins) => (
                <li key={String(ins.id)} className="ozi-card" style={{ padding: ".875rem", display: "flex", flexDirection: "column", gap: ".5rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                    {ins.item_name ? <p style={{ fontSize: ".875rem", fontWeight: 600, margin: 0 }}>{String(ins.item_name)}</p> : null}
                    <WasteSeverityChip severity={String(ins.severity) as WasteSeverity} />
                    {Number(ins.est_value_ngn) > 0 ? <span className="ozi-muted" style={{ fontSize: ".6875rem" }}>≈{fmtN(Number(ins.est_value_ngn))}</span> : null}
                  </div>
                  <p className="ozi-muted" style={{ fontSize: ".8125rem", margin: 0 }}>{String(ins.message)}</p>
                  <div style={{ display: "flex", gap: ".375rem", flexWrap: "wrap" }}>
                    {g.type === "risk" && (
                      <>
                        <button className="ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busyId === Number(ins.id)} onClick={() => void addToMealPlan(ins)}><ChefHat size={13} /> Add to meal plan</button>
                        <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busyId === Number(ins.id)} onClick={() => void markUsed(ins)}><Check size={13} /> Mark as used</button>
                        <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busyId === Number(ins.id)} onClick={() => void markWasted(ins)}><Trash2 size={13} /> It spoiled</button>
                      </>
                    )}
                    {g.type === "recommendation" && ins.shopping_item_id ? (
                      <button className="ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busyId === Number(ins.id)} onClick={() => void removeFromList(ins)}><Trash2 size={13} /> Remove from list</button>
                    ) : null}
                    <button className="ozi-btn-ghost ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busyId === Number(ins.id)} onClick={() => void resolveInsight(ins, "dismissed")}>Dismiss</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {wasteAnalytics.events > 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".25rem" }}>Recorded waste (last 30 days)</h2>
          <p className="ozi-muted" style={{ fontSize: ".75rem", marginBottom: ".75rem" }}>
            From explicit waste transactions in your inventory ledger — {wasteAnalytics.events} event{wasteAnalytics.events === 1 ? "" : "s"}
            {wasteAnalytics.totalValue > 0 ? `, roughly ${fmtN(wasteAnalytics.totalValue)} (estimate from your typical purchase costs)` : ""}.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".375rem" }}>
            {wasteAnalytics.top.map((w) => (
              <li key={w.name} className="ozi-card" style={{ padding: ".625rem .875rem", display: "flex", justifyContent: "space-between", gap: ".5rem", flexWrap: "wrap" }}>
                <span style={{ fontSize: ".8125rem", fontWeight: 500 }}>{w.name}</span>
                <span className="ozi-muted" style={{ fontSize: ".75rem" }}>{w.qty} {w.unit} · {w.events} event{w.events === 1 ? "" : "s"}{w.estValue > 0 ? ` · ≈${fmtN(Math.round(w.estValue))}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasAnyData && !active.length && (
        <div className="ozi-card" style={{ textAlign: "center", padding: "1.5rem" }}>
          <p style={{ fontSize: ".9375rem", fontWeight: 600 }}>All clear — nothing needs your attention.</p>
          <p className="ozi-muted" style={{ fontSize: ".8125rem", marginTop: ".25rem" }}>WasteLess re-checks every time you open this screen, and the morning briefing will nudge you if something starts to slip.</p>
        </div>
      )}
      {resolvedThisMonth.length > 0 && (
        <p className="ozi-muted" style={{ fontSize: ".75rem", marginTop: "1rem" }}>
          <Check size={12} style={{ verticalAlign: "-2px" }} /> {resolvedThisMonth.length} insight{resolvedThisMonth.length === 1 ? "" : "s"} acted on this month — that's how the score climbs.
        </p>
      )}
    </PageShell>
  );
}

function ScheduleView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  const { data, refresh } = window.useWorkspaceDB("hh_schedule_events", { shared: true, filters: hhFilter(hid), orderBy: { column: "starts_at", direction: "asc" } });
  const { data: fam } = window.useWorkspaceDB("household_memberships", { shared: true, filters: [...hhFilter(hid), { column: "status", operator: "eq", value: "active" }], orderBy: { column: "name", direction: "asc" } });
  const [title, setTitle] = useState(""); const [when, setWhen] = useState(""); const [category, setCategory] = useState("family"); const [notes, setNotes] = useState(""); const [forMember, setForMember] = useState("");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const CATS = ["school","delivery","chore","family","maintenance","other"];
  const isChild = member.role === "child";
  const visible = (data ?? []).filter((ev) => !isChild || !ev.member_name || String(ev.member_name) === member.name);
  const add = async (e: FormEvent) => {
    e.preventDefault(); if (!title.trim() || !when) return;
    await hdb("hh_schedule_events").insert({ household_id: hid, title: title.trim(), notes: notes.trim()||null, starts_at: new Date(when).toISOString(), category, member_name: forMember || null, added_by: member.name });
    setTitle(""); setWhen(""); setNotes(""); setForMember(""); refresh();
  };
  const groups: Record<string, typeof visible> = {};
  visible.forEach((ev) => { const day = new Date(String(ev.starts_at)).toDateString(); (groups[day] ||= []).push(ev); });
  return (
    <PageShell eyebrow="Schedule" title="Everything coming up." subtitle={isChild ? "Your activities and family events." : "The shared family calendar."}>
      <form onSubmit={add} className="ozi-card" style={{ display: "grid", gap: ".5rem", marginBottom: "1.5rem" }}>
        <div style={{ display: "grid", gap: ".5rem", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event" className="ozi-input" />
          <input value={when} onChange={(e) => setWhen(e.target.value)} type="datetime-local" className="ozi-input" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="ozi-input">{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <select value={forMember} onChange={(e) => setForMember(e.target.value)} className="ozi-input"><option value="">Whole household</option>{(fam??[]).map((m) => <option key={String(m.id)} value={String(m.name)}>{String(m.name)}</option>)}</select>
          <button className="ozi-btn"><Plus size={16} /> Add</button>
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="ozi-input" />
      </form>
      {Object.entries(groups).map(([day, evs]) => (
        <div key={day} style={{ marginBottom: "2rem" }}>
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".75rem" }}>{new Date(day).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
            {(evs ?? []).map((ev) => (
              <li key={String(ev.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".75rem", padding: ".75rem" }}>
                <div className="ozi-muted" style={{ width: 56, fontSize: ".75rem", flexShrink: 0 }}>{new Date(String(ev.starts_at)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
                <div style={{ flex: 1 }}><p style={{ fontSize: ".875rem", fontWeight: 500 }}>{String(ev.title)}</p><p className="ozi-muted" style={{ fontSize: ".75rem" }}>{String(ev.category)}{ev.member_name ? ` • for ${String(ev.member_name)}` : ""}{ev.notes ? ` • ${String(ev.notes)}` : ""}</p></div>
                <EditBtn onClick={() => setEditing(ev)} />
                <button onClick={async () => { await hdb("hh_schedule_events").delete(Number(ev.id)); refresh(); }} style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!visible.length && <p className="ozi-muted">Nothing scheduled.</p>}
      {editing && (
        <EditEntryModal
          title={`Edit ${String(editing.title)}`}
          fields={[
            { key: "title", label: "Event" },
            { key: "when", label: "When", type: "datetime-local" },
            { key: "category", label: "Category", type: "select", options: CATS.map((c) => ({ value: c, label: c })) },
            { key: "member", label: "Who it's for", type: "select", options: [{ value: "", label: "Whole household" }, ...(fam ?? []).map((m) => ({ value: String(m.name), label: String(m.name) }))] },
            { key: "notes", label: "Notes", placeholder: "Optional" },
          ]}
          initial={{ title: String(editing.title || ""), when: toLocalInputValue(editing.starts_at), category: String(editing.category || "family"), member: String(editing.member_name || ""), notes: String(editing.notes || "") }}
          onSave={async (v) => {
            if (!v.title.trim() || !v.when) throw new Error("missing fields");
            await hdb("hh_schedule_events").update(Number(editing.id), { title: v.title.trim(), starts_at: new Date(v.when).toISOString(), category: v.category, member_name: v.member || null, notes: v.notes.trim() || null });
            refresh();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </PageShell>
  );
}

function TasksView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  const { data, refresh } = window.useWorkspaceDB("hh_tasks", { shared: true, filters: hhFilter(hid), orderBy: { column: "due_at", direction: "asc" } });
  const { data: fam } = window.useWorkspaceDB("household_memberships", { shared: true, filters: [...hhFilter(hid), { column: "status", operator: "eq", value: "active" }], orderBy: { column: "name", direction: "asc" } });
  const [title, setTitle] = useState(""); const [assignee, setAssignee] = useState(""); const [due, setDue] = useState(""); const [visibility, setVisibility] = useState("household");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const myEmail = (member.email || "").toLowerCase();
  const isChild = member.role === "child";
  const visible = (data ?? []).filter((t) => {
    if (String(t.visibility) === "personal" && String(t.created_by_email || "").toLowerCase() !== myEmail && String(t.assignee_email || "").toLowerCase() !== myEmail) return false;
    if (isChild) return String(t.assignee_name || "") === member.name || String(t.assignee_email || "").toLowerCase() === myEmail;
    return true;
  });
  const add = async (e: FormEvent) => {
    e.preventDefault(); if (!title.trim()) return;
    const assigned = (fam ?? []).find((m) => String(m.id) === assignee);
    await hdb("hh_tasks").insert({
      household_id: hid, title: title.trim(), category: "general",
      assignee_name: assigned ? String(assigned.name) : (isChild ? member.name : null),
      assignee_email: assigned && assigned.email ? String(assigned.email).toLowerCase() : (isChild ? myEmail || null : null),
      due_at: due ? new Date(due).toISOString() : null, recurrence: null,
      visibility, created_by_email: myEmail || null, added_by: member.name,
    });
    setTitle(""); setDue(""); refresh();
  };
  return (
    <PageShell eyebrow="Tasks" title="Chores & to-dos." subtitle={isChild ? "Your chores and tasks." : 'Household chores are shared; "Just for me" tasks stay private to you.'}>
      <form onSubmit={add} className="ozi-card" style={{ display: "grid", gap: ".5rem", marginBottom: "1.5rem", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task" className="ozi-input" />
        {!isChild && (
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="ozi-input"><option value="">Unassigned</option>{(fam??[]).map((m) => <option key={String(m.id)} value={String(m.id)}>{String(m.name)}</option>)}</select>
        )}
        <input value={due} onChange={(e) => setDue(e.target.value)} type="datetime-local" className="ozi-input" />
        {!isChild && (
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="ozi-input">
            <option value="household">Whole household</option>
            <option value="personal">Just for me (private)</option>
          </select>
        )}
        <button className="ozi-btn"><Plus size={16} /> Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
        {visible.map((t) => {
          const done = !!t.completed_at;
          return (
            <li key={String(t.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".75rem", padding: ".75rem", opacity: done ? .5 : 1 }}>
              <input type="checkbox" checked={done} onChange={async (e) => { await hdb("hh_tasks").update(Number(t.id), { completed_at: e.target.checked ? new Date().toISOString() : null }); refresh(); }} />
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: ".875rem", fontWeight: 500, textDecoration: done ? "line-through" : "none" }}>{String(t.title)}{String(t.visibility) === "personal" ? <span className="ozi-muted" style={{ fontSize: ".6875rem" }}> · private</span> : null}</p>
                <p className="ozi-muted" style={{ fontSize: ".75rem" }}>{t.assignee_name ? String(t.assignee_name) : "Unassigned"}{t.due_at ? ` • ${new Date(String(t.due_at)).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}</p>
              </div>
              <EditBtn onClick={() => setEditing(t)} />
              <button onClick={async () => { await hdb("hh_tasks").delete(Number(t.id)); refresh(); }} style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={16} /></button>
            </li>
          );
        })}
        {!visible.length && <p className="ozi-muted" style={{ fontSize: ".875rem" }}>No tasks yet.</p>}
      </ul>
      {editing && (
        <EditEntryModal
          title={`Edit ${String(editing.title)}`}
          fields={[
            { key: "title", label: "Task" },
            ...(!isChild ? [{ key: "assignee", label: "Assigned to", type: "select" as const, options: [{ value: "", label: "Unassigned" }, ...(fam ?? []).map((m) => ({ value: String(m.name), label: String(m.name) }))] }] : []),
            { key: "due", label: "Due", type: "datetime-local" as const },
            ...(!isChild ? [{ key: "visibility", label: "Visibility", type: "select" as const, options: [{ value: "household", label: "Whole household" }, { value: "personal", label: "Just for me (private)" }] }] : []),
          ]}
          initial={{ title: String(editing.title || ""), assignee: String(editing.assignee_name || ""), due: editing.due_at ? toLocalInputValue(editing.due_at) : "", visibility: String(editing.visibility || "household") }}
          onSave={async (v) => {
            if (!v.title.trim()) throw new Error("title required");
            const assigned = (fam ?? []).find((m) => String(m.name) === v.assignee);
            const patch: Record<string, unknown> = { title: v.title.trim(), due_at: v.due ? new Date(v.due).toISOString() : null };
            if (!isChild) {
              patch.assignee_name = assigned ? String(assigned.name) : null;
              patch.assignee_email = assigned && assigned.email ? String(assigned.email).toLowerCase() : null;
              patch.visibility = v.visibility;
            }
            await hdb("hh_tasks").update(Number(editing.id), patch);
            refresh();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </PageShell>
  );
}

function MaintenanceView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  const { data, refresh } = window.useWorkspaceDB("hh_maintenance_tasks", { shared: true, filters: hhFilter(hid), orderBy: { column: "next_due_at", direction: "asc" } });
  const [asset, setAsset] = useState(""); const [category, setCategory] = useState("appliance"); const [interval, setInterval] = useState("90"); const [due, setDue] = useState("");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const CATS = ["appliance","home","safety","vehicle","other"];
  const add = async (e: FormEvent) => {
    e.preventDefault(); if (!asset.trim() || !due) return;
    await hdb("hh_maintenance_tasks").insert({ household_id: hid, asset: asset.trim(), category, interval_days: Number(interval)||90, next_due_at: due, notes: null, added_by: member.name });
    setAsset(""); setDue(""); refresh();
  };
  return (
    <PageShell eyebrow="Maintenance" title="Keep the house running." subtitle="Track appliances and home care so nothing quietly breaks.">
      <form onSubmit={add} className="ozi-card" style={{ display: "grid", gap: ".5rem", marginBottom: "1.5rem", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))" }}>
        <input value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="Asset (e.g. Generator)" className="ozi-input" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="ozi-input">{CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <input value={interval} onChange={(e) => setInterval(e.target.value)} type="number" min={1} placeholder="days" className="ozi-input" />
        <input value={due} onChange={(e) => setDue(e.target.value)} type="date" className="ozi-input" />
        <button className="ozi-btn"><Plus size={16} /> Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
        {(data ?? []).map((t) => {
          const days = Math.ceil((new Date(String(t.next_due_at)).getTime() - Date.now()) / 86400000);
          const badge = days < 0 ? { bg: "rgba(220,38,38,.1)", color: "#dc2626", text: `${Math.abs(days)}d overdue` } : days <= 7 ? { bg: "rgba(245,158,11,.2)", color: "#b45309", text: days === 0 ? "Due today" : `in ${days}d` } : { bg: "#e2e8f0", color: "#5b6b81", text: `in ${days}d` };
          return (
            <li key={String(t.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".75rem", padding: ".75rem" }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(13,148,136,.1)", color: "#0d9488", display: "grid", placeItems: "center" }}><Wrench size={16} /></div>
              <div style={{ flex: 1 }}><p style={{ fontSize: ".875rem", fontWeight: 500 }}>{String(t.asset)}</p><p className="ozi-muted" style={{ fontSize: ".75rem" }}>{String(t.category)} • every {t.interval_days} days</p></div>
              <span style={{ fontSize: 10, fontWeight: 500, borderRadius: 9999, padding: "2px 8px", background: badge.bg, color: badge.color }}>{badge.text}</span>
              <button onClick={async () => { const nd = new Date(); nd.setDate(nd.getDate() + Number(t.interval_days)); await hdb("hh_maintenance_tasks").update(Number(t.id), { last_serviced_at: new Date().toISOString().slice(0,10), next_due_at: nd.toISOString().slice(0,10) }); refresh(); }} aria-label="Mark serviced" style={{ border: "none", background: "transparent", cursor: "pointer" }}><Check size={16} /></button>
              <EditBtn onClick={() => setEditing(t)} />
              <button onClick={async () => { await hdb("hh_maintenance_tasks").delete(Number(t.id)); refresh(); }} style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={16} /></button>
            </li>
          );
        })}
      </ul>
      {editing && (
        <EditEntryModal
          title={`Edit ${String(editing.asset)}`}
          fields={[
            { key: "asset", label: "Asset" },
            { key: "category", label: "Category", type: "select", options: CATS.map((c) => ({ value: c, label: c })) },
            { key: "interval", label: "Service interval (days)", type: "number" },
            { key: "due", label: "Next due", type: "date" },
          ]}
          initial={{ asset: String(editing.asset || ""), category: String(editing.category || "appliance"), interval: String(editing.interval_days ?? 90), due: String(editing.next_due_at || "").slice(0, 10) }}
          onSave={async (v) => {
            if (!v.asset.trim() || !v.due) throw new Error("missing fields");
            await hdb("hh_maintenance_tasks").update(Number(editing.id), { asset: v.asset.trim(), category: v.category, interval_days: Number(v.interval) || 90, next_due_at: v.due });
            refresh();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </PageShell>
  );
}

function BillsView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  const { data, refresh } = window.useWorkspaceDB("hh_bills", { shared: true, filters: hhFilter(hid), orderBy: { column: "due_date", direction: "asc" } });
  const { data: fam } = window.useWorkspaceDB("household_memberships", { shared: true, filters: [...hhFilter(hid), { column: "status", operator: "eq", value: "active" }], orderBy: { column: "name", direction: "asc" } });
  const [name, setName] = useState(""); const [amount, setAmount] = useState(""); const [due, setDue] = useState(""); const [assignedTo, setAssignedTo] = useState("");
  const [billCat, setBillCat] = useState("utility");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const unpaid = (data ?? []).filter((b) => !b.paid);
  const total = unpaid.reduce((s, b) => s + Number(b.amount_ngn), 0);
  const add = async (e: FormEvent) => {
    e.preventDefault(); if (!name.trim() || !amount || !due) return;
    await hdb("hh_bills").insert({ household_id: hid, name: name.trim(), amount_ngn: Number(amount), due_date: due, category: billCat, paid: false, assigned_to: assignedTo || null, added_by: member.name });
    setName(""); setAmount(""); setDue(""); setAssignedTo(""); setBillCat("utility"); refresh();
  };
  return (
    <PageShell eyebrow="Bills" title="What's due." subtitle="Shared with adults in the household." extra={<div style={{ textAlign: "right" }}><p className="ozi-muted" style={{ fontSize: 10, textTransform: "uppercase" }}>Outstanding</p><p className="ozi-display" style={{ fontSize: "1.5rem" }}>{fmtN(total)}</p></div>}>
      <form onSubmit={add} className="ozi-card" style={{ display: "grid", gap: ".5rem", marginBottom: "1.5rem", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))" }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bill name" className="ozi-input" />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min={0} placeholder="Amount" className="ozi-input" />
        <input value={due} onChange={(e) => setDue(e.target.value)} type="date" className="ozi-input" />
        <select value={billCat} onChange={(e) => setBillCat(e.target.value)} className="ozi-input" style={{ textTransform: "capitalize" }}>{BILL_CATS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="ozi-input"><option value="">Anyone</option>{(fam??[]).map((m) => <option key={String(m.id)} value={String(m.name)}>{String(m.name)}</option>)}</select>
        <button className="ozi-btn"><Plus size={16} /> Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
        {(data ?? []).map((b) => {
          const days = Math.ceil((new Date(String(b.due_date)).getTime() - Date.now()) / 86400000);
          return (
            <li key={String(b.id)} className="ozi-card" style={{ display: "flex", alignItems: "center", gap: ".75rem", padding: ".75rem", opacity: b.paid ? .6 : 1 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: ".875rem", fontWeight: 500, textDecoration: b.paid ? "line-through" : "none" }}>{String(b.name)}</p>
                <p className="ozi-muted" style={{ fontSize: ".75rem" }}>{b.paid ? "Paid" : days < 0 ? `Overdue by ${Math.abs(days)} day${Math.abs(days)===1?"":"s"}` : days === 0 ? "Due today" : `Due in ${days} day${days===1?"":"s"}`} • {String(b.category)}{b.assigned_to ? ` • ${String(b.assigned_to)}'s bill` : ""}</p>
              </div>
              <span style={{ fontSize: ".875rem", fontWeight: 500 }}>{fmtN(Number(b.amount_ngn))}</span>
              <button onClick={async () => { const nowPaid = !b.paid; await hdb("hh_bills").update(Number(b.id), { paid: nowPaid, paid_at: nowPaid ? new Date().toISOString() : null }); await syncBudgetForBill(hid, String(b.category), Number(b.amount_ngn), nowPaid ? 1 : -1); refresh(); }} aria-label={b.paid ? "Mark as not paid" : "Mark as paid"} title={b.paid ? "Mark as not paid — removes it from this month's budget" : "Mark as paid — adds it to this month's budget"} style={{ border: "none", background: "transparent", cursor: "pointer" }}><Check size={16} /></button>
              <EditBtn onClick={() => setEditing(b)} />
              <button onClick={async () => { await hdb("hh_bills").delete(Number(b.id)); refresh(); }} style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={16} /></button>
            </li>
          );
        })}
      </ul>
      {editing && (
        <EditEntryModal
          title={`Edit ${String(editing.name)}`}
          fields={[
            { key: "name", label: "Bill name" },
            { key: "amount", label: `Amount (${currencySymbol()})`, type: "number" },
            { key: "due", label: "Due date", type: "date" },
            { key: "category", label: "Category", type: "select", options: [...new Set([String(editing.category || "utility"), ...BILL_CATS])].map((c) => ({ value: c, label: c })) },
            { key: "assigned", label: "Assigned to", type: "select", options: [{ value: "", label: "Anyone" }, ...(fam ?? []).map((m) => ({ value: String(m.name), label: String(m.name) }))] },
          ]}
          initial={{ name: String(editing.name || ""), amount: String(editing.amount_ngn ?? ""), due: String(editing.due_date || "").slice(0, 10), category: String(editing.category || "utility"), assigned: String(editing.assigned_to || "") }}
          onSave={async (v) => {
            if (!v.name.trim() || !v.due) throw new Error("missing fields");
            const newAmount = Number(v.amount) || 0;
            await hdb("hh_bills").update(Number(editing.id), { name: v.name.trim(), amount_ngn: newAmount, due_date: v.due, category: v.category, assigned_to: v.assigned || null });
            // Paid bills feed the budget — move the spend if amount or category changed.
            if (editing.paid && (newAmount !== Number(editing.amount_ngn) || v.category !== String(editing.category))) {
              await syncBudgetForBill(hid, String(editing.category), Number(editing.amount_ngn), -1);
              await syncBudgetForBill(hid, v.category, newAmount, 1);
            }
            refresh();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </PageShell>
  );
}

function BudgetView({ ctx }: { ctx: HHCtx }) {
  const { hid } = ctx;
  const month = monthKey();
  const { data: budgets, refresh } = window.useWorkspaceDB("hh_budgets", { shared: true, filters: [...hhFilter(hid), { column: "month", operator: "eq", value: month }], orderBy: { column: "category", direction: "asc" } });
  // Optional per-category descriptions live in the companion hh_budget_notes
  // table (hh_budgets itself cannot gain new columns after creation).
  const { data: notes, refresh: refreshNotes } = window.useWorkspaceDB("hh_budget_notes", { shared: true, filters: [...hhFilter(hid), { column: "month", operator: "eq", value: month }], limit: 100 });
  const { data: purchases } = window.useWorkspaceDB("hh_inventory_purchase_history", { shared: true, filters: hhFilter(hid), orderBy: { column: "purchased_at", direction: "desc" }, limit: 500 });
  const { data: invCustomCats } = window.useWorkspaceDB("hh_inventory_categories", { shared: true, filters: hhFilter(hid), limit: 50 });
  // Estimated spend per inventory category this month, from real purchase history.
  const invSpend = useMemo(() => {
    const ym = month.slice(0, 7);
    const map = new Map<string, number>();
    (purchases ?? []).forEach((p) => {
      if (String(p.purchased_at || p.created_at || "").slice(0, 7) !== ym) return;
      const key = invCatKey(p.category);
      map.set(key, (map.get(key) || 0) + (Number(p.price_ngn) || 0));
    });
    return [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  }, [purchases, month]);
  const [desc, setDesc] = useState(""); const [cat, setCat] = useState(""); const [limit, setLimit] = useState("");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  // spent_ngn is kept up to date automatically: marking a bill paid adds its
  // amount to the matching category for this month (see syncBudgetForBill).
  const rows = (budgets ?? []).map((b) => ({ ...b, computed_spent: Number(b.spent_ngn) }));
  const totalLimit = rows.reduce((s, r) => s + Number(r.limit_ngn), 0);
  const totalSpent = rows.reduce((s, r) => s + Number(r.computed_spent), 0);
  const chartData = rows.filter((r) => Number(r.computed_spent) > 0);
  const chartTotal = chartData.reduce((s, r) => s + Number(r.computed_spent), 0) || 1;
  const noteFor = (category: unknown) => (notes ?? []).find((n) => String(n.category) === String(category));
  const saveNote = async (category: string, description: string) => {
    const existing = (notes ?? []).find((n) => String(n.category) === category);
    if (existing) await hdb("hh_budget_notes").update(Number(existing.id), { description });
    else if (description) await hdb("hh_budget_notes").insert({ household_id: hid, month, category, description });
    refreshNotes();
  };
  const upsert = async (e: FormEvent) => {
    e.preventDefault(); if (!cat.trim() || !limit) return;
    const chosen = cat.trim().toLowerCase();
    const existing = rows.find((r) => r.category === chosen);
    if (existing) await hdb("hh_budgets").update(Number(existing.id), { limit_ngn: Number(limit) });
    else await hdb("hh_budgets").insert({ household_id: hid, month, category: chosen, limit_ngn: Number(limit), spent_ngn: 0 });
    if (desc.trim()) await saveNote(chosen, desc.trim());
    setDesc(""); setCat(""); setLimit(""); refresh();
  };
  return (
    <PageShell eyebrow="Budget" title="Where the money's going." subtitle={new Date().toLocaleDateString([], { month: "long", year: "numeric" })}>
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", marginBottom: "1.5rem" }}>
        <div className="ozi-card"><p className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase" }}>Monthly limit</p><p className="ozi-display" style={{ fontSize: "1.875rem", marginTop: ".5rem" }}>{fmtN(totalLimit)}</p></div>
        <div className="ozi-card"><p className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase" }}>Spent so far</p><p className="ozi-display" style={{ fontSize: "1.875rem", marginTop: ".5rem" }}>{fmtN(totalSpent)}</p></div>
        <div className="ozi-primary ozi-card"><p style={{ fontSize: ".75rem", textTransform: "uppercase", opacity: .8 }}>Remaining</p><p className="ozi-display" style={{ fontSize: "1.875rem", marginTop: ".5rem" }}>{fmtN(Math.max(0, totalLimit - totalSpent))}</p></div>
      </div>
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
        <div className="ozi-card">
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".25rem" }}>Categories</h2>
          <p className="ozi-muted" style={{ fontSize: ".6875rem", marginBottom: "1rem" }}>Bills marked paid are added to the matching category automatically.</p>
          {rows.map((r) => {
            const pct = Number(r.limit_ngn) > 0 ? (Number(r.computed_spent) / Number(r.limit_ngn)) * 100 : 0;
            const note = noteFor(r.category);
            return (
              <div key={String(r.id)} style={{ marginBottom: "1rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem", marginBottom: ".25rem" }}>
                  <p style={{ fontSize: ".875rem", fontWeight: 500, textTransform: "capitalize" }}>{String(r.category)}</p>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: ".25rem" }}>
                    <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>{fmtN(Number(r.computed_spent))} / {fmtN(Number(r.limit_ngn))}</p>
                    <EditBtn onClick={() => setEditing(r)} />
                  </span>
                </div>
                {note?.description ? <p className="ozi-muted" style={{ fontSize: ".6875rem", margin: "0 0 .25rem" }}>{String(note.description)}</p> : null}
                <div className={`ozi-progress${pct > 100 ? " over" : ""}`}><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
              </div>
            );
          })}
          {!rows.length && <p className="ozi-muted">No categories yet.</p>}
        </div>
        <div className="ozi-card">
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: "1rem" }}>Spend mix</h2>
          {chartData.length === 0 ? <p className="ozi-muted" style={{ textAlign: "center", padding: "3rem 0" }}>No spending recorded yet.</p> : (
            <div style={{ display: "grid", gap: ".75rem" }}>
              {chartData.map((r, i) => (
                <div key={String(r.id)}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: ".75rem", marginBottom: ".25rem" }}>
                    <span style={{ textTransform: "capitalize" }}>{String(r.category)}</span>
                    <span className="ozi-muted">{Math.round((Number(r.computed_spent) / chartTotal) * 100)}%</span>
                  </div>
                  <div className="ozi-progress"><span style={{ width: `${(Number(r.computed_spent) / chartTotal) * 100}%`, background: BUDGET_COLORS[i % BUDGET_COLORS.length] }} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {invSpend.length > 0 && (
        <div className="ozi-card" style={{ marginTop: "1rem" }}>
          <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".25rem" }}>Inventory spend this month</h2>
          <p className="ozi-muted" style={{ fontSize: ".6875rem", marginBottom: ".75rem" }}>Estimated from the shopping list's purchase history, per inventory category.</p>
          <div style={{ display: "grid", gap: ".5rem" }}>
            {invSpend.map(([key, total], i) => (
              <div key={key}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: ".75rem", marginBottom: ".25rem" }}>
                  <span>{invCatIcon(key, invCustomCats)} {invCatLabel(key, invCustomCats)}</span>
                  <span className="ozi-muted">{fmtN(total)}</span>
                </div>
                <div className="ozi-progress"><span style={{ width: `${Math.round((total / (invSpend[0][1] || 1)) * 100)}%`, background: BUDGET_COLORS[i % BUDGET_COLORS.length] }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
      <form onSubmit={upsert} className="ozi-card" style={{ display: "flex", flexWrap: "wrap", gap: ".5rem", marginTop: "1.5rem" }}>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (e.g. School fees and books)" className="ozi-input" style={{ flex: 2, minWidth: 180 }} />
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="ozi-input" style={{ flex: 1, minWidth: 150, textTransform: "capitalize" }}>
          <option value="">Choose a category…</option>
          {BILL_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={limit} onChange={(e) => setLimit(e.target.value)} type="number" min={0} placeholder={`Limit (${currencySymbol()})`} className="ozi-input" style={{ width: 128 }} />
        <button className="ozi-btn">Save</button>
      </form>
      {editing && (
        <EditEntryModal
          title={`Edit ${String(editing.category)} budget`}
          fields={[
            { key: "description", label: "Description", placeholder: "What this budget covers (optional)" },
            { key: "limit", label: `Monthly limit (${currencySymbol()})`, type: "number" },
            { key: "spent", label: `Spent so far (${currencySymbol()})`, type: "number" },
          ]}
          initial={{ description: String(noteFor(editing.category)?.description || ""), limit: String(editing.limit_ngn ?? 0), spent: String(editing.spent_ngn ?? 0) }}
          onSave={async (v) => {
            await hdb("hh_budgets").update(Number(editing.id), { limit_ngn: Number(v.limit) || 0, spent_ngn: Number(v.spent) || 0 });
            await saveNote(String(editing.category), v.description.trim());
            refresh();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </PageShell>
  );
}

/* ------------------------- meal planner assistant ------------------------ */

const MEAL_SLOTS = ["breakfast", "lunch", "dinner"] as const;
type MealSlot = (typeof MEAL_SLOTS)[number];
/** Draft plan keyed `${date}|${meal}` so every slot is directly editable. */
type DraftMap = Record<string, { title: string; notes: string }>;

function draftKey(date: string, meal: string) { return `${date}|${meal}`; }

/**
 * Guided "Plan my week" flow: OziUno drafts breakfast, lunch and dinner for
 * the next 7 days — tuned to the household's country from account setup —
 * then the member reviews, edits, swaps or adjusts anything before saving.
 * Nothing touches hh_meal_plans until they confirm.
 */
function MealPlannerAssistant({ ctx, days, fam, pantry, cuisine, onClose, onApplied }: {
  ctx: HHCtx; days: string[]; fam: Record<string, unknown>[]; pantry: Record<string, unknown>[];
  cuisine: string; onClose: () => void; onApplied: () => void;
}) {
  const { hid, member } = ctx;
  const country = ctx.settings?.country || "Nigeria";
  const [phase, setPhase] = useState<"intro" | "generating" | "review" | "saving">("intro");
  const [prefs, setPrefs] = useState("");
  const [adjust, setAdjust] = useState("");
  const [draft, setDraft] = useState<DraftMap>({});
  const [error, setError] = useState("");
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [adjustBusy, setAdjustBusy] = useState(false);

  const dietary = fam.map((m) => ({ name: m.name, dietary_notes: m.dietary_notes }));
  const pantryNames = pantry.map((p) => `${String(p.name)} (${p.quantity ?? ""} ${p.unit ?? ""})`.trim());

  const baseSystem =
    `You are OziUno, a warm family meal-planning assistant. Return STRICT JSON only: {"days":[{"date":"YYYY-MM-DD","meal":"breakfast|lunch|dinner","title":"short dish name","notes":"one short line (key ingredients or prep tip)"}]}. ` +
    `Return exactly 21 entries: breakfast, lunch and dinner for EACH of these dates: ${days.join(", ")}. ` +
    `Plan ${cuisine} — realistic, affordable everyday home cooking that families in ${country} actually eat, using local dish names. ` +
    `Respect every member's dietary notes. Prefer meals that use the pantry items. Vary the menu across the week.`;

  const householdContext = () =>
    `Household members (dietary notes): ${JSON.stringify(dietary)}\nPantry: ${JSON.stringify(pantryNames)}` +
    (prefs.trim() ? `\nSpecial requests from ${member.name}: ${prefs.trim()}` : "");

  const applyParsed = (text: string, keepExisting: boolean) => {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as { days?: { date?: string; meal?: string; title?: string; notes?: string }[] };
    const next: DraftMap = keepExisting ? { ...draft } : {};
    let filled = 0;
    for (const d of parsed.days ?? []) {
      const meal = String(d.meal || "").toLowerCase();
      const date = String(d.date || "").slice(0, 10);
      if (!(MEAL_SLOTS as readonly string[]).includes(meal) || !days.includes(date) || !d.title) continue;
      next[draftKey(date, meal)] = { title: String(d.title).trim(), notes: String(d.notes || "").trim() };
      filled++;
    }
    if (!filled) throw new Error("empty plan");
    setDraft(next);
  };

  const generate = async () => {
    setPhase("generating"); setError("");
    try {
      const text = await aiComplete(baseSystem, householdContext(), true);
      applyParsed(text, false);
      setPhase("review");
    } catch {
      setError("I couldn't put the menu together just now — please try again.");
      setPhase("intro");
    }
  };

  const requestAdjust = async () => {
    const instruction = adjust.trim(); if (!instruction || adjustBusy) return;
    setAdjustBusy(true); setError("");
    try {
      const current = Object.entries(draft).map(([k, v]) => { const [date, meal] = k.split("|"); return { date, meal, title: v.title, notes: v.notes }; });
      const text = await aiComplete(
        baseSystem + " You are ADJUSTING an existing draft: apply the member's instruction, keep meals that are not affected unchanged, and return the FULL 21-entry plan.",
        householdContext() + `\nCurrent draft plan: ${JSON.stringify(current)}\nAdjustment request: ${instruction}`, true,
      );
      applyParsed(text, true);
      setAdjust("");
    } catch {
      setError("That adjustment didn't go through — please try again.");
    } finally { setAdjustBusy(false); }
  };

  const swapSlot = async (date: string, meal: MealSlot) => {
    const key = draftKey(date, meal); if (busySlot) return;
    setBusySlot(key); setError("");
    try {
      const currentTitle = draft[key]?.title || "";
      const text = await aiComplete(
        `You are OziUno, a family meal-planning assistant. Return STRICT JSON only: {"title":"short dish name","notes":"one short line"}. Suggest ONE ${meal} for a family in ${country} — ${cuisine}. It must be DIFFERENT from "${currentTitle}". Respect dietary notes; prefer pantry items.`,
        householdContext(), true,
      );
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : text) as { title?: string; notes?: string };
      if (parsed.title) setDraft((d) => ({ ...d, [key]: { title: String(parsed.title).trim(), notes: String(parsed.notes || "").trim() } }));
    } catch {
      setError("Couldn't suggest a swap just now — please try again.");
    } finally { setBusySlot(null); }
  };

  const saveDraft = async () => {
    setPhase("saving"); setError("");
    try {
      // Fresh read at save time so we update (not duplicate) meals someone else
      // just added. Household-only fetch, newest first with a generous limit —
      // the exact date+meal match below does the windowing, because server-side
      // date-range filters are unreliable (see the MealsView read).
      const { data: existingRows } = await hdb("hh_meal_plans").eq("household_id", hid).orderBy("created_at", "desc").limit(1000).get();
      for (const [key, value] of Object.entries(draft)) {
        if (!value.title.trim()) continue;
        const [date, meal] = key.split("|");
        const existing = (existingRows || []).find((p) => String(p.date).slice(0, 10) === date && String(p.meal) === meal);
        if (existing) await hdb("hh_meal_plans").update(Number(existing.id), { title: value.title.trim(), recipe_md: value.notes });
        else await hdb("hh_meal_plans").insert({ household_id: hid, date, meal, title: value.title.trim(), recipe_md: value.notes, added_by: member.name });
      }
      onApplied();
      onClose();
    } catch {
      setError("Saving the plan failed — please try again.");
      setPhase("review");
    }
  };

  const filledCount = Object.values(draft).filter((v) => v.title.trim()).length;
  const busy = phase === "generating" || phase === "saving";

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(0,0,0,.45)", padding: "1rem" }} onClick={busy ? undefined : onClose}>
      <div className="ozi-card" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 720, maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: ".75rem", marginBottom: ".75rem" }}>
          <span style={{ width: 36, height: 36, borderRadius: 9999, background: "rgba(13,148,136,.1)", color: "#0d9488", display: "grid", placeItems: "center", flexShrink: 0 }}><Sparkles size={18} /></span>
          <div style={{ flex: 1 }}>
            <p className="ozi-display" style={{ fontSize: "1.125rem", margin: 0 }}>Plan the week with OziUno</p>
            <p className="ozi-muted" style={{ fontSize: ".75rem", margin: 0 }}>Breakfast, lunch &amp; dinner for 7 days — tuned to {country} home cooking.</p>
          </div>
          <button type="button" onClick={onClose} disabled={phase === "saving"} aria-label="Close" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#5b6b81" }}><X size={18} /></button>
        </div>

        {error && <p role="alert" style={{ fontSize: ".75rem", color: "#b91c1c", margin: "0 0 .5rem" }}>{error}</p>}

        {phase === "intro" && (
          <>
            <p style={{ fontSize: ".875rem", lineHeight: 1.55, margin: 0 }}>
              Hi {firstName(member.name)} — let's plan {String(ctx.household.name)}'s week together. I'll suggest breakfast, lunch and dinner for the next 7 days, built around everyday {country} home cooking, your family's dietary notes and what's already in the pantry. You'll review everything and can change any meal before it's saved.
            </p>
            <input value={prefs} onChange={(e) => setPrefs(e.target.value)} placeholder='Optional requests — e.g. "no beef, light dinners, Sunday is rice day"' className="ozi-input" style={{ marginTop: ".75rem" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: ".5rem", marginTop: "1rem" }}>
              <button type="button" onClick={onClose} className="ozi-muted" style={{ border: "none", background: "transparent", cursor: "pointer" }}>Cancel</button>
              <button type="button" className="ozi-btn" onClick={() => void generate()}><Sparkles size={16} /> Suggest my menu</button>
            </div>
          </>
        )}

        {phase === "generating" && (
          <p className="ozi-muted" style={{ fontSize: ".875rem", padding: "1.5rem 0", textAlign: "center" }}>Putting together a week of {country} meals for {String(ctx.household.name)}…</p>
        )}

        {(phase === "review" || phase === "saving") && (
          <>
            <div style={{ flex: 1, overflowY: "auto", display: "grid", gap: ".75rem", paddingRight: 2 }}>
              {days.map((date) => (
                <div key={date} style={{ border: "1px solid rgba(15,27,45,.08)", borderRadius: 10, padding: ".625rem .75rem" }}>
                  <p className="ozi-muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: ".375rem" }}>{new Date(date).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</p>
                  {MEAL_SLOTS.map((meal) => {
                    const key = draftKey(date, meal);
                    const value = draft[key];
                    return (
                      <div key={meal} style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".375rem" }}>
                        <span className="ozi-muted" style={{ fontSize: 9, textTransform: "uppercase", width: 58, flexShrink: 0 }}>{meal}</span>
                        <div style={{ flex: 1 }}>
                          <input
                            value={value?.title || ""}
                            onChange={(e) => setDraft((d) => ({ ...d, [key]: { title: e.target.value, notes: d[key]?.notes || "" } }))}
                            placeholder="Leave empty to skip"
                            className="ozi-input"
                            style={{ fontSize: ".8125rem", padding: ".375rem .5rem" }}
                            disabled={phase === "saving"}
                          />
                          {value?.notes ? <p className="ozi-muted" style={{ fontSize: ".6875rem", margin: "2px 0 0" }}>{value.notes}</p> : null}
                        </div>
                        <button type="button" onClick={() => void swapSlot(date, meal)} disabled={!!busySlot || phase === "saving"} aria-label={`Suggest a different ${meal}`} title="Suggest something different" style={{ border: "1px solid rgba(15,27,45,.12)", background: "transparent", borderRadius: 8, width: 30, height: 30, display: "grid", placeItems: "center", cursor: "pointer", color: busySlot === key ? "#0d9488" : "#5b6b81", flexShrink: 0 }}>
                          <RefreshCw size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); void requestAdjust(); }} style={{ display: "flex", gap: ".5rem", marginTop: ".75rem" }}>
              <input value={adjust} onChange={(e) => setAdjust(e.target.value)} placeholder='Ask me for changes — e.g. "no beef, lighter dinners"' className="ozi-input" style={{ flex: 1 }} disabled={adjustBusy || phase === "saving"} />
              <button type="submit" className="ozi-btn" disabled={!adjust.trim() || adjustBusy || phase === "saving"}>{adjustBusy ? "Adjusting…" : "Adjust"}</button>
            </form>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem", marginTop: ".75rem", flexWrap: "wrap" }}>
              <p className="ozi-muted" style={{ fontSize: ".7rem", margin: 0, flex: 1, minWidth: 200 }}>Edit any meal directly, tap the refresh icon for a different idea, or ask me for changes above. Saving replaces meals already planned for the same slot.</p>
              <div style={{ display: "flex", gap: ".5rem" }}>
                <button type="button" onClick={onClose} disabled={phase === "saving"} className="ozi-muted" style={{ border: "none", background: "transparent", cursor: "pointer" }}>Cancel</button>
                <button type="button" className="ozi-btn" onClick={() => void saveDraft()} disabled={phase === "saving" || adjustBusy || !filledCount}><Check size={16} /> {phase === "saving" ? "Saving…" : `Add ${filledCount} meals to my week`}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------- per-meal ingredient review panel -------------------- */

/**
 * Review & correct the AI-PROPOSED ingredient commitments of ONE planned meal
 * BEFORE it is confirmed. Every edit/removal here touches ONLY
 * hh_meal_ingredients (the forecast layer): inventory quantities are NEVER
 * changed by this panel — stock only moves at meal check-in via
 * confirmMealOutcome + the hh_inventory_ledger. Units go through the
 * controlled unit system (sanitizeIngredient — dozen → pcs, taxonomy kinds
 * enforced), and the requirement is re-expressed in the matched pantry item's
 * own unit when a REAL conversion exists (never an assumed 1:1).
 */
function MealIngredientsPanel({ ctx, meal, pantry, canEdit, onClose, onChanged }: {
  ctx: HHCtx; meal: Record<string, unknown>; pantry: Record<string, unknown>[];
  canEdit: boolean; onClose: () => void; onChanged?: () => void;
}) {
  const { hid } = ctx;
  const mid = Number(meal.id);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, { qty: string; unit: string }>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const foodInv = useMemo(() => foodItems(pantry ?? []), [pantry]);
  const itemById = useMemo(() => new Map(foodInv.map((i) => [Number(i.id), i])), [foodInv]);

  const load = useCallback(async () => {
    const fetchRows = async () => {
      const { data } = await hdb("hh_meal_ingredients").eq("household_id", hid).eq("meal_plan_id", mid).get();
      return data ?? [];
    };
    let all = await fetchRows();
    if (!all.length) { await ensureMealCommitments(hid, ctx.household); all = await fetchRows(); }
    const committed = all.filter((r) => String(r.status || "committed") === "committed" && String(r.name) !== NO_INGREDIENTS_MARKER);
    setRows(committed);
    setDrafts(Object.fromEntries(committed.map((r) => [Number(r.id), {
      qty: String(roundQty(Number(r.required_qty) || 0)),
      unit: normalizeUnit(r.required_unit || r.unit || "pcs"),
    }])));
  }, [hid, mid, ctx.household]);
  useEffect(() => { void load(); }, [load]);

  const changed = () => {
    onChanged?.();
    try { window.dispatchEvent(new CustomEvent("ozi:data-changed")); } catch { /* ignore */ }
  };

  /** Save ONE corrected commitment line — hh_meal_ingredients only. */
  const saveRow = async (row: Record<string, unknown>) => {
    const id = Number(row.id);
    const d = drafts[id];
    if (!d || busyId) return;
    // Controlled unit system decides the final unit (dozen → pcs, taxonomy
    // kinds enforced — eggs can never be saved in kg).
    const s = sanitizeIngredient({ name: row.name, quantity: Number(d.qty), unit: d.unit });
    if (!s) { setNotice("Enter a quantity above zero — or remove the ingredient instead."); return; }
    setBusyId(id); setNotice("");
    try {
      // Re-match against the pantry and express the requirement in the
      // matched item's own unit when a real conversion exists (never 1:1) —
      // same rule ensureMealCommitments applies when it creates these rows.
      const item = matchInventoryItem(foodInv, row.name);
      let requiredQty = s.quantity;
      let requiredUnit = s.unit;
      if (item) {
        const pkg = packageExpansion(item as never);
        if (pkg) {
          const conv = convertUnits(s.quantity, s.unit, pkg.unit);
          if (conv != null) { requiredQty = roundQty(conv / pkg.size); requiredUnit = String(item.unit || s.unit); }
        } else {
          const conv = convertUnits(s.quantity, s.unit, String(item.unit || ""));
          if (conv != null) { requiredQty = roundQty(conv); requiredUnit = String(item.unit || s.unit); }
        }
      }
      await hdb("hh_meal_ingredients").update(id, {
        required_qty: requiredQty, required_unit: requiredUnit,
        matched_item_id: item ? Number(item.id) : null,
      });
      setNotice(`Updated ${String(row.name)} — this meal now plans for ${requiredQty} ${requiredUnit}. Your inventory was not touched.`);
      await load(); changed();
    } catch (err) {
      console.error("[OziUno] Commitment edit failed:", err);
      setNotice("That didn't save — please try again.");
    } finally { setBusyId(null); }
  };

  /** Remove = RELEASE the commitment (status → cancelled). The plan never
   * touched inventory, so nothing needs restoring. */
  const removeRow = async (row: Record<string, unknown>) => {
    const id = Number(row.id);
    if (busyId) return;
    setBusyId(id); setNotice("");
    try {
      await hdb("hh_meal_ingredients").update(id, { status: "cancelled" });
      setNotice(`Removed ${String(row.name)} from this meal's plan. Your inventory was not touched.`);
      await load(); changed();
    } catch (err) {
      console.error("[OziUno] Commitment removal failed:", err);
      setNotice("That didn't save — please try again.");
    } finally { setBusyId(null); }
  };

  const unitOptionsFor = (current: string): string[] => {
    const base = CANONICAL_UNITS.map((u) => u.unit);
    return base.includes(current) ? base : [current, ...base];
  };
  const dateLabel = new Date(String(meal.date).slice(0, 10)).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center", background: "rgba(0,0,0,.4)", padding: "1rem" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="ozi-card" style={{ width: "100%", maxWidth: 560, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: ".75rem" }}>
          <ChefHat size={18} style={{ color: "#0d9488", flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontWeight: 600, fontSize: ".9375rem", margin: 0 }}>{String(meal.title)}</p>
            <p className="ozi-muted" style={{ fontSize: ".75rem", margin: "2px 0 0", textTransform: "capitalize" }}>{String(meal.meal)} · {dateLabel}</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ border: "none", background: "transparent", cursor: "pointer" }}><X size={16} /></button>
        </div>
        <p className="ozi-muted" style={{ fontSize: ".75rem", margin: ".625rem 0 .25rem" }}>
          These are the planned ingredient amounts OziUno proposed for this meal — review and correct them before the meal is confirmed. Editing or removing a line only changes the plan's reservations: nothing is deducted from your inventory until you confirm the meal at check-in.
        </p>
        {notice && <p role="status" style={{ fontSize: ".8125rem", color: "#0d9488", margin: ".375rem 0" }}>{notice}</p>}
        {rows === null ? (
          <p className="ozi-muted" style={{ fontSize: ".8125rem", margin: ".75rem 0 0" }}>Working out this dish's ingredients…</p>
        ) : rows.length === 0 ? (
          <p className="ozi-muted" style={{ fontSize: ".8125rem", margin: ".75rem 0 0" }}>No tracked ingredients are committed for this meal.</p>
        ) : rows.map((row) => {
          const id = Number(row.id);
          const d = drafts[id] ?? { qty: "", unit: "pcs" };
          const savedQty = String(roundQty(Number(row.required_qty) || 0));
          const savedUnit = normalizeUnit(row.required_unit || row.unit || "pcs");
          const dirty = d.qty !== savedQty || d.unit !== savedUnit;
          const item = row.matched_item_id != null ? itemById.get(Number(row.matched_item_id)) : undefined;
          const busy = busyId === id;
          return (
            <div key={id} style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap", padding: ".625rem 0", borderTop: "1px solid rgba(15,27,45,.08)", marginTop: ".375rem" }}>
              <div style={{ flex: 1, minWidth: 150 }}>
                <p style={{ fontSize: ".8125rem", fontWeight: 500, margin: 0 }}>
                  {String(row.name)}
                  {row.optional === true && <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", background: "rgba(15,27,45,.08)", color: "#3b4d63", borderRadius: 9999, padding: "1px 6px", marginLeft: 6 }}>Optional</span>}
                </p>
                <p className="ozi-muted" style={{ fontSize: ".6875rem", margin: "2px 0 0" }}>
                  {item ? `Counts against ${String(item.name)} in your inventory` : "Not matched to an inventory item — informational only"}
                  {row.preparation_state ? ` · ${String(row.preparation_state)}` : ""}
                </p>
              </div>
              {canEdit ? (
                <>
                  <input type="number" min={0} step="any" value={d.qty} onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, qty: e.target.value } }))} className="ozi-input" style={{ width: 84 }} aria-label={`${String(row.name)} quantity`} />
                  <select value={d.unit} onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, unit: e.target.value } }))} className="ozi-input" style={{ width: 92 }} aria-label={`${String(row.name)} unit`}>
                    {unitOptionsFor(d.unit).map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  {dirty && <button className="ozi-btn" style={{ fontSize: ".75rem", padding: ".3rem .7rem" }} disabled={busy} onClick={() => void saveRow(row)}><Check size={13} /> Save</button>}
                  <button onClick={() => void removeRow(row)} disabled={busy} aria-label={`Remove ${String(row.name)}`} title="Remove from this meal — releases the reservation; inventory untouched" style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={15} /></button>
                </>
              ) : (
                <span style={{ fontSize: ".8125rem" }}>{savedQty} {savedUnit}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MealsView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  const days = useMemo(() => weekDays(), []);
  const from = days[0]; const to = days[6];
  // Fetch by household only and window to the week CLIENT-side: two range
  // filters on the same column (date gte + lte) get dropped server-side, so
  // this query used to return the 50 OLDEST rows instead of this week —
  // freshly saved meals never showed up, which looked like "saving is broken".
  const { data: plans, refresh } = window.useWorkspaceDB("hh_meal_plans", {
    shared: true,
    filters: hhFilter(hid),
    orderBy: { column: "date", direction: "desc" }, limit: 500,
  });
  const { data: pantry } = window.useWorkspaceDB("hh_inventory_items", { shared: true, filters: hhFilter(hid), limit: 500 });
  const { data: fam } = window.useWorkspaceDB("household_memberships", { shared: true, filters: [...hhFilter(hid), { column: "status", operator: "eq", value: "active" }], limit: 50 });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedMeal, setSelectedMeal] = useState("dinner");
  const [title, setTitle] = useState("");
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [reviewMeal, setReviewMeal] = useState<Record<string, unknown> | null>(null);
  const canPlan = member.role !== "child" && member.role !== "guest";
  const byDay = useMemo(() => {
    const m = new Map<string, typeof plans>();
    (plans ?? []).forEach((p) => {
      const dateKey = String(p.date).slice(0, 10);
      if (dateKey < from || dateKey > to) return;
      const arr = m.get(dateKey) ?? [];
      arr.push(p);
      m.set(dateKey, arr);
    });
    return m;
  }, [plans, from, to]);
  const cuisine = !ctx.settings?.country || ctx.settings.country === "Nigeria"
    ? "Nigerian/West African cuisine"
    : `Everyday home cooking popular in ${ctx.settings.country}`;
  // Deleting a planned meal RELEASES its commitments (cancelled) — inventory
  // was never touched by the plan, so nothing needs restoring.
  const removeMeal = async (p: Record<string, unknown>) => {
    try {
      const { data: ings } = await hdb("hh_meal_ingredients").eq("household_id", hid).eq("meal_plan_id", Number(p.id)).get();
      for (const ing of ings ?? []) await hdb("hh_meal_ingredients").delete(Number(ing.id));
    } catch { /* commitments are advisory — the meal delete still proceeds */ }
    await hdb("hh_meal_plans").delete(Number(p.id));
    refresh();
  };
  // New plans get PLANNED requirements (commitments) in the background —
  // a forecast only; actual inventory is untouched until meal check-in.
  const refreshCommitments = () => { void ensureMealCommitments(hid, ctx.household); };
  const MEAL_STATUS_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
    consumed: { label: "Eaten", bg: "rgba(13,148,136,.12)", fg: "#0d9488" },
    partial: { label: "Partly eaten", bg: "rgba(245,158,11,.2)", fg: "#b45309" },
    skipped: { label: "Skipped", bg: "rgba(15,27,45,.12)", fg: "#3b4d63" },
  };
  return (
    <PageShell eyebrow="Meals" title="This week on the table." subtitle="The shared family menu. Planned meals reserve ingredients as committed stock — nothing is deducted until you confirm a meal happened. Tap a planned meal to review or correct its ingredients." extra={canPlan ? <button className="ozi-btn" onClick={() => setPlannerOpen(true)}><Sparkles size={16} /> Plan my week</button> : undefined}>
      <MealCheckins ctx={ctx} onChanged={refresh} />
      <LeftoversPanel ctx={ctx} onChanged={refresh} />
      <div style={{ display: "grid", gap: ".75rem", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
        {days.map((d) => {
          const date = new Date(d); const rows = byDay.get(d) ?? []; const isToday = new Date().toDateString() === date.toDateString();
          const nextMeal = ["breakfast", "lunch", "dinner"].find((meal) => !rows.some((row) => row.meal === meal)) ?? "dinner";
          return (
            <div key={d} className="ozi-card" style={{ background: isToday ? "rgba(13,148,136,.05)" : undefined, boxShadow: isToday ? "0 0 0 1px rgba(13,148,136,.3)" : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: ".75rem" }}>
                <div><p className="ozi-muted" style={{ fontSize: 10, textTransform: "uppercase" }}>{date.toLocaleDateString([], { weekday: "short" })}</p><p className="ozi-display" style={{ fontSize: "1.25rem" }}>{date.getDate()}</p></div>
                {isToday && <span style={{ fontSize: 10, background: "rgba(45,212,191,.18)", padding: "2px 8px", borderRadius: 9999 }}>Today</span>}
              </div>
              {rows.map((p) => {
                const badge = MEAL_STATUS_BADGE[String(p.status || "")];
                // Only still-planned meals are reviewable — once confirmed the
                // commitments are history, not a forecast to correct.
                const isPlanned = String(p.status || "planned") === "planned";
                return (
                  <div
                    key={String(p.id)}
                    role={isPlanned ? "button" : undefined}
                    tabIndex={isPlanned ? 0 : undefined}
                    title={isPlanned ? "Review this meal's planned ingredients" : undefined}
                    onClick={isPlanned ? () => setReviewMeal(p) : undefined}
                    onKeyDown={isPlanned ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setReviewMeal(p); } } : undefined}
                    style={{ background: "rgba(15,27,45,.04)", borderRadius: 8, padding: 8, marginBottom: 8, fontSize: ".75rem", cursor: isPlanned ? "pointer" : undefined }}
                  >
                    <p className="ozi-muted" style={{ fontSize: 9, textTransform: "uppercase" }}>{String(p.meal)}</p>
                    <p style={{ fontWeight: 500, marginTop: 2 }}>{String(p.title)}{p.replaced_with ? <span className="ozi-muted"> → {String(p.replaced_with)}</span> : null}</p>
                    {badge && <span style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", background: badge.bg, color: badge.fg, borderRadius: 9999, padding: "1px 6px" }}>{badge.label}</span>}
                    {canPlan && <button onClick={(e) => { e.stopPropagation(); void removeMeal(p); }} aria-label={`Delete ${String(p.title)}`} style={{ border: "none", background: "transparent", cursor: "pointer", float: "right" }}><Trash2 size={12} /></button>}
                    {isPlanned && <p className="ozi-muted" style={{ fontSize: 9, marginTop: 4 }}>Tap to review ingredients</p>}
                  </div>
                );
              })}
              {canPlan && <button onClick={() => { setSelectedMeal(nextMeal); setSelectedDay(d); }} style={{ width: "100%", border: "1px dashed rgba(15,27,45,.15)", background: "transparent", borderRadius: 8, padding: "12px 0", fontSize: ".75rem", cursor: "pointer" }}>+ Add meal</button>}
            </div>
          );
        })}
      </div>
      {plannerOpen && (
        <MealPlannerAssistant ctx={ctx} days={days} fam={fam ?? []} pantry={foodItems(pantry ?? [])} cuisine={cuisine} onClose={() => setPlannerOpen(false)} onApplied={() => { refresh(); refreshCommitments(); }} />
      )}
      {reviewMeal && (
        <MealIngredientsPanel ctx={ctx} meal={reviewMeal} pantry={pantry ?? []} canEdit={canPlan} onClose={() => setReviewMeal(null)} onChanged={refresh} />
      )}
      {selectedDay && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center", background: "rgba(0,0,0,.4)", padding: "1rem" }} onClick={() => setSelectedDay(null)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={async (e) => { e.preventDefault(); if (!title.trim()) return; await hdb("hh_meal_plans").insert({ household_id: hid, date: selectedDay, meal: selectedMeal, title: title.trim(), recipe_md: "", added_by: member.name, status: "planned" }); setTitle(""); setSelectedDay(null); refresh(); refreshCommitments(); }} className="ozi-card" style={{ width: "100%", maxWidth: 384 }}>
            <p className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".75rem" }}>Add a meal for {new Date(selectedDay).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</p>
            <select value={selectedMeal} onChange={(e) => setSelectedMeal(e.target.value)} className="ozi-input" style={{ marginBottom: ".5rem", textTransform: "capitalize" }}>
              {["breakfast", "lunch", "dinner"].map((meal) => <option key={meal} value={meal}>{meal}</option>)}
            </select>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Jollof rice & grilled snapper" className="ozi-input" />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: ".5rem", marginTop: "1rem" }}>
              <button type="button" onClick={() => setSelectedDay(null)} className="ozi-muted" style={{ border: "none", background: "transparent", cursor: "pointer" }}>Cancel</button>
              <button type="submit" className="ozi-btn">Save</button>
            </div>
          </form>
        </div>
      )}
    </PageShell>
  );
}

function FamilyView({ ctx }: { ctx: HHCtx }) {
  const { hid, member, household, isOwner } = ctx;
  const { data, refresh } = window.useWorkspaceDB("household_memberships", { shared: true, filters: hhFilter(hid), orderBy: { column: "created_at", direction: "asc" } });
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState<Role>("adult");
  const [relation, setRelation] = useState("family"); const [age, setAge] = useState(""); const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState("");
  const [countryCode, setCountryCode] = useState(ctx.settings?.country ? countryByName(ctx.settings.country).code : "NG");
  const [currencyMsg, setCurrencyMsg] = useState("");
  const changeCountry = async (code: string) => {
    setCountryCode(code);
    const def = countryByCode(code);
    try {
      await saveHouseholdCountry(hid, def);
      setCurrencyMsg(`Saved — household amounts now show in ${def.currency} (${def.symbol.trim()}).`);
      ctx.refreshHousehold();
    } catch (err) {
      console.error("[OziUno] Saving country failed:", err);
      setCurrencyMsg("We couldn't save that change. Please try again.");
    }
  };
  const members = (data ?? []).filter((m) => String(m.status) !== "removed" && String(m.status) !== "declined");
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); window.setTimeout(() => setCopied(""), 2000); } catch { /* clipboard unavailable */ }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault(); if (!name.trim() || busy) return;
    setBusy(true); setMessage("");
    try {
      const cleanEmail = email.trim().toLowerCase();
      const hasLogin = cleanEmail.includes("@");
      await hdb("household_memberships").insert({
        household_id: hid, name: name.trim(), email: hasLogin ? cleanEmail : null, role,
        relation: relation || null, age: age ? Number(age) : null, dietary_notes: notes.trim() || null,
        status: hasLogin ? "invited" : "active", invited_by: member.name,
        joined_at: hasLogin ? null : new Date().toISOString(), account_session_id: null,
      });
      if (hasLogin) {
        const sent = await sendInviteEmail(cleanEmail, String(household.name), String(household.household_code), member.name, role);
        setMessage(sent
          ? `Invite sent to ${cleanEmail}. When they sign in with that email, they'll be linked to ${String(household.name)} automatically.`
          : `Added ${name.trim()} as invited, but the invite email couldn't be sent — share the household code ${String(household.household_code)} with them instead.`);
      } else {
        setMessage(`${name.trim()} was added to the household (no login — you manage their info for them).`);
      }
      setName(""); setEmail(""); setAge(""); setNotes(""); setRole("adult"); refresh();
    } catch (err) {
      console.error("[OziUno] Add member failed:", err);
      setMessage("We couldn't add that member. Please try again.");
    } finally { setBusy(false); }
  };
  const changeRole = async (id: number, newRole: string) => {
    await hdb("household_memberships").update(id, { role: newRole });
    refresh();
  };
  const remove = async (id: number) => {
    await hdb("household_memberships").update(id, { status: "removed" });
    refresh();
  };
  return (
    <PageShell eyebrow="Family" title="Who's in the household." subtitle={`${String(household.name)} · every member has their own login and role.`}>
      {isOwner && (
        <div className="ozi-card" style={{ marginBottom: "1.5rem", display: "grid", gap: "1rem" }}>
          <div>
            <p style={{ fontSize: ".875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: ".5rem" }}><KeyRound size={16} color="#0d9488" /> Household code</p>
            <p className="ozi-muted" style={{ fontSize: ".8125rem", marginTop: ".25rem" }}>Anyone can join with this code — or send them the invite link below.</p>
            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginTop: ".625rem", alignItems: "center" }}>
              <span className="ozi-code-chip">{String(household.household_code)}
                <button onClick={() => copy(String(household.household_code), "code")} aria-label="Copy household code" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#0d9488", display: "grid", placeItems: "center" }}><Copy size={14} /></button>
              </span>
              <button className="ozi-btn ozi-btn-ghost" onClick={() => copy(joinLink(String(household.household_code)), "link")}><Copy size={14} /> Copy invite link</button>
              {copied && <span className="ozi-muted" style={{ fontSize: ".75rem" }}>Copied {copied}!</span>}
            </div>
            <div style={{ display: "flex", gap: ".875rem", marginTop: ".875rem", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ background: "#FFFFFF", padding: 10, borderRadius: 12, boxShadow: "0 0 0 1px rgba(15,27,45,.08)", lineHeight: 0 }}>
                <QRCode value={joinLink(String(household.household_code))} size={112} bgColor="#FFFFFF" fgColor="#0f1b2d" />
              </div>
              <p className="ozi-muted" style={{ fontSize: ".75rem", maxWidth: 260, display: "flex", alignItems: "flex-start", gap: ".375rem" }}>
                <QrCode size={13} style={{ flexShrink: 0, marginTop: 2 }} /> Or let family scan this QR code with their phone camera — it opens OziUno with your household code pre-filled, so they just sign in and confirm.
              </p>
            </div>
          </div>
          <div style={{ borderTop: "1px solid rgba(15,27,45,.08)", paddingTop: "1rem" }}>
            <p style={{ fontSize: ".875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: ".5rem" }}><Globe size={16} color="#0d9488" /> Country & currency</p>
            <p className="ozi-muted" style={{ fontSize: ".8125rem", marginTop: ".25rem" }}>All household amounts — bills, budgets, shopping — display in this currency.</p>
            <select value={countryCode} onChange={(e) => changeCountry(e.target.value)} className="ozi-input" style={{ marginTop: ".5rem", maxWidth: 340 }}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.country} ({c.currency} {c.symbol.trim()})</option>)}
            </select>
            {currencyMsg && <p role="status" style={{ fontSize: ".8125rem", color: "#0d9488", marginTop: ".375rem" }}>{currencyMsg}</p>}
          </div>
          <form onSubmit={add} style={{ display: "grid", gap: ".5rem", borderTop: "1px solid rgba(15,27,45,.08)", paddingTop: "1rem" }}>
            <p style={{ fontSize: ".875rem", fontWeight: 600, display: "flex", alignItems: "center", gap: ".5rem" }}><UserPlus size={16} color="#0d9488" /> Add a family member</p>
            <div style={{ display: "grid", gap: ".5rem", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="ozi-input" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email (optional — sends invite)" className="ozi-input" />
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="ozi-input">
                {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gap: ".5rem", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))" }}>
              <select value={relation} onChange={(e) => setRelation(e.target.value)} className="ozi-input">{["family","partner","child","parent","helper","other"].map((r) => <option key={r} value={r}>{r}</option>)}</select>
              <input value={age} onChange={(e) => setAge(e.target.value)} type="number" min={0} placeholder="Age" className="ozi-input" />
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Dietary notes" className="ozi-input" />
              <button className="ozi-btn" disabled={busy || !name.trim()}>{busy ? "Adding…" : email.trim() ? "Send invite" : "Add member"}</button>
            </div>
            <p className="ozi-muted" style={{ fontSize: ".75rem" }}>
              With an email, they get their own login and are linked automatically when they sign in.
              Without one, you manage their profile for them (great for young children).
            </p>
            {message && <p role="status" style={{ fontSize: ".8125rem", color: "#0d9488" }}>{message}</p>}
          </form>
        </div>
      )}
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".75rem", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
        {members.map((m) => {
          const mid = Number(m.id);
          const isSelf = mid === member.id;
          const mRole = (String(m.role) as Role) || "adult";
          return (
            <li key={String(m.id)} className="ozi-card" style={{ display: "flex", gap: ".75rem", padding: "1rem" }}>
              <div style={{ width: 40, height: 40, borderRadius: 9999, background: "rgba(13,148,136,.1)", color: "#0d9488", display: "grid", placeItems: "center", flexShrink: 0 }}><User size={20} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: ".875rem", fontWeight: 500, display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                  {String(m.name)}{isSelf ? <span className="ozi-muted" style={{ fontSize: ".6875rem" }}>(you)</span> : null} <RoleBadge role={mRole} />
                  {String(m.status) === "invited" && <span className="ozi-role-badge" style={{ background: "rgba(245,158,11,.18)", color: "#b45309" }}>Invite pending</span>}
                </p>
                <p className="ozi-muted" style={{ fontSize: ".75rem" }}>{String(m.relation || "family")}{m.age != null ? ` • ${m.age}` : ""}{m.email ? ` • ${String(m.email)}` : " • no login"}</p>
                {m.dietary_notes && <p className="ozi-muted" style={{ fontSize: ".75rem", marginTop: ".25rem" }}>{String(m.dietary_notes)}</p>}
                {isOwner && !isSelf && mRole !== "owner" && (
                  <div style={{ display: "flex", gap: ".5rem", marginTop: ".5rem", alignItems: "center" }}>
                    <select value={mRole} onChange={(e) => changeRole(mid, e.target.value)} className="ozi-input" style={{ width: "auto", padding: ".25rem .5rem", fontSize: ".75rem" }}>
                      {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                    <button onClick={() => remove(mid)} aria-label={`Remove ${String(m.name)}`} style={{ border: "none", background: "transparent", cursor: "pointer" }}><Trash2 size={16} /></button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </PageShell>
  );
}

/* --------------------------------- support -------------------------------- */

const SUPPORT_CATS = ["complaint", "billing", "bug", "question", "other"];

/** Members send complaints/questions here; they land in the internal Admin
 * Portal's Support inbox (support_tickets table, status open → resolved). */
function SupportView({ ctx }: { ctx: HHCtx }) {
  const { hid, member } = ctx;
  const myEmail = (member.email || "").toLowerCase();
  const { data: tickets, refresh } = window.useWorkspaceDB("support_tickets", { shared: true, filters: hhFilter(hid), orderBy: { column: "created_at", direction: "desc" }, limit: 100 });
  const mine = (tickets ?? []).filter((t) => myEmail ? String(t.member_email || "").toLowerCase() === myEmail : String(t.member_name) === member.name);
  const [category, setCategory] = useState("complaint");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!message.trim() || busy) return;
    setBusy(true); setNotice(null);
    try {
      await hdb("support_tickets").insert({
        household_id: hid, member_name: member.name, member_email: myEmail || null,
        category, subject: subject.trim() || null, message: message.trim(), status: "open",
      });
      setSubject(""); setMessage(""); setCategory("complaint");
      setNotice({ ok: true, text: "Thank you — your message has been sent to the OziUno team. We read every one." });
      refresh();
    } catch (err) {
      console.error("[OziUno] Support ticket failed:", err);
      setNotice({ ok: false, text: "Sorry — your message couldn't be sent just now. Please try again." });
    } finally { setBusy(false); }
  };
  return (
    <PageShell eyebrow="Support" title="We're here to help." subtitle="Send a complaint, question or idea — the OziUno team reads every message.">
      <form onSubmit={submit} className="ozi-card" style={{ display: "grid", gap: ".5rem", marginBottom: "1.5rem" }}>
        <div style={{ display: "grid", gap: ".5rem", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="ozi-input" style={{ textTransform: "capitalize" }}>
            {SUPPORT_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject (optional)" className="ozi-input" />
        </div>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tell us what happened — the more detail, the faster we can help…" rows={4} className="ozi-input" style={{ resize: "vertical", fontFamily: "inherit" }} />
        <div style={{ display: "flex", alignItems: "center", gap: ".75rem", flexWrap: "wrap" }}>
          <button type="submit" className="ozi-btn" disabled={busy || !message.trim()}><LifeBuoy size={16} /> {busy ? "Sending…" : "Send to the OziUno team"}</button>
          {notice && <p role={notice.ok ? "status" : "alert"} style={{ fontSize: ".8125rem", margin: 0, color: notice.ok ? "#0d9488" : "#b91c1c" }}>{notice.text}</p>}
        </div>
      </form>

      <h2 className="ozi-muted" style={{ fontSize: ".75rem", textTransform: "uppercase", marginBottom: ".75rem" }}>Your messages</h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: ".5rem" }}>
        {mine.map((t) => {
          const resolved = String(t.status || "open") === "resolved";
          return (
            <li key={String(t.id)} className="ozi-card" style={{ padding: ".75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", borderRadius: 9999, padding: "2px 8px", background: resolved ? "rgba(13,148,136,.12)" : "rgba(245,158,11,.2)", color: resolved ? "#0d9488" : "#b45309" }}>{resolved ? "Resolved" : "Open"}</span>
                <span className="ozi-muted" style={{ fontSize: ".6875rem", textTransform: "capitalize" }}>{String(t.category || "other")}</span>
                <span className="ozi-muted" style={{ fontSize: ".6875rem", marginLeft: "auto" }}>{new Date(String(t.created_at)).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </div>
              {t.subject ? <p style={{ fontSize: ".875rem", fontWeight: 600, marginTop: ".375rem" }}>{String(t.subject)}</p> : null}
              <p style={{ fontSize: ".8125rem", marginTop: ".25rem", whiteSpace: "pre-wrap" }}>{String(t.message)}</p>
            </li>
          );
        })}
        {!mine.length && <p className="ozi-muted" style={{ fontSize: ".875rem" }}>You haven't sent us anything yet.</p>}
      </ul>
    </PageShell>
  );
}

/* --------------------------------- billing -------------------------------- */

function BillingView({ trial, refreshTrial }: { trial: TrialState; refreshTrial: () => void }) {
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState("");
  const account = useMemo(() => getAccount(), []);
  const currentPlan = trial.subscribed ? PLANS.find((p) => p.key === (trial.plan || "monthly")) || PLANS[0] : null;
  const subscribe = async (p: Plan) => {
    if (busyPlan) return;
    setBusyPlan(p.key); setError("");
    try { await startPlanCheckout(p); }
    catch (err) { console.error("[OziUno] Checkout failed:", err); setError("Checkout couldn't be started — please try again."); setBusyPlan(null); }
  };
  return (
    <PageShell eyebrow="Billing" title="Your plan & billing." subtitle={TRIAL_ENFORCEMENT_ENABLED ? "Every OziUno household starts with a 7-day free trial — then it's $29/month or $250/year." : "OziUno is free with full access during our early-adoption phase — plans are $29/month or $250/year."}>
      <div className="ozi-card" style={{ marginBottom: "1.5rem", display: "flex", alignItems: "center", gap: ".875rem", flexWrap: "wrap" }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(13,148,136,.1)", color: "#0d9488", display: "grid", placeItems: "center", flexShrink: 0 }}><CreditCard size={18} /></div>
        <div style={{ flex: 1, minWidth: 200 }}>
          {trial.subscribed ? (
            <>
              <p style={{ fontSize: ".9375rem", fontWeight: 600 }}>Subscribed — OziUno {currentPlan?.name || "Monthly"} ({currentPlan?.price} {currentPlan?.cadence})</p>
              <p className="ozi-muted" style={{ fontSize: ".75rem" }}>Billed to {account.email || "your account"} via Stripe. To change or cancel your plan, just ask in Chat and we'll sort it out.</p>
            </>
          ) : !TRIAL_ENFORCEMENT_ENABLED ? (
            <>
              <p style={{ fontSize: ".9375rem", fontWeight: 600 }}>Full access — free during early adoption</p>
              <p className="ozi-muted" style={{ fontSize: ".75rem" }}>The 7-day trial is paused while we gather feedback. Subscribe below any time — you're only billed when you choose a plan.</p>
            </>
          ) : trial.daysLeft > 0 ? (
            <>
              <p style={{ fontSize: ".9375rem", fontWeight: 600 }}>Free trial — {trial.daysLeft} day{trial.daysLeft === 1 ? "" : "s"} left</p>
              <p className="ozi-muted" style={{ fontSize: ".75rem" }}>Subscribe below any time — you're only billed when you choose a plan.</p>
            </>
          ) : (
            <>
              <p style={{ fontSize: ".9375rem", fontWeight: 600 }}>Your free trial has ended</p>
              <p className="ozi-muted" style={{ fontSize: ".75rem" }}>Pick a plan below to keep OziUno running your household.</p>
            </>
          )}
        </div>
        <button type="button" className="ozi-btn-ghost" style={{ borderRadius: 9999, padding: ".375rem .75rem", fontSize: ".75rem", cursor: "pointer" }} onClick={refreshTrial}>Refresh status</button>
      </div>

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
        {PLANS.map((p) => {
          const isCurrent = trial.subscribed && (trial.plan || "monthly") === p.key;
          return (
            <div key={p.key} className="ozi-card" style={p.featured ? { boxShadow: "0 0 0 1.5px rgba(45,212,191,.55)" } : undefined}>
              <div style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
                <p style={{ fontSize: ".875rem", fontWeight: 600 }}>{p.name}</p>
                {p.featured && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", background: "rgba(45,212,191,.16)", color: "#0f766e", borderRadius: 9999, padding: "2px 8px" }}>Best value</span>}
                {isCurrent && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".1em", textTransform: "uppercase", background: "rgba(13,148,136,.12)", color: "#0d9488", borderRadius: 9999, padding: "2px 8px" }}>Current plan</span>}
              </div>
              <p style={{ margin: ".375rem 0" }}>
                <span className="ozi-display" style={{ fontSize: "2rem" }}>{p.price}</span>
                <span className="ozi-muted" style={{ fontSize: ".8125rem", marginLeft: 6 }}>{p.cadence}</span>
              </p>
              <p className="ozi-muted" style={{ fontSize: ".8125rem", marginBottom: ".75rem" }}>{p.note}</p>
              <button type="button" className="ozi-btn" disabled={!!busyPlan || trial.subscribed} onClick={() => void subscribe(p)} style={{ width: "100%", justifyContent: "center", opacity: trial.subscribed && !isCurrent ? .5 : undefined }}>
                {isCurrent ? "You're on this plan" : trial.subscribed ? "Already subscribed" : busyPlan === p.key ? "Opening secure checkout…" : `Subscribe ${p.name.toLowerCase()}`}
              </button>
            </div>
          );
        })}
      </div>
      {error && <p role="alert" style={{ color: "#b91c1c", fontSize: ".8125rem", marginTop: "1rem" }}>{error}</p>}
      <p className="ozi-muted" style={{ fontSize: ".75rem", marginTop: "1.25rem" }}>
        Payments are processed securely by Stripe — OziUno never sees your card details.{TRIAL_ENFORCEMENT_ENABLED ? " The 7-day free trial is per household; subscribing unlocks OziUno for your whole household." : " Full access is free during early adoption — subscribing is optional."}
      </p>
    </PageShell>
  );
}

/* --------------------------------- paywall ------------------------------- */

function PaywallView() {
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState("");
  const subscribe = async (p: Plan) => {
    if (busyPlan) return;
    setBusyPlan(p.key); setError("");
    try { await startPlanCheckout(p); }
    catch (err) { console.error("[OziUno] Checkout failed:", err); setError("Checkout couldn't be started — please try again."); setBusyPlan(null); }
  };
  return (
    <div className="ozi-paywall">
      <div style={{ maxWidth: 680, width: "100%", textAlign: "center" }}>
        <div className="ozi-primary" style={{ width: 48, height: 48, borderRadius: 16, display: "grid", placeItems: "center", margin: "0 auto 1.25rem" }}>
          <span className="ozi-display" style={{ fontSize: "1.5rem" }}>O</span>
        </div>
        <p className="ozi-accent" style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 600 }}>Your free trial has ended</p>
        <h1 className="ozi-display" style={{ fontSize: "2rem", lineHeight: 1.2, margin: "0.75rem auto 0", maxWidth: 560 }}>
          You've had 7 days of OziUno holding your home together. Ready to keep it that way?
        </h1>
        <p style={{ color: "#5b6b81", fontSize: ".9375rem", margin: "1rem auto 2rem", maxWidth: 460 }}>
          Keep your household inventory, meals, bills, schedule and family notes in one calm place — pick the plan that suits your household.
        </p>
        <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", textAlign: "left" }}>
          {PLANS.map((p) => (
            <div key={p.key} className={`ozi-paywall-card${p.featured ? " featured" : ""}`}>
              {p.featured && <span className="ozi-paywall-badge">Best value</span>}
              <p style={{ fontSize: ".875rem", fontWeight: 600 }}>{p.name}</p>
              <p>
                <span className="ozi-display" style={{ fontSize: "2.25rem" }}>{p.price}</span>
                <span style={{ color: "#5b6b81", fontSize: ".8125rem", marginLeft: 6 }}>{p.cadence}</span>
              </p>
              <p style={{ color: p.featured ? "#0f766e" : "#5b6b81", fontSize: ".8125rem" }}>{p.note}</p>
              <button type="button" disabled={!!busyPlan} onClick={() => void subscribe(p)} className="ozi-paywall-btn" style={p.featured ? { background: "linear-gradient(135deg,#5eead4,#22d3ee)", color: "#04201c", boxShadow: "0 10px 26px rgba(45,212,191,.28)" } : { background: "rgba(15,27,45,.07)", color: "#0f1b2d" }}>
                {busyPlan === p.key ? "Opening secure checkout…" : `Subscribe ${p.name.toLowerCase()}`}
              </button>
            </div>
          ))}
        </div>
        {error && <p role="alert" style={{ color: "#dc2626", fontSize: ".8125rem", marginTop: "1.25rem" }}>{error}</p>}
        <p style={{ color: "#8595a9", fontSize: ".75rem", marginTop: "1.5rem" }}>
          Payments are processed securely by Stripe — cancel anytime. Your household data is safe and waiting for you.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------- app --------------------------------- */

type Phase = "loading" | "signin" | "welcome" | "invited" | "ready" | "error";

export default function App() {
  const { view, threadId, go } = useNav();
  const [phase, setPhase] = useState<Phase>("loading");
  const [member, setMember] = useState<Membership | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [settings, setSettings] = useState<HouseholdSettings | null>(null);
  const [pendingInvites, setPendingInvites] = useState<{ membership: Membership; household: Household }[]>([]);
  const [setupDone, setSetupDone] = useState(false);
  const [skipInvites, setSkipInvites] = useState(false);
  const [trial, setTrial] = useState<TrialState>({ checked: false, expired: false, daysLeft: TRIAL_DAYS, subscribed: false, plan: null, forHousehold: null });
  const account = useMemo(() => getAccount(), []);
  const initialJoinCode = useMemo(() => parseJoinCodeFromUrl(), []);
  // Assistant actions (voice orb or typed chat) change household data outside
  // the open view's hooks — bump this to remount the active view so it refetches.
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    const bump = () => setDataVersion((v) => v + 1);
    window.addEventListener("ozi:data-changed", bump);
    return () => window.removeEventListener("ozi:data-changed", bump);
  }, []);

  // Fresh, role-aware system prompt + live household snapshot for every
  // voice-assistant turn (children/guests never receive bills or budgets).
  const buildVoiceSystem = useCallback(async () => {
    if (!household || !member) return "You are OziUno, a warm, concise household assistant.";
    const context = await loadHouseholdContext(Number(household.id), member);
    return memberSystemPrompt(household, member) + "\n\nLive household data (JSON snapshot):\n" + context;
  }, [household, member]);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash && /^app-[\w-]+$/i.test(hash)) {
      window.history.replaceState({}, "", window.location.pathname + window.location.search);
    }
  }, []);

  const resolveHousehold = useCallback(async () => {
    const acct = getAccount();
    if (!acct.email) { setPhase("signin"); return; }
    try {
      const { data: mems } = await hdb("household_memberships").eq("email", acct.email).get();
      const memberships = (mems || []) as unknown as Membership[];
      const active = memberships.find((m) => String(m.status) === "active");
      if (active) {
        // Both queries only need the household id we already have — fetching
        // them in parallel saves a full round-trip on every app open.
        const [hhRes, hhSettings] = await Promise.all([
          hdb("households").eq("id", Number(active.household_id)).get(),
          loadHouseholdSettings(Number(active.household_id)),
        ]);
        const hh = hhRes.data?.[0] as Household | undefined;
        if (hh) {
          setSettings(hhSettings);
          setActiveCurrency(hhSettings?.currency_code, hhSettings?.currency_symbol);
          setMember(active); setHousehold(hh); setPhase("ready");
          setSetupDone(hh.onboarded !== false);
          if (acct.sessionId && active.account_session_id !== acct.sessionId) {
            hdb("household_memberships").update(Number(active.id), { account_session_id: acct.sessionId }).catch(() => {});
          }
          return;
        }
      }
      const invited = memberships.filter((m) => String(m.status) === "invited");
      if (invited.length && !skipInvites) {
        const withHouseholds: { membership: Membership; household: Household }[] = [];
        for (const m of invited) {
          const { data: hhs } = await hdb("households").eq("id", Number(m.household_id)).get();
          const hh = hhs?.[0] as Household | undefined;
          if (hh) withHouseholds.push({ membership: m, household: hh });
        }
        if (withHouseholds.length) { setPendingInvites(withHouseholds); setPhase("invited"); return; }
      }
      // Self-heal: a household exists with this email as owner, but the owner
      // membership was never written (an earlier create attempt died between
      // the two inserts). Re-link instead of asking them to create it again.
      const { data: owned } = await hdb("households").eq("owner_email", acct.email).orderBy("created_at", "desc").limit(1).get();
      const orphan = owned?.[0] as Household | undefined;
      if (orphan) {
        await hdb("household_memberships").insert({
          household_id: Number(orphan.id),
          name: String(orphan.owner_name || firstName(acct.email.split("@")[0])),
          email: acct.email, role: "owner", relation: null,
          status: "active", invited_by: null, joined_at: new Date().toISOString(),
          account_session_id: acct.sessionId,
        });
        const { data: relinked } = await hdb("household_memberships").eq("email", acct.email).eq("status", "active").get();
        const healed = relinked?.[0] as unknown as Membership | undefined;
        if (healed) {
          const hhSettings = await loadHouseholdSettings(Number(orphan.id));
          setSettings(hhSettings);
          setActiveCurrency(hhSettings?.currency_code, hhSettings?.currency_symbol);
          setMember(healed); setHousehold(orphan); setPhase("ready");
          setSetupDone(orphan.onboarded !== false);
          return;
        }
      }
      setPhase("welcome");
    } catch (err) {
      // Never fall through to the create/join screens on a transient failure —
      // that is how returning users ended up re-onboarding and duplicating
      // membership rows. Show a retry screen instead.
      console.error("[OziUno] Household resolution failed:", err);
      setPhase("error");
    }
  }, [skipInvites]);

  useEffect(() => { void resolveHousehold(); }, [resolveHousehold]);

  // Background planning bookkeeping. IMPORTANT: nothing here deducts
  // inventory. ensureInventoryReady seeds rooms, migrates legacy pantry rows,
  // backfills ingredient keys/opening balances; ensureMealCommitments turns
  // planned meals into COMMITTED (forecast) requirements. Actual consumption
  // only ever happens when a member answers a meal check-in.
  useEffect(() => {
    if (!household) return;
    // Deferred a few seconds so this background work (which can include an AI
    // call and several writes) never competes with the initial screen load.
    const timer = window.setTimeout(() => {
      void (async () => {
        const migrated = await ensureInventoryReady(Number(household.id));
        if (migrated) { try { window.dispatchEvent(new CustomEvent("ozi:data-changed")); } catch { /* ignore */ } }
        const created = await ensureMealCommitments(Number(household.id), household);
        if (created > 0) {
          try { window.dispatchEvent(new CustomEvent("ozi:data-changed")); } catch { /* ignore */ }
        }
      })();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [household]);

  // 7-day trial per HOUSEHOLD — the trial clock is keyed to household_id, so a
  // household gets exactly one free trial no matter how many members it adds.
  const checkTrial = useCallback(async () => {
    const hid = household ? Number(household.id) : null;
    // While TRIAL_ENFORCEMENT_ENABLED is false: nobody expires, no trial_status
    // row is created (so no trial clock starts), but an existing subscription is
    // still read so paying customers keep seeing their plan in Billing.
    if (!TRIAL_ENFORCEMENT_ENABLED) {
      try {
        const { data } = hid
          ? await hdb("trial_status").eq("household_id", hid).orderBy("created_at", "asc").limit(1).get()
          : await db().from("trial_status").limit(1).get();
        const row = data?.[0];
        setTrial({ checked: true, expired: false, daysLeft: TRIAL_DAYS, subscribed: row?.subscribed === true, plan: row?.plan ? String(row.plan) : null, forHousehold: hid });
      } catch {
        setTrial({ checked: true, expired: false, daysLeft: TRIAL_DAYS, subscribed: false, plan: null, forHousehold: hid });
      }
      return;
    }
    // No household yet (signing in / onboarding / pending invite): the trial
    // clock only starts once the household exists, so there is nothing to
    // enforce and the create/join screens stay reachable.
    if (!hid) {
      setTrial({ checked: true, expired: false, daysLeft: TRIAL_DAYS, subscribed: false, plan: null, forHousehold: null });
      return;
    }
    try {
      const { data } = await hdb("trial_status").eq("household_id", hid).orderBy("created_at", "asc").limit(1).get();
      const row = data?.[0];
      if (!row) {
        await hdb("trial_status").insert({ household_id: hid, trial_started_at: new Date().toISOString(), subscribed: false });
        setTrial({ checked: true, expired: false, daysLeft: TRIAL_DAYS, subscribed: false, plan: null, forHousehold: hid });
        return;
      }
      const started = new Date(String(row.trial_started_at ?? row.created_at)).getTime();
      const elapsedDays = Number.isFinite(started) ? Math.floor((Date.now() - started) / 86400000) : 0;
      const subscribed = row.subscribed === true;
      setTrial({ checked: true, expired: !subscribed && elapsedDays >= TRIAL_DAYS, daysLeft: Math.max(0, TRIAL_DAYS - elapsedDays), subscribed, plan: row.plan ? String(row.plan) : null, forHousehold: hid });
    } catch {
      // Fail open on transient DB errors so paying-intent users are never locked out by a glitch.
      setTrial((t) => ({ ...t, checked: true, forHousehold: hid }));
    }
  }, [household]);

  useEffect(() => {
    // Returning from Stripe checkout? Confirm the payment and activate the
    // subscription BEFORE the trial check, so the paywall never flashes for
    // a customer who just paid. Both are keyed to the household, so this also
    // re-runs once the household resolves.
    void (async () => { await finalizeCheckout(household ? Number(household.id) : null); await checkTrial(); })();
  }, [checkTrial, household]);

  const refreshHousehold = useCallback(() => { void resolveHousehold(); }, [resolveHousehold]);

  // The trial verdict is only trusted once it was computed for the CURRENT
  // household — otherwise an expired household would flash the unlocked app
  // (or a paying one the paywall) while the household-keyed re-check runs.
  const trialCurrent = trial.checked && (!TRIAL_ENFORCEMENT_ENABLED || !household || trial.forHousehold === Number(household.id));
  if (phase === "loading" || !trialCurrent) {
    return (
      <div className="ozi-root">
        <style>{OZI_CSS}</style>
        <div style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}><p className="ozi-muted">Setting up your household…</p></div>
      </div>
    );
  }

  // Trial-expired lock screen — the paywall shown once the household's 7-day
  // trial ends without a subscription (bypassed while TRIAL_ENFORCEMENT_ENABLED is false).
  if (TRIAL_ENFORCEMENT_ENABLED && trial.checked && trial.expired) {
    return (
      <div className="ozi-root">
        <style>{OZI_CSS}</style>
        <PaywallView />
      </div>
    );
  }

  if (phase === "signin") {
    return <div className="ozi-root"><style>{OZI_CSS}</style><SignInNotice /></div>;
  }

  if (phase === "error") {
    return (
      <div className="ozi-root">
        <style>{OZI_CSS}</style>
        <AuthShell>
          <h1 className="ozi-display" style={{ fontSize: "1.875rem" }}>We couldn't load your household</h1>
          <p className="ozi-muted" style={{ fontSize: ".9375rem", marginTop: ".75rem", lineHeight: 1.6 }}>
            This is usually a brief connection hiccup — your household and all its data are safe. Try again in a moment.
          </p>
          <button className="ozi-btn" style={{ marginTop: "1.5rem" }} onClick={() => { setPhase("loading"); void resolveHousehold(); }}>
            <ArrowRight size={16} /> Try again
          </button>
        </AuthShell>
      </div>
    );
  }

  if (phase === "invited") {
    return (
      <div className="ozi-root">
        <style>{OZI_CSS}</style>
        <InviteAccept invites={pendingInvites} onAccepted={refreshHousehold} onCreateInstead={() => { setSkipInvites(true); setPhase("welcome"); }} />
      </div>
    );
  }

  if (phase === "welcome" || !member || !household) {
    return (
      <div className="ozi-root">
        <style>{OZI_CSS}</style>
        <WelcomeChoice email={account.email || ""} initialJoinCode={initialJoinCode} onCreated={refreshHousehold} onJoined={refreshHousehold} />
      </div>
    );
  }

  const ctx: HHCtx = {
    household, member, hid: Number(household.id),
    isOwner: member.role === "owner", settings, go, refreshHousehold,
  };

  // Owner finishes household setup (family size, budget) once per household.
  if (!setupDone && member.role === "owner") {
    return (
      <div className="ozi-root">
        <style>{OZI_CSS}</style>
        <OnboardingView ctx={ctx} onComplete={() => { setSetupDone(true); refreshHousehold(); }} />
      </div>
    );
  }

  const effectiveView: View = canSee(member.role, view) ? view : "dashboard";

  const body = effectiveView === "dashboard" ? <DashboardView ctx={ctx} />
    : effectiveView === "chat" ? <ChatView ctx={ctx} threadId={threadId} />
    : effectiveView === "meals" ? <MealsView ctx={ctx} />
    : effectiveView === "pantry" ? <InventoryView ctx={ctx} />
    : effectiveView === "shopping" ? <ShoppingView ctx={ctx} />
    : effectiveView === "wasteless" ? <WasteLessView ctx={ctx} />
    : effectiveView === "schedule" ? <ScheduleView ctx={ctx} />
    : effectiveView === "tasks" ? <TasksView ctx={ctx} />
    : effectiveView === "maintenance" ? <MaintenanceView ctx={ctx} />
    : effectiveView === "bills" ? <BillsView ctx={ctx} />
    : effectiveView === "budget" ? <BudgetView ctx={ctx} />
    : effectiveView === "billing" ? <BillingView trial={trial} refreshTrial={() => { void (async () => { await finalizeCheckout(household ? Number(household.id) : null); await checkTrial(); })(); }} />
    : effectiveView === "support" ? <SupportView ctx={ctx} />
    : effectiveView === "family" ? <FamilyView ctx={ctx} />
    : <DashboardView ctx={ctx} />;

  return (
    <div className="ozi-root">
      <style>{OZI_CSS}</style>
      <TopNav view={effectiveView} go={go} trialDaysLeft={TRIAL_ENFORCEMENT_ENABLED && trial.checked && !trial.subscribed ? trial.daysLeft : null} member={member} household={household} />
      <main className="ozi-main" key={dataVersion}>{body}</main>
      <VoiceAssistant ctx={agentCtxFor(ctx)} buildSystem={buildVoiceSystem} />
    </div>
  );
}
