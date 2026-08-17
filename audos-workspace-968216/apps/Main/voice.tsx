/* ---------------------------------------------------------------------------
 * OziUno Voice — the voice-first layer of the OziUno household app.
 *
 * MODULAR PIPELINE (each stage is a swappable provider — see voiceEngine):
 *
 *   [tap-to-talk] ─▶ STT  (SpeechToTextProvider)
 *                      └ platformWhisperSTT → POST /api/generate/transcribe
 *   ─▶ intent + actions  (runOziAgentTurn)
 *                      └ platform OpenAI proxy with function tools; every tool
 *                        is permission-checked against the signed-in member's
 *                        household role before it runs, and every write is
 *                        attributed to that member (added_by).
 *   ─▶ TTS  (TextToSpeechProvider)
 *                      └ elevenLabsTTS → platform ElevenLabs voiceover
 *                        ("Sarah" — natural, warm, conversational). Falls
 *                        back to browserSpeechTTS (window.speechSynthesis)
 *                        if generation fails. Swap providers by assigning
 *                        voiceEngine.tts / voiceEngine.stt — nothing else in
 *                        the app knows which vendor is behind them.
 *
 * ACTIVATION: tap-to-speak ONLY. The microphone records exclusively between
 * the two taps; the audio is uploaded once for transcription and discarded —
 * recordings are never stored. A future wake-word ("Hey OziUno") activation
 * would plug in as one more caller of startListening()/finishListening() on
 * the orb — no other stage needs to change — but always-on background
 * listening is deliberately NOT implemented.
 *
 * CONVERSATION CONTEXT lives in memory on this device only (voice
 * conversations are not persisted anywhere); the member can clear it at any
 * time from the privacy panel.
 * ------------------------------------------------------------------------- */

import { useEffect, useRef, useState } from "react";
import { Check, Mic, MicOff, Settings2, ShieldCheck, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { postTxn, convertUnits, defaultUnitFor, ingredientKeyOf, normalizeQuantityInput, recordOpeningBalances } from "./inventory-engine";

/* ------------------------------ shared types ----------------------------- */

/** Feature areas a tool can touch — each maps 1:1 to an app view for role gating. */
export type ToolArea = "shopping" | "pantry" | "schedule" | "tasks" | "bills" | "meals" | "maintenance" | "wasteless";

export interface VoiceMemberCtx {
  hid: number;
  memberName: string;
  memberEmail: string | null;
  memberRole: string; // owner | adult | teen | child | guest | caregiver
  householdName: string;
  currencyCode: string;
  currencySymbol: string;
  /** Role gate supplied by the app (canSee) — decides which tool areas this member may use. */
  can: (area: ToolArea) => boolean;
}

/* ------------------------------- db access ------------------------------- */

interface DbRow { [key: string]: unknown }

interface DbQuery {
  eq(col: string, val: unknown): DbQuery;
  orderBy(col: string, dir?: "asc" | "desc"): DbQuery;
  limit(n: number): DbQuery;
  get(): Promise<{ data: DbRow[] }>;
  insert(row: DbRow): Promise<unknown>;
  bulkInsert(rows: DbRow[]): Promise<unknown>;
  update(id: number, row: DbRow): Promise<unknown>;
  delete(id: number): Promise<unknown>;
}

// Household data always goes through the shared scope, exactly like the app views.
function vdb(table: string): DbQuery {
  const w = window as unknown as { __workspaceDb: { from: (t: string, o?: { shared?: boolean }) => DbQuery } };
  return w.__workspaceDb.from(table, { shared: true });
}

function norm(value: unknown): string { return String(value ?? "").toLowerCase().trim(); }

function firstName(name: string) { return String(name || "").trim().split(/\s+/)[0] || "there"; }

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Fuzzy row lookup so "the milk" matches "Oat Milk" — exact, then contains, both ways. */
function matchRow(rows: DbRow[], field: string, name: string): DbRow | null {
  const target = norm(name);
  if (!target) return null;
  return rows.find((r) => norm(r[field]) === target)
    || rows.find((r) => norm(r[field]).includes(target))
    || rows.find((r) => norm(r[field]).length > 2 && target.includes(norm(r[field])))
    || null;
}

async function householdRows(table: string, hid: number): Promise<DbRow[]> {
  const { data } = await vdb(table).eq("household_id", hid).get();
  return data || [];
}

function budgetMonthKey(d = new Date()): string {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10);
}

/** Mirror of the app's budget sync (syncBudgetForBill in App.tsx): paying a
 * bill adds its amount to this month's matching budget category so the
 * Budget view updates automatically, whichever surface marks it paid. */
async function syncBudgetSpent(hid: number, category: unknown, amount: unknown) {
  try {
    const amt = Number(amount) || 0;
    if (!amt) return;
    const month = budgetMonthKey();
    const cat = String(category || "other").toLowerCase().trim() || "other";
    const { data } = await vdb("hh_budgets").eq("household_id", hid).eq("month", month).eq("category", cat).get();
    const existing = (data || [])[0];
    if (existing) {
      await vdb("hh_budgets").update(Number(existing.id), { spent_ngn: Math.max(0, Number(existing.spent_ngn || 0) + amt) });
    } else {
      await vdb("hh_budgets").insert({ household_id: hid, month, category: cat, limit_ngn: 0, spent_ngn: amt });
    }
  } catch (err) {
    console.warn("[OziUno Voice] Budget sync failed:", err);
  }
}

/* --------------------------- inventory awareness -------------------------- */

/** Mirror of the app's built-in inventory categories (App.tsx INV_CATS). */
const INV_CAT_LABELS_V: Record<string, string> = {
  pantry: "Pantry", household: "Household Supplies", toiletries: "Toiletries", cleaning: "Cleaning Supplies",
  laundry: "Laundry Supplies", medicine: "Medicine Cabinet", baby: "Baby Supplies", pet: "Pet Supplies",
  home_maintenance: "Home Maintenance", seasonal: "Seasonal Storage",
};

function invCatKeyV(v: unknown): string {
  const k = norm(v);
  if (INV_CAT_LABELS_V[k] || k.startsWith("custom:")) return k;
  if (/(food|drink|grocer)/.test(k)) return "pantry";
  if (/laundry|wash/.test(k)) return "laundry";
  if (/clean/.test(k)) return "cleaning";
  if (/medic|health|pharma|first aid/.test(k)) return "medicine";
  if (/baby|nappy|diaper/.test(k)) return "baby";
  if (/pet|dog|cat/.test(k)) return "pet";
  if (/toiletr|hygiene|personal care|soap|shampoo/.test(k)) return "toiletries";
  if (/maint|tool|repair|hardware/.test(k)) return "home_maintenance";
  if (/season|decorat/.test(k)) return "seasonal";
  if (/household|supplies|general/.test(k)) return "household";
  return "pantry";
}

function invCatLabelV(v: unknown): string {
  const k = String(v || "pantry");
  return INV_CAT_LABELS_V[k] || (k.startsWith("custom:") ? "Custom" : k.charAt(0).toUpperCase() + k.slice(1));
}

function invIsLowV(i: DbRow): boolean {
  const qty = Number(i.quantity) || 0;
  const min = Number(i.min_stock_level) || 0;
  return ["warn", "empty"].includes(norm(i.status)) || qty <= 0 || (min > 0 && qty <= min);
}

/** Resolve a spoken place ("garage", "cleaning cupboard") to a storage location. */
async function resolveLocationV(hid: number, spoken: unknown): Promise<{ id: number; label: string } | null> {
  const wanted = norm(spoken);
  if (!wanted) return null;
  const [locs, rooms] = await Promise.all([householdRows("hh_storage_locations", hid), householdRows("hh_rooms", hid)]);
  const label = (l: DbRow) => {
    const room = rooms.find((r) => Number(r.id) === Number(l.room_id));
    return room ? `${String(room.name)} · ${String(l.name)}` : String(l.name);
  };
  const direct = locs.find((l) => norm(l.name) === wanted)
    || locs.find((l) => norm(l.name).includes(wanted) || wanted.includes(norm(l.name)));
  if (direct) return { id: Number(direct.id), label: label(direct) };
  const room = rooms.find((r) => norm(r.name) === wanted)
    || rooms.find((r) => norm(r.name).includes(wanted) || wanted.includes(norm(r.name)));
  if (room) {
    const first = locs.find((l) => Number(l.room_id) === Number(room.id));
    if (first) return { id: Number(first.id), label: label(first) };
  }
  return null;
}

/** Mirror of the app's purchase restock: marking a shopping item bought adds
 * its quantity to the matching inventory item through a PURCHASE transaction
 * in the hh_inventory_ledger (un-marking posts a compensating RETURN) — the
 * balance is never overwritten without an auditable transaction. Purchases
 * are also logged to hh_inventory_purchase_history for budget tracking. */
async function applyPurchaseToPantryV(hid: number, item: DbRow, direction: 1 | -1, buyerName: string) {
  try {
    const qty = Number(item.quantity) || 1;
    const invRows = await householdRows("hh_inventory_items", hid);
    const linked = Number(item.linked_pantry_id);
    const nameKey = norm(item.name);
    // linked_pantry_id may hold a new inventory id OR a pre-migration pantry id.
    const target = invRows.find((p) => Number(p.id) === linked)
      || invRows.find((p) => Number(p.legacy_pantry_id) === linked)
      || invRows.find((p) => norm(p.name) === nameKey);
    if (direction > 0) {
      try {
        await vdb("hh_inventory_purchase_history").insert({
          household_id: hid, item_id: target ? Number(target.id) : null, item_name: String(item.name),
          category: target ? invCatKeyV(target.category) : invCatKeyV(item.category), qty, unit: String(item.unit || "unit"),
          price_ngn: (Number(item.est_cost_ngn) || 0) * qty, purchased_at: new Date().toISOString(), added_by: buyerName,
        });
      } catch { /* history is best-effort */ }
    } else {
      try {
        const hist = await vdb("hh_inventory_purchase_history").eq("household_id", hid).eq("item_name", String(item.name)).orderBy("purchased_at", "desc").limit(1).get();
        if (hist.data?.[0]) await vdb("hh_inventory_purchase_history").delete(Number(hist.data[0].id));
      } catch { /* history is best-effort */ }
    }
    if (target) {
      const conv = convertUnits(qty, String(item.unit || ""), String(target.unit || ""));
      const delta = (conv ?? qty) * direction;
      await postTxn(hid, target, {
        type: direction > 0 ? "purchase" : "return", delta,
        reason: direction > 0 ? `Bought: ${qty} ${String(item.unit || "unit")} ${String(item.name)} (via assistant)` : `Purchase un-marked: ${String(item.name)} (via assistant)`,
        createdBy: buyerName,
        ...(direction > 0 ? { extraItemPatch: { last_restocked_at: todayKey() } } : {}),
      });
    } else if (direction > 0) {
      const normalized = normalizeQuantityInput(qty, String(item.unit || ""), String(item.name));
      await vdb("hh_inventory_items").insert({ household_id: hid, name: String(item.name), category: invCatKeyV(item.category), ingredient_key: ingredientKeyOf(item.name), quantity: normalized.qty, unit: normalized.unit, status: "ok", last_restocked_at: todayKey(), added_by: buyerName });
      await recordOpeningBalances(hid);
    }
  } catch (err) {
    console.warn("[OziUno Voice] Inventory restock failed:", err);
  }
}

/** Mirror of the app's WasteLess risk assessment (assessPantryRisk in App.tsx):
 * expiry date first, then a staleness heuristic vs the household's usual pace. */
function assessPantryRiskV(item: DbRow, now = new Date()): { severity: string; reason: string } | null {
  const qty = Number(item.quantity) || 0;
  if (qty <= 0) return null;
  const dayDiff = (from: Date, to: Date) => Math.round((new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime() - new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()) / 86400000);
  if (item.expires_at) {
    const exp = new Date(String(item.expires_at));
    if (!Number.isNaN(exp.getTime())) {
      const d = dayDiff(now, exp);
      if (d < 0) return { severity: "likely wasted", reason: `expired ${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago` };
      if (d <= 1) return { severity: "use today", reason: d === 0 ? "expires today" : "expires tomorrow" };
      if (d <= 3) return { severity: "use soon", reason: `expires in ${d} days` };
      return null;
    }
  }
  const typical = Number(item.typical_days_to_deplete) || 0;
  if (!typical) return null;
  const anchor = new Date(String(item.last_restocked_at || item.created_at || ""));
  if (Number.isNaN(anchor.getTime())) return null;
  const age = dayDiff(anchor, now);
  if (age >= Math.ceil(typical * 1.75)) return { severity: "likely wasted", reason: `sitting ${age} days — usually finished in ${typical}` };
  if (age >= Math.ceil(typical * 1.25)) return { severity: "use soon", reason: `${age} days old — usually finished in ${typical}` };
  return null;
}

/* --------------------------- provider interfaces -------------------------- */

export interface SpeechToTextProvider {
  id: string;
  transcribe(blob: Blob): Promise<string>;
}

export interface TextToSpeechProvider {
  id: string;
  /** Resolves when playback finishes (or immediately if speech is unavailable). */
  speak(text: string): Promise<void>;
  stop(): void;
}

/** Platform speech-to-text (OpenAI Whisper behind /api/generate/transcribe). */
const platformWhisperSTT: SpeechToTextProvider = {
  id: "platform-whisper",
  async transcribe(blob) {
    const formData = new FormData();
    formData.append("audio", blob, "oziuno-voice.webm");
    const res = await fetch("/api/generate/transcribe", { method: "POST", body: formData });
    if (!res.ok) throw new Error("Transcription failed");
    const data = await res.json() as { text?: string };
    return (data.text || "").trim();
  },
};

function stripForSpeech(md: string) {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Browser text-to-speech — free, instant and offline-safe. */
const browserSpeechTTS: TextToSpeechProvider = {
  id: "browser-speech-synthesis",
  speak(text) {
    return new Promise<void>((resolve) => {
      try {
        if (!("speechSynthesis" in window)) { resolve(); return; }
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(stripForSpeech(text).slice(0, 1200));
        utter.rate = 1;
        try {
          const voices = window.speechSynthesis.getVoices() || [];
          const preferred = voices.find((v) => /^en/i.test(v.lang) && /natural|neural|google|samantha|serena|aria/i.test(v.name))
            || voices.find((v) => /^en/i.test(v.lang));
          if (preferred) utter.voice = preferred;
        } catch { /* default voice is fine */ }
        utter.onend = () => resolve();
        utter.onerror = () => resolve();
        window.speechSynthesis.speak(utter);
      } catch { resolve(); }
    });
  },
  stop() {
    try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch { /* speech unavailable */ }
  },
};

/**
 * ElevenLabs text-to-speech via the platform's audio integration — OziUno's
 * natural voice. "Sarah" (EXAVITQu4vr4xnSDxMaL) is warm, friendly and
 * conversational — right for a family aide. The platform generates a hosted
 * MP3 which we play; if generation fails (offline, throttled), we fall back
 * to the browser's built-in speech so voice replies never go silent.
 */
const ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // "Sarah" — friendly, conversational

function workspaceIdForApi(): string {
  const w = window as unknown as { __WORKSPACE_ID__?: string; __SPACE_ID__?: string; __APP_ID__?: string };
  return w.__WORKSPACE_ID__ || w.__SPACE_ID__ || w.__APP_ID__ || "";
}

let elevenAudio: HTMLAudioElement | null = null;
function stopElevenAudio() {
  try { if (elevenAudio) { elevenAudio.pause(); elevenAudio.src = ""; elevenAudio = null; } } catch { /* ignore */ }
}

const elevenLabsTTS: TextToSpeechProvider = {
  id: "elevenlabs-sarah",
  async speak(text) {
    const script = stripForSpeech(text).slice(0, 1200);
    if (!script) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceIdForApi()}/audio/voiceover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, voiceId: ELEVENLABS_VOICE_ID }),
      });
      const data = await res.json() as { audioUrl?: string };
      if (!res.ok || !data.audioUrl) throw new Error("voiceover generation failed");
      stopElevenAudio();
      browserSpeechTTS.stop();
      await new Promise<void>((resolve) => {
        try {
          const audio = new Audio(String(data.audioUrl));
          elevenAudio = audio;
          audio.onended = () => { if (elevenAudio === audio) elevenAudio = null; resolve(); };
          audio.onerror = () => { if (elevenAudio === audio) elevenAudio = null; resolve(); };
          void audio.play().catch(() => { if (elevenAudio === audio) elevenAudio = null; resolve(); });
        } catch { resolve(); }
      });
    } catch (err) {
      console.warn("[OziUno Voice] ElevenLabs speech failed — using browser voice instead:", err);
      await browserSpeechTTS.speak(text);
    }
  },
  stop() {
    stopElevenAudio();
    browserSpeechTTS.stop();
  },
};

/**
 * The active providers. Swap either one without touching the agent, the orb
 * UI, or the app.
 */
export const voiceEngine: { stt: SpeechToTextProvider; tts: TextToSpeechProvider } = {
  stt: platformWhisperSTT,
  tts: elevenLabsTTS,
};

/* ------------------------------ action tools ------------------------------ */

interface ToolResult { ok: boolean; summary: string }

interface ToolDef {
  area: ToolArea;
  /** Sensitive tools require the model to obtain an explicit verbal confirmation first. */
  sensitive?: boolean;
  spec: { name: string; description: string; parameters: Record<string, unknown> };
  run: (args: DbRow, ctx: VoiceMemberCtx) => Promise<ToolResult>;
}

function restrictedRole(role: string) { return role === "child" || role === "guest"; }

async function memberEmailFor(hid: number, name: string): Promise<string | null> {
  const rows = await householdRows("household_memberships", hid);
  const row = matchRow(rows.filter((r) => String(r.status) === "active"), "name", name);
  return row && row.email ? String(row.email).toLowerCase() : null;
}

const TOOLS: ToolDef[] = [
  {
    area: "shopping",
    spec: {
      name: "add_shopping_items",
      description: "Add one or more items to the household's shared shopping list.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Item name, e.g. Milk" },
                quantity: { type: "number", description: "How many (default 1)" },
                unit: { type: "string", description: "e.g. unit, bottles, kg, L" },
                est_cost: { type: "number", description: "Estimated cost in the household currency, only if the user mentioned one" },
              },
              required: ["name"],
            },
          },
        },
        required: ["items"],
      },
    },
    run: async (args, ctx) => {
      const items = Array.isArray(args.items) ? (args.items as { name?: string; quantity?: number; unit?: string; est_cost?: number }[]) : [];
      const rows = items
        .filter((i) => i && String(i.name || "").trim())
        .map((i) => ({
          household_id: ctx.hid, name: String(i.name).trim(), est_cost_ngn: Number(i.est_cost) || 0,
          quantity: Number(i.quantity) || 1, unit: String(i.unit || "unit").trim() || "unit", category: "general",
          source: "assistant", checked: false, added_by: ctx.memberName,
        }));
      if (!rows.length) return { ok: false, summary: "No valid items were given." };
      await vdb("hh_shopping_items").bulkInsert(rows);
      return { ok: true, summary: `Added ${rows.map((r) => r.name).join(", ")} to the shopping list (added by ${ctx.memberName}).` };
    },
  },
  {
    area: "shopping",
    spec: {
      name: "update_shopping_item",
      description: "Change an existing shopping-list item: set a new quantity and/or mark it bought (checked) or not. Marking it bought automatically restocks the pantry with that quantity.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the item already on the list" },
          quantity: { type: "number" },
          unit: { type: "string" },
          checked: { type: "boolean", description: "true = bought / done, false = still needed" },
        },
        required: ["name"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_shopping_items", ctx.hid);
      const unchecked = rows.filter((r) => !r.checked);
      const row = matchRow(unchecked, "name", String(args.name)) || matchRow(rows, "name", String(args.name));
      if (!row) return { ok: false, summary: `"${String(args.name)}" is not on the shopping list. Tell the user and offer to add it.` };
      const patch: DbRow = {};
      if (args.quantity !== undefined && args.quantity !== null) patch.quantity = Number(args.quantity) || 1;
      if (args.unit) patch.unit = String(args.unit);
      if (typeof args.checked === "boolean") patch.checked = args.checked;
      if (!Object.keys(patch).length) return { ok: false, summary: "Nothing to change was given." };
      await vdb("hh_shopping_items").update(Number(row.id), patch);
      if (patch.checked === true && !row.checked) await applyPurchaseToPantryV(ctx.hid, { ...row, ...patch }, 1, ctx.memberName);
      if (patch.checked === false && row.checked) await applyPurchaseToPantryV(ctx.hid, { ...row, ...patch }, -1, ctx.memberName);
      const bits: string[] = [];
      if (patch.quantity !== undefined) bits.push(`quantity → ${String(patch.quantity)}${patch.unit ? " " + String(patch.unit) : ""}`);
      if (patch.checked === true) bits.push("marked as bought — pantry restocked");
      if (patch.checked === false) bits.push("marked as still needed — pantry adjusted back");
      return { ok: true, summary: `Updated ${String(row.name)} on the shopping list (${bits.join(", ")}).` };
    },
  },
  {
    area: "shopping",
    spec: {
      name: "remove_shopping_item",
      description: "Remove an item from the household shopping list entirely.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_shopping_items", ctx.hid);
      const row = matchRow(rows, "name", String(args.name));
      if (!row) return { ok: false, summary: `"${String(args.name)}" is not on the shopping list.` };
      await vdb("hh_shopping_items").delete(Number(row.id));
      return { ok: true, summary: `Removed ${String(row.name)} from the shopping list.` };
    },
  },
  {
    area: "pantry",
    spec: {
      name: "add_pantry_item",
      description: "Add an item to the household inventory (food AND non-food: supplies, toiletries, cleaning, laundry, medicine, baby, pet, maintenance, seasonal). Optionally say where it's kept so OziUno remembers the location.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number", description: "Default 1" },
          unit: { type: "string", description: "e.g. kg, L, dozen, packs, unit" },
          category: { type: "string", enum: ["pantry", "household", "toiletries", "cleaning", "laundry", "medicine", "baby", "pet", "home_maintenance", "seasonal"], description: "Inventory category — food & drinks go in 'pantry' (the default)" },
          location: { type: "string", description: "Room or storage place where it's kept, e.g. 'garage', 'bathroom cabinet', 'fridge'" },
          min_stock_level: { type: "number", description: "Preferred minimum — OziUno flags it for replenishment at or below this" },
        },
        required: ["name"],
      },
    },
    run: async (args, ctx) => {
      const name = String(args.name || "").trim();
      if (!name) return { ok: false, summary: "No item name was given." };
      const rows = await householdRows("hh_inventory_items", ctx.hid);
      const existing = matchRow(rows, "name", name);
      // Controlled units: blank/unknown units fall back to the hardcoded
      // taxonomy default (Eggs → pcs, never kg); "2 dozen" becomes 24 pcs.
      const rawUnit = String(args.unit || "").trim() || defaultUnitFor(name) || "pcs";
      const normalized = normalizeQuantityInput(Number(args.quantity) || 1, rawUnit, name);
      const loc = args.location ? await resolveLocationV(ctx.hid, args.location) : null;
      if (existing) {
        const conv = convertUnits(normalized.qty, normalized.unit, String(existing.unit || ""));
        const delta = conv ?? normalized.qty;
        const res = await postTxn(ctx.hid, existing, {
          type: "manual_adjustment", delta,
          reason: `Stock added by ${ctx.memberName} via assistant (+${normalized.qty} ${normalized.unit})`, createdBy: ctx.memberName,
          ...(loc ? { extraItemPatch: { storage_location_id: loc.id } } : {}),
        });
        return { ok: true, summary: `${String(existing.name)} was already in the inventory — topped it up to ${res.newQty} ${String(existing.unit || normalized.unit)} (recorded in the ledger)${loc ? ` and noted it's kept in ${loc.label}` : ""}.` };
      }
      await vdb("hh_inventory_items").insert({
        household_id: ctx.hid, name, quantity: normalized.qty, unit: normalized.unit,
        ingredient_key: ingredientKeyOf(name),
        category: invCatKeyV(args.category), status: "ok",
        storage_location_id: loc ? loc.id : null,
        min_stock_level: Number(args.min_stock_level) > 0 ? Number(args.min_stock_level) : null,
        added_by: ctx.memberName,
        ...(normalized.package_name ? { package_name: normalized.package_name, package_size: normalized.package_size, package_unit: normalized.package_unit } : {}),
      });
      await recordOpeningBalances(ctx.hid);
      return { ok: true, summary: `Added ${normalized.qty} ${normalized.unit} of ${name} to the inventory (${invCatLabelV(invCatKeyV(args.category))}${loc ? `, kept in ${loc.label}` : ""}; added by ${ctx.memberName}).${args.location && !loc ? " I couldn't match that place to a room — they can set it in Inventory → Rooms." : ""}` };
    },
  },
  {
    area: "pantry",
    spec: {
      name: "find_inventory_items",
      description: "Search the household inventory with room & storage awareness. Use it to answer: where something is kept ('Where are the spare batteries?'), what's stored in a room ('What do we have in the garage?', 'Do we still have washing powder in the garage?'), what's running low, or what expires within a week. Returns items with category, quantity and location (Room · Storage place).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Item name or part of it, e.g. 'batteries'. Omit to list by place or filter." },
          place: { type: "string", description: "Room or storage place to look in, e.g. 'garage', 'fridge', 'bathroom cabinet'" },
          category: { type: "string", enum: ["pantry", "household", "toiletries", "cleaning", "laundry", "medicine", "baby", "pet", "home_maintenance", "seasonal"] },
          filter: { type: "string", enum: ["all", "low", "expiring"], description: "'low' = running low or below minimum stock; 'expiring' = expires within 7 days" },
        },
      },
    },
    run: async (args, ctx) => {
      const [items, locs, rooms] = await Promise.all([
        householdRows("hh_inventory_items", ctx.hid),
        householdRows("hh_storage_locations", ctx.hid),
        householdRows("hh_rooms", ctx.hid),
      ]);
      const locLabel = (id: unknown): string | null => {
        const l = locs.find((x) => Number(x.id) === Number(id));
        if (!l) return null;
        const room = rooms.find((r) => Number(r.id) === Number(l.room_id));
        return room ? `${String(room.name)} · ${String(l.name)}` : String(l.name);
      };
      let list = items;
      const q = norm(args.query);
      if (q) list = list.filter((i) => norm(i.name).includes(q) || q.includes(norm(i.name)));
      const place = norm(args.place);
      if (place) {
        const locIds = new Set<number>();
        for (const l of locs) {
          const room = rooms.find((r) => Number(r.id) === Number(l.room_id));
          const full = `${room ? norm(room.name) + " " : ""}${norm(l.name)}`;
          if (full.includes(place) || place.includes(norm(l.name)) || (room && place.includes(norm(room.name)))) locIds.add(Number(l.id));
        }
        list = list.filter((i) => locIds.has(Number(i.storage_location_id)));
      }
      const cat = norm(args.category);
      if (cat) list = list.filter((i) => invCatKeyV(i.category) === cat);
      const mode = norm(args.filter);
      if (mode === "low") list = list.filter(invIsLowV);
      if (mode === "expiring") list = list.filter((i) => {
        if (!i.expires_at) return false;
        const d = Math.round((new Date(String(i.expires_at)).getTime() - Date.now()) / 86400000);
        return d <= 7;
      });
      if (!list.length) return { ok: true, summary: "Nothing in the inventory matches that. Offer to add it, or to put it on the shopping list." };
      const lines = list.slice(0, 15).map((i) => {
        const where = i.storage_location_id != null ? locLabel(i.storage_location_id) : null;
        const risk = assessPantryRiskV(i);
        return `${String(i.name)} — ${Number(i.quantity) || 0} ${String(i.unit || "unit")} (${invCatLabelV(invCatKeyV(i.category))}${where ? `, kept in ${where}` : ", no location recorded"})${invIsLowV(i) ? " — running low" : ""}${risk ? ` — ${risk.severity}: ${risk.reason}` : ""}`;
      });
      return { ok: true, summary: `Found ${list.length} item${list.length === 1 ? "" : "s"}:\n${lines.join("\n")}${list.length > 15 ? `\n…and ${list.length - 15} more.` : ""}` };
    },
  },
  {
    area: "pantry",
    spec: {
      name: "update_pantry_item",
      description: "Update an inventory item: quantity, stock status (ok, warn = running low, empty), where it's kept, or its minimum stock level.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          status: { type: "string", enum: ["ok", "warn", "empty"] },
          location: { type: "string", description: "Room or storage place it's kept in, e.g. 'garage shelf'" },
          min_stock_level: { type: "number", description: "Preferred minimum stock" },
        },
        required: ["name"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_inventory_items", ctx.hid);
      const row = matchRow(rows, "name", String(args.name));
      if (!row) return { ok: false, summary: `"${String(args.name)}" is not in the inventory. Tell the user and offer to add it.` };
      const patch: DbRow = {};
      if (typeof args.status === "string" && ["ok", "warn", "empty"].includes(args.status)) patch.status = args.status;
      if (Number(args.min_stock_level) > 0) patch.min_stock_level = Number(args.min_stock_level);
      let locNote = "";
      if (args.location) {
        const loc = await resolveLocationV(ctx.hid, args.location);
        if (loc) { patch.storage_location_id = loc.id; locNote = ` — kept in ${loc.label}`; }
        else locNote = " (I couldn't match that place to a room — set it in Inventory → Rooms)";
      }
      // Quantity changes are MEMBER-CONFIRMED corrections and go through the
      // ledger as manual_adjustment transactions — never a silent overwrite.
      let newQtyNote = "";
      if (args.quantity !== undefined && args.quantity !== null) {
        const q = Number(args.quantity);
        const target = Number.isFinite(q) && q >= 0 ? q : 0;
        const delta = Math.round((target - (Number(row.quantity) || 0)) * 100) / 100;
        const res = await postTxn(ctx.hid, row, {
          type: "manual_adjustment", delta,
          reason: `Stock corrected by ${ctx.memberName} via assistant: ${Number(row.quantity) || 0} → ${target} ${String(row.unit || "")}`.trim(),
          createdBy: ctx.memberName,
          ...(Object.keys(patch).length ? { extraItemPatch: patch } : {}),
        });
        newQtyNote = ` — now ${res.newQty} ${String(row.unit || "")}`.trimEnd();
      } else if (Object.keys(patch).length) {
        await vdb("hh_inventory_items").update(Number(row.id), patch);
      } else {
        return { ok: false, summary: "Nothing to change was given." };
      }
      return { ok: true, summary: `Updated ${String(row.name)} in the inventory${newQtyNote}${patch.status ? ` (${String(patch.status)})` : ""}${locNote}.` };
    },
  },
  {
    area: "pantry",
    spec: {
      name: "remove_pantry_item",
      description: "Remove an item from the household inventory entirely.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_inventory_items", ctx.hid);
      const row = matchRow(rows, "name", String(args.name));
      if (!row) return { ok: false, summary: `"${String(args.name)}" is not in the inventory.` };
      await vdb("hh_inventory_items").delete(Number(row.id));
      return { ok: true, summary: `Removed ${String(row.name)} from the inventory.` };
    },
  },
  {
    area: "schedule",
    spec: {
      name: "add_schedule_event",
      description: "Add an event or appointment to the shared family calendar. Resolve relative dates/times into a full ISO 8601 datetime first.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "e.g. Doctor's appointment" },
          starts_at: { type: "string", description: "ISO 8601 datetime, e.g. 2026-07-31T10:00:00" },
          category: { type: "string", enum: ["school", "delivery", "chore", "family", "maintenance", "other"] },
          member_name: { type: "string", description: "Which household member it's for; omit for the whole household" },
          notes: { type: "string" },
        },
        required: ["title", "starts_at"],
      },
    },
    run: async (args, ctx) => {
      const title = String(args.title || "").trim();
      const when = new Date(String(args.starts_at));
      if (!title || Number.isNaN(when.getTime())) return { ok: false, summary: "A title and a valid ISO datetime are required." };
      await vdb("hh_schedule_events").insert({
        household_id: ctx.hid, title, notes: args.notes ? String(args.notes) : null,
        starts_at: when.toISOString(), category: String(args.category || "family"),
        member_name: args.member_name ? String(args.member_name) : null, added_by: ctx.memberName,
      });
      return { ok: true, summary: `Added "${title}" to the family schedule for ${when.toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (added by ${ctx.memberName}).` };
    },
  },
  {
    area: "schedule",
    spec: {
      name: "remove_schedule_event",
      description: "Remove an event from the family calendar by its title.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_schedule_events", ctx.hid);
      const row = matchRow(rows, "title", String(args.title));
      if (!row) return { ok: false, summary: `No event called "${String(args.title)}" was found on the schedule.` };
      await vdb("hh_schedule_events").delete(Number(row.id));
      return { ok: true, summary: `Removed "${String(row.title)}" from the schedule.` };
    },
  },
  {
    area: "tasks",
    spec: {
      name: "add_task",
      description: "Add a chore, reminder or to-do. Use for things like 'remind me to clean the kitchen tomorrow'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          assignee_name: { type: "string", description: "Household member responsible; omit for unassigned. 'me' = the speaking member." },
          due_at: { type: "string", description: "ISO 8601 datetime, if a time was mentioned" },
          personal: { type: "boolean", description: "true = private just-for-me task, false/omitted = shared household task" },
        },
        required: ["title"],
      },
    },
    run: async (args, ctx) => {
      const title = String(args.title || "").trim();
      if (!title) return { ok: false, summary: "No task title was given." };
      const child = ctx.memberRole === "child";
      let assigneeName: string | null = args.assignee_name ? String(args.assignee_name).trim() : null;
      if (assigneeName && /^(me|myself)$/i.test(assigneeName)) assigneeName = ctx.memberName;
      if (child) assigneeName = ctx.memberName; // children only manage their own chores
      let assigneeEmail: string | null = null;
      if (assigneeName) {
        assigneeEmail = norm(assigneeName) === norm(ctx.memberName)
          ? ctx.memberEmail
          : await memberEmailFor(ctx.hid, assigneeName);
      }
      const due = args.due_at ? new Date(String(args.due_at)) : null;
      await vdb("hh_tasks").insert({
        household_id: ctx.hid, title, category: "general",
        assignee_name: assigneeName, assignee_email: assigneeEmail,
        due_at: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null,
        recurrence: null, visibility: args.personal === true ? "personal" : "household",
        created_by_email: ctx.memberEmail, added_by: ctx.memberName,
      });
      return { ok: true, summary: `Added the task "${title}"${assigneeName ? ` for ${assigneeName}` : ""}${due && !Number.isNaN(due.getTime()) ? `, due ${due.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""} (added by ${ctx.memberName}).` };
    },
  },
  {
    area: "tasks",
    spec: {
      name: "complete_task",
      description: "Mark an open task or chore as done.",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "Title (or part of it) of the task to complete" } },
        required: ["title"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_tasks", ctx.hid);
      const myEmail = norm(ctx.memberEmail);
      const visible = rows.filter((t) => {
        if (t.completed_at) return false;
        if (String(t.visibility) === "personal" && norm(t.created_by_email) !== myEmail && norm(t.assignee_email) !== myEmail) return false;
        if (ctx.memberRole === "child") return String(t.assignee_name || "") === ctx.memberName || norm(t.assignee_email) === myEmail;
        return true;
      });
      const row = matchRow(visible, "title", String(args.title));
      if (!row) return { ok: false, summary: `No open task matching "${String(args.title)}" was found (it may already be done, or not be yours to complete).` };
      await vdb("hh_tasks").update(Number(row.id), { completed_at: new Date().toISOString() });
      return { ok: true, summary: `Marked "${String(row.title)}" as done (completed by ${ctx.memberName}).` };
    },
  },
  {
    area: "bills",
    spec: {
      name: "add_bill",
      description: "Record a household bill that is due (a reminder — this does NOT pay anything).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "e.g. Electricity" },
          amount: { type: "number", description: "Amount in the household currency" },
          due_date: { type: "string", description: "YYYY-MM-DD" },
          category: { type: "string", description: "e.g. utility, rent, school, subscription" },
          assigned_to: { type: "string", description: "Household member responsible, if mentioned" },
        },
        required: ["name", "amount", "due_date"],
      },
    },
    run: async (args, ctx) => {
      const name = String(args.name || "").trim();
      const amount = Number(args.amount);
      const due = String(args.due_date || "").slice(0, 10);
      if (!name || !Number.isFinite(amount) || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        return { ok: false, summary: "A bill needs a name, an amount and a YYYY-MM-DD due date." };
      }
      await vdb("hh_bills").insert({
        household_id: ctx.hid, name, amount_ngn: amount, due_date: due,
        category: String(args.category || "utility"), paid: false,
        assigned_to: args.assigned_to ? String(args.assigned_to) : null, added_by: ctx.memberName,
      });
      return { ok: true, summary: `Logged the ${name} bill — ${ctx.currencySymbol}${amount.toLocaleString()} due ${due} (added by ${ctx.memberName}).` };
    },
  },
  {
    area: "bills",
    sensitive: true,
    spec: {
      name: "mark_bill_paid",
      description: "Mark a recorded bill as paid. SENSITIVE: ask the user to confirm out loud first, then call again with confirmed=true. This only updates the household record — it never moves money.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          confirmed: { type: "boolean", description: "Must be true, and only after the user explicitly confirmed" },
        },
        required: ["name", "confirmed"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_bills", ctx.hid);
      const unpaid = rows.filter((b) => !b.paid);
      const row = matchRow(unpaid, "name", String(args.name));
      if (!row) return { ok: false, summary: `No unpaid bill matching "${String(args.name)}" was found.` };
      await vdb("hh_bills").update(Number(row.id), { paid: true, paid_at: new Date().toISOString() });
      await syncBudgetSpent(ctx.hid, row.category, row.amount_ngn);
      return { ok: true, summary: `Marked the ${String(row.name)} bill (${ctx.currencySymbol}${Number(row.amount_ngn || 0).toLocaleString()}) as paid and added it to this month's budget (recorded by ${ctx.memberName}).` };
    },
  },
  {
    area: "meals",
    spec: {
      name: "plan_meal",
      description: "Set or replace a meal on the family meal plan for a given day.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          meal: { type: "string", enum: ["breakfast", "lunch", "dinner"] },
          title: { type: "string", description: "e.g. Jollof rice & grilled snapper" },
          notes: { type: "string", description: "One-line recipe note, optional" },
        },
        required: ["date", "meal", "title"],
      },
    },
    run: async (args, ctx) => {
      if (restrictedRole(ctx.memberRole)) {
        return { ok: false, summary: "Children and guests can view the meal plan but not change it. Explain this kindly." };
      }
      const date = String(args.date || "").slice(0, 10);
      const meal = norm(args.meal);
      const title = String(args.title || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["breakfast", "lunch", "dinner"].includes(meal) || !title) {
        return { ok: false, summary: "A meal plan needs a YYYY-MM-DD date, a meal (breakfast/lunch/dinner) and a dish." };
      }
      const rows = await householdRows("hh_meal_plans", ctx.hid);
      const existing = rows.find((p) => String(p.date).slice(0, 10) === date && norm(p.meal) === meal);
      if (existing) {
        await vdb("hh_meal_plans").update(Number(existing.id), { title, recipe_md: args.notes ? String(args.notes) : "" });
        return { ok: true, summary: `Updated ${meal} on ${date} to "${title}".` };
      }
      await vdb("hh_meal_plans").insert({
        household_id: ctx.hid, date, meal, title,
        recipe_md: args.notes ? String(args.notes) : "", added_by: ctx.memberName,
      });
      return { ok: true, summary: `Planned "${title}" for ${meal} on ${date} (added by ${ctx.memberName}).` };
    },
  },
  {
    area: "maintenance",
    spec: {
      name: "add_maintenance_task",
      description: "Track an appliance or home-care item that needs servicing, e.g. 'service the air conditioner next month'.",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "e.g. Air conditioner, Generator" },
          next_due_at: { type: "string", description: "YYYY-MM-DD when it's next due" },
          interval_days: { type: "number", description: "How often it recurs, in days (default 90)" },
          category: { type: "string", enum: ["appliance", "home", "safety", "vehicle", "other"] },
          notes: { type: "string" },
        },
        required: ["asset", "next_due_at"],
      },
    },
    run: async (args, ctx) => {
      const asset = String(args.asset || "").trim();
      const due = String(args.next_due_at || "").slice(0, 10);
      if (!asset || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, summary: "An asset name and a YYYY-MM-DD due date are required." };
      await vdb("hh_maintenance_tasks").insert({
        household_id: ctx.hid, asset, category: String(args.category || "appliance"),
        interval_days: Number(args.interval_days) || 90, next_due_at: due,
        notes: args.notes ? String(args.notes) : null, added_by: ctx.memberName,
      });
      return { ok: true, summary: `Added ${asset} to maintenance — next due ${due} (added by ${ctx.memberName}).` };
    },
  },
  {
    area: "wasteless",
    spec: {
      name: "get_wasteless_report",
      description: "WasteLess report from real household data: inventory items (all categories) at risk of being wasted (use today / use soon / likely wasted), the household's consumption patterns, over-buying flags, and estimated savings. Call this whenever the user asks what to use up, what's expiring, whether they're wasting food or money, or how to shop smarter.",
      parameters: { type: "object", properties: {} },
    },
    run: async (_args, ctx) => {
      const [pantry, activeRes, doneRes] = await Promise.all([
        householdRows("hh_inventory_items", ctx.hid),
        vdb("hh_wasteless_insights").eq("household_id", ctx.hid).eq("status", "active").orderBy("created_at", "desc").limit(15).get(),
        vdb("hh_wasteless_insights").eq("household_id", ctx.hid).eq("status", "done").limit(50).get(),
      ]);
      const atRisk = pantry
        .map((p) => ({ p, r: assessPantryRiskV(p) }))
        .filter((x): x is { p: DbRow; r: { severity: string; reason: string } } => !!x.r);
      const insights = (activeRes.data || []);
      const saved = (doneRes.data || []).reduce((s, i) => s + (Number(i.est_value_ngn) || 0), 0);
      const lines: string[] = [];
      lines.push(atRisk.length
        ? `At risk of being wasted: ${atRisk.map((x) => `${String(x.p.name)} (${Number(x.p.quantity) || 0} ${String(x.p.unit || "unit")}) — ${x.r.severity}, ${x.r.reason}`).join("; ")}.`
        : "Nothing in the inventory is at risk of being wasted right now.");
      const byType = (t: string) => insights.filter((i) => String(i.insight_type) === t).map((i) => String(i.message));
      const patterns = byType("pattern");
      if (patterns.length) lines.push(`Consumption patterns: ${patterns.join(" ")}`);
      const recs = byType("recommendation");
      if (recs.length) lines.push(`Possible over-buying: ${recs.join(" ")}`);
      const savings = byType("savings");
      if (savings.length) lines.push(savings.join(" "));
      if (saved > 0) lines.push("So far the household has saved about " + ctx.currencySymbol + Math.round(saved).toLocaleString() + " by acting on WasteLess alerts.");
      lines.push("The WasteLess screen in the app has one-tap actions for each of these (add to meal plan, mark as used, remove from list).");
      return { ok: true, summary: lines.join("\n") };
    },
  },
  {
    area: "maintenance",
    spec: {
      name: "mark_maintenance_serviced",
      description: "Record that an appliance / maintenance item was serviced today; the next due date rolls forward by its interval.",
      parameters: {
        type: "object",
        properties: { asset: { type: "string" } },
        required: ["asset"],
      },
    },
    run: async (args, ctx) => {
      const rows = await householdRows("hh_maintenance_tasks", ctx.hid);
      const row = matchRow(rows, "asset", String(args.asset));
      if (!row) return { ok: false, summary: `No maintenance item matching "${String(args.asset)}" was found.` };
      const interval = Number(row.interval_days) || 90;
      const next = new Date(); next.setDate(next.getDate() + interval);
      await vdb("hh_maintenance_tasks").update(Number(row.id), {
        last_serviced_at: todayKey(), next_due_at: next.toISOString().slice(0, 10),
      });
      return { ok: true, summary: `Recorded ${String(row.asset)} as serviced today — next due ${next.toISOString().slice(0, 10)} (recorded by ${ctx.memberName}).` };
    },
  },
];

/* ------------------------------- agent loop ------------------------------- */

interface ToolCallPayload { id: string; type: "function"; function: { name: string; arguments: string } }

type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallPayload[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentTurnOptions {
  /** Role-aware system prompt + live household data, built fresh by the app for every turn. */
  system: string;
  /** Recent conversation turns — gives the assistant short-term memory ("make that two bottles"). */
  history: { role: "user" | "assistant"; content: string }[];
  userText: string;
  ctx: VoiceMemberCtx;
  /** true when the reply will be read aloud — keeps answers short and speech-friendly. */
  spoken?: boolean;
}

export interface AgentTurnResult {
  reply: string;
  /** Human-readable summaries of every action that actually changed household data. */
  actions: string[];
}

function agentGuidance(ctx: VoiceMemberCtx, spoken: boolean): string {
  const now = new Date();
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
  const lines = [
    "== Acting on the household (tools) ==",
    `Right now it is ${now.toLocaleString([], { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} in the ${tz} timezone. Today's date is ${todayKey()}.`,
    "- You don't just talk — you DO things. When the user asks you to add, change, complete or remove household data (shopping, inventory, schedule, tasks, bills, meals, maintenance), call the matching tool. Never claim something was done without calling the tool.",
    "- The household inventory is spatial: items live in categories (Pantry food, Household Supplies, Toiletries, Cleaning, Laundry, Medicine, Baby, Pet, Home Maintenance, Seasonal) AND in storage locations inside rooms. For 'where is X?', 'what do we have in the <room>?', 'what's running low?' or 'what expires soon?', call find_inventory_items and answer from it.",
    "- Resolve relative dates and times (\"tomorrow\", \"Friday at 10am\", \"next month\") into concrete ISO values yourself before calling tools — never pass relative words to a tool.",
    `- All money is in ${ctx.currencyCode} (${ctx.currencySymbol}).`,
    "- Follow-ups refer to the conversation so far (\"make that two bottles\" means update the quantity of the item just discussed) — use the history; never make the user repeat themselves.",
    "- Confirm actions in ONE short, warm sentence (\"Done. I've added it to your list.\"). If something fails, say \"Sorry, I couldn't complete that just yet. Would you like me to try again?\" — never robotic phrasing like \"Your request has been successfully processed\".",
    "- SENSITIVE actions (marking a bill paid, anything financial): first say what you're about to do and ask the user to confirm; only after a clear yes call the tool with confirmed=true. Voice is NEVER identity verification, and you can never move money or authorise a payment.",
    "- If a tool says the action isn't permitted for this member's role, apologise kindly and suggest asking the Household Owner.",
    "- For questions about food waste, expiring items, what to use up, or saving money on groceries, call get_wasteless_report and answer from it — you can then act on it with plan_meal, update_pantry_item or the shopping tools if the user agrees.",
    `- If asked what you can help with, answer briefly and warmly: what's happening today, the shopping list, the household inventory (what's where, what's running low), meals, chores and reminders${ctx.can("bills") ? ", bills, budgets and home maintenance" : " and more"} — just say it, by voice or by typing.`,
  ];
  if (spoken) {
    lines.push("- VOICE MODE: your reply will be read aloud. Keep it to one or two short, natural spoken sentences unless the user asks for detail. Plain text only — no markdown, no bullet lists, no emojis.");
  }
  return lines.join("\n");
}

/**
 * One full assistant turn: understand intent → check permissions → call tools
 * that write to the household → produce a short, warm confirmation.
 * Used by BOTH the voice orb and the typed Chat, so the assistant behaves the
 * same everywhere.
 */
export async function runOziAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  // Only expose the tools this member's role is allowed to use — the model
  // can't even see areas (e.g. bills for a child) it must not touch.
  const allowed = TOOLS.filter((t) => opts.ctx.can(t.area));
  const toolSpecs = allowed.map((t) => ({ type: "function", function: t.spec }));
  const messages: AgentMessage[] = [
    { role: "system", content: `${opts.system}\n\n${agentGuidance(opts.ctx, !!opts.spoken)}` },
    ...opts.history.map((h) => ({ role: h.role, content: h.content } as AgentMessage)),
    { role: "user", content: opts.userText },
  ];
  const actions: string[] = [];

  for (let round = 0; round < 5; round++) {
    const res = await fetch("/proxy/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        stream: false,
        ...(toolSpecs.length ? { tools: toolSpecs, tool_choice: "auto" } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`AI request failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message as { content?: string | null; tool_calls?: ToolCallPayload[] } | undefined;
    if (!msg) throw new Error("AI unavailable");

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      return { reply: String(msg.content || "").trim(), actions };
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let resultText: string;
      const def = TOOLS.find((t) => t.spec.name === call.function?.name);
      if (!def) {
        resultText = "Unknown tool — do not retry it.";
      } else if (!opts.ctx.can(def.area)) {
        resultText = `Not permitted: ${firstName(opts.ctx.memberName)}'s role (${opts.ctx.memberRole}) doesn't have access to ${def.area}. Explain this kindly.`;
      } else {
        let args: DbRow = {};
        try { args = JSON.parse(call.function.arguments || "{}") as DbRow; } catch { /* treat as empty args */ }
        if (def.sensitive && args.confirmed !== true) {
          resultText = "CONFIRMATION_REQUIRED: sensitive action — nothing was changed. Tell the user exactly what you're about to do and ask them to confirm. Only call this tool again, with confirmed=true, after they clearly say yes.";
        } else {
          try {
            const result = await def.run(args, opts.ctx);
            resultText = result.summary;
            if (result.ok) actions.push(result.summary);
          } catch (err) {
            console.error("[OziUno voice] Tool failed:", call.function?.name, err);
            resultText = "The action failed unexpectedly. Apologise briefly and offer to try again.";
          }
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }

  return { reply: "Sorry, I couldn't complete that just yet. Would you like me to try again?", actions };
}

/* ------------------------------ voice prefs ------------------------------- */

function useVoicePref(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : raw === "1"; } catch { return fallback; }
  });
  const set = (v: boolean) => {
    setValue(v);
    try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* storage unavailable */ }
  };
  return [value, set];
}

/* --------------------------------- styles --------------------------------- */

const VOICE_CSS = `
.oziv-fab{position:fixed;right:1.25rem;bottom:1.25rem;z-index:45;width:56px;height:56px;border-radius:9999px;border:none;cursor:pointer;display:grid;place-items:center;color:#04201c;background:linear-gradient(135deg,#5eead4,#22d3ee);box-shadow:0 8px 24px rgba(45,212,191,.35);transition:transform .15s}
.oziv-fab:hover{transform:scale(1.06)}
.oziv-fab.off{background:#ffffff;color:#5b6b81;box-shadow:0 4px 14px rgba(15,27,45,.12);border:1px solid rgba(15,27,45,.12);width:44px;height:44px}
.oziv-overlay{position:fixed;inset:0;z-index:90;background:radial-gradient(circle at 50% 0%,#ffffff 0%,#f2f9f9 45%,#e8f4f6 100%);color:#0f1b2d;display:flex;flex-direction:column;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.oziv-header{display:flex;align-items:center;gap:.75rem;padding:1rem 1.25rem;flex-shrink:0}
.oziv-shield{display:inline-flex;align-items:center;gap:.375rem;font-size:.6875rem;color:#8595a9}
.oziv-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;align-items:center;padding:0 1.25rem 1rem;gap:1rem}
.oziv-orb-wrap{position:relative;width:190px;height:190px;display:grid;place-items:center;flex-shrink:0;margin-top:.5rem}
.oziv-orb{width:150px;height:150px;border-radius:9999px;border:none;cursor:pointer;display:grid;place-items:center;color:#ffffff;background:radial-gradient(circle at 32% 28%,#2dd4bf 0%,#0d9488 45%,#0f766e 100%);box-shadow:0 0 60px rgba(45,212,191,.45),inset 0 0 30px rgba(255,255,255,.18);transition:transform .15s,box-shadow .3s}
.oziv-orb:active{transform:scale(.96)}
.oziv-orb.listening{background:radial-gradient(circle at 32% 28%,#7dd3fc 0%,#38bdf8 45%,#0284c7 100%);box-shadow:0 0 80px rgba(56,189,248,.5),inset 0 0 30px rgba(255,255,255,.28);color:#ffffff}
.oziv-orb.speaking{box-shadow:0 0 80px rgba(45,212,191,.6),inset 0 0 40px rgba(255,255,255,.25)}
.oziv-ring{position:absolute;inset:0;border-radius:9999px;border:2px solid rgba(56,189,248,.5);animation:ozivPing 1.6s cubic-bezier(0,0,.2,1) infinite;pointer-events:none}
.oziv-ring.r2{animation-delay:.5s}
.oziv-ring.r3{animation-delay:1s}
@keyframes ozivPing{0%{transform:scale(.82);opacity:.9}100%{transform:scale(1.28);opacity:0}}
.oziv-spin{position:absolute;inset:8px;border-radius:9999px;border:3px solid transparent;border-top-color:#0d9488;border-right-color:rgba(13,148,136,.35);animation:ozivSpin .9s linear infinite;pointer-events:none}
@keyframes ozivSpin{to{transform:rotate(360deg)}}
.oziv-bars{display:flex;gap:5px;align-items:center;height:46px}
.oziv-bars span{width:6px;border-radius:3px;background:#ffffff;animation:ozivBar 1s ease-in-out infinite}
.oziv-bars span:nth-child(2){animation-delay:.12s}
.oziv-bars span:nth-child(3){animation-delay:.24s}
.oziv-bars span:nth-child(4){animation-delay:.36s}
.oziv-bars span:nth-child(5){animation-delay:.48s}
@keyframes ozivBar{0%,100%{height:12px}50%{height:42px}}
.oziv-status{font-size:.875rem;color:#5b6b81;min-height:1.25rem;text-align:center}
.oziv-live{display:inline-flex;align-items:center;gap:.4rem;font-size:.8125rem;color:#b91c1c;font-weight:600}
.oziv-live::before{content:"";width:8px;height:8px;border-radius:9999px;background:#dc2626;animation:ozivBlink 1s ease-in-out infinite}
@keyframes ozivBlink{50%{opacity:.35}}
.oziv-transcript{width:100%;max-width:560px;display:flex;flex-direction:column;gap:.625rem}
.oziv-msg-user{align-self:flex-end;background:#0d9488;color:#f8fafc;border-radius:1rem;border-top-right-radius:.25rem;padding:.5rem .875rem;font-size:.875rem;max-width:85%}
.oziv-msg-ai{align-self:flex-start;font-size:.9375rem;line-height:1.55;max-width:92%;color:#0f1b2d;white-space:pre-wrap}
.oziv-chip{display:inline-flex;align-items:center;gap:.35rem;font-size:.6875rem;background:rgba(45,212,191,.16);color:#0f766e;border-radius:9999px;padding:3px 10px}
.oziv-suggest{border:1px solid rgba(15,27,45,.12);background:#ffffff;color:#3b4d63;border-radius:9999px;padding:.45rem .9rem;font-size:.8125rem;cursor:pointer;box-shadow:0 4px 12px rgba(15,27,45,.05)}
.oziv-suggest:hover{background:rgba(45,212,191,.1);border-color:rgba(45,212,191,.4)}
.oziv-footer{display:flex;align-items:center;justify-content:center;gap:.75rem;padding:1rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom,0px));flex-shrink:0}
.oziv-iconbtn{width:44px;height:44px;border-radius:9999px;border:1px solid rgba(15,27,45,.14);background:#ffffff;color:#3b4d63;cursor:pointer;display:grid;place-items:center}
.oziv-iconbtn.on{background:rgba(45,212,191,.16);border-color:rgba(45,212,191,.5);color:#0f766e}
.oziv-panel{width:100%;max-width:560px;background:#ffffff;border:1px solid rgba(15,27,45,.08);border-radius:1.25rem;padding:1.125rem;display:grid;gap:.875rem;box-shadow:0 12px 32px rgba(15,27,45,.06)}
.oziv-panel h3{font-size:.9375rem;font-weight:600;display:flex;align-items:center;gap:.5rem}
.oziv-panel p{font-size:.8125rem;line-height:1.55;color:#5b6b81}
.oziv-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.oziv-textbtn{display:inline-flex;align-items:center;gap:.45rem;border-radius:9999px;border:1px solid rgba(15,27,45,.14);background:transparent;color:#3b4d63;padding:.45rem .9rem;font-size:.8125rem;cursor:pointer}
.oziv-textbtn:hover{background:rgba(15,27,45,.04)}
.oziv-textbtn.danger{border-color:rgba(220,38,38,.4);color:#b91c1c}
`;

/* ---------------------------- overlay component --------------------------- */

type VoiceState = "idle" | "listening" | "processing" | "speaking";

interface Turn { role: "user" | "assistant"; content: string; actions?: string[] }

const STATUS_LABEL: Record<VoiceState, string> = {
  idle: "Tap the orb and speak",
  listening: "", // replaced by the live mic indicator
  processing: "Thinking…",
  speaking: "Speaking — tap the orb to jump in",
};

const SUGGESTIONS = [
  "What's happening in the house today?",
  "Add milk to the shopping list",
  "Where did we put the spare batteries?",
  "What's running low at home?",
];

export function VoiceAssistant({ ctx, buildSystem }: { ctx: VoiceMemberCtx; buildSystem: () => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useVoicePref("ozi_voice_enabled", true);
  const [speakReplies, setSpeakReplies] = useVoicePref("ozi_voice_speak", true);
  const [state, setState] = useState<VoiceState>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [hint, setHint] = useState("");
  const [showPrivacy, setShowPrivacy] = useState(false);
  const turnsRef = useRef<Turn[]>([]);
  const openRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const speakRef = useRef(speakReplies);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  speakRef.current = speakReplies;
  openRef.current = open;

  const pushTurn = (t: Turn) => { turnsRef.current = [...turnsRef.current, t]; setTurns(turnsRef.current); };

  // The dashboard's voice button (and any future entry point) opens the
  // assistant through this event — tapping it is explicit re-engagement, so
  // it also re-enables voice if it was switched off.
  useEffect(() => {
    const openVoice = () => {
      try { localStorage.setItem("ozi_voice_enabled", "1"); } catch { /* storage unavailable */ }
      setEnabled(true);
      setOpen(true);
    };
    window.addEventListener("ozi:open-voice", openVoice);
    return () => window.removeEventListener("ozi:open-voice", openVoice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Safety net: stop the mic and the speaker if the component unmounts.
  useEffect(() => () => {
    try { recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* already stopped */ }
    voiceEngine.tts.stop();
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, state, open, showPrivacy]);

  const runTurn = async (text: string) => {
    const history = turnsRef.current.slice(-12).map((t) => ({ role: t.role, content: t.content }));
    pushTurn({ role: "user", content: text });
    setState("processing");
    setHint("");
    let reply = "";
    let actions: string[] = [];
    try {
      const system = await buildSystem();
      const result = await runOziAgentTurn({ system, history, userText: text, ctx, spoken: true });
      reply = result.reply || "Done.";
      actions = result.actions;
    } catch (err) {
      console.error("[OziUno voice] Turn failed:", err);
      reply = "Sorry, I couldn't complete that just yet. Would you like me to try again?";
    }
    pushTurn({ role: "assistant", content: reply, actions });
    if (actions.length) {
      try { window.dispatchEvent(new CustomEvent("ozi:data-changed")); } catch { /* no-op */ }
    }
    if (speakRef.current && openRef.current) {
      setState("speaking");
      await voiceEngine.tts.speak(reply);
    }
    setState("idle");
  };

  const handleRecording = async (blob: Blob) => {
    if (!openRef.current) return; // closed mid-recording — discard silently
    if (blob.size < 200) { setState("idle"); return; } // accidental tap, not speech
    setState("processing");
    let text = "";
    try {
      text = await voiceEngine.stt.transcribe(blob);
    } catch {
      setHint("Sorry, I couldn't make that out. Would you like to try again?");
      setState("idle");
      return;
    }
    if (!text) {
      setHint("Didn't catch that — try again, a little closer to the mic.");
      setState("idle");
      return;
    }
    await runTurn(text);
  };

  const startListening = async () => {
    try {
      voiceEngine.tts.stop();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        void handleRecording(blob);
      };
      recorder.start();
      setHint("");
      setState("listening");
    } catch {
      setHint("I can't hear you yet — your browser blocked the microphone. Allow it in your browser's site settings and try again, or just type in Chat.");
      setState("idle");
    }
  };

  const finishListening = () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setState("processing");
  };

  const orbTap = () => {
    if (state === "idle") void startListening();
    else if (state === "listening") finishListening();
    else if (state === "speaking") { voiceEngine.tts.stop(); void startListening(); } // interrupt & talk
    // "processing" ignores taps
  };

  const close = () => {
    openRef.current = false;
    setOpen(false);
    setShowPrivacy(false);
    voiceEngine.tts.stop();
    try { if (recorderRef.current?.state === "recording") recorderRef.current.stop(); } catch { /* already stopped */ }
    setState("idle");
  };

  const clearConversation = () => {
    turnsRef.current = [];
    setTurns([]);
    setHint("");
  };

  const hour = new Date().getHours();
  const greeting = `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${firstName(ctx.memberName)}.`;

  if (!enabled) {
    return (
      <>
        <style>{VOICE_CSS}</style>
        <button
          type="button"
          className="oziv-fab off"
          onClick={() => { setEnabled(true); setOpen(true); }}
          aria-label="Voice assistant is off — tap to turn it back on"
          title="Voice assistant is off — tap to turn it back on"
        >
          <MicOff size={18} />
        </button>
      </>
    );
  }

  return (
    <>
      <style>{VOICE_CSS}</style>
      {!open && (
        <button
          type="button"
          className="oziv-fab"
          onClick={() => setOpen(true)}
          aria-label="Talk to OziUno — open the voice assistant"
          title="Talk to OziUno"
        >
          <Mic size={22} />
        </button>
      )}
      {open && (
        <div className="oziv-overlay" role="dialog" aria-label="OziUno voice assistant">
          <header className="oziv-header">
            <div style={{ width: 34, height: 34, borderRadius: 12, background: "linear-gradient(135deg,#5eead4,#22d3ee)", color: "#04201c", display: "grid", placeItems: "center", fontFamily: '"Instrument Serif",serif', fontSize: "1.125rem" }}>O</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: ".9375rem", fontWeight: 600 }}>OziUno Voice</p>
              <p className="oziv-shield"><ShieldCheck size={12} /> Tap-to-speak only — the mic never listens in the background</p>
            </div>
            <button type="button" className="oziv-iconbtn" onClick={close} aria-label="Close voice assistant"><X size={18} /></button>
          </header>

          <div className="oziv-body" ref={scrollRef}>
            <div className="oziv-orb-wrap">
              {state === "listening" && (<><span className="oziv-ring" /><span className="oziv-ring r2" /><span className="oziv-ring r3" /></>)}
              {state === "processing" && <span className="oziv-spin" />}
              <button
                type="button"
                className={`oziv-orb ${state}`}
                onClick={orbTap}
                aria-label={state === "idle" ? "Tap to speak" : state === "listening" ? "Listening — tap when you're done" : state === "speaking" ? "Tap to interrupt and speak" : "Thinking"}
              >
                {state === "speaking"
                  ? <span className="oziv-bars" aria-hidden="true"><span /><span /><span /><span /><span /></span>
                  : <Mic size={44} strokeWidth={1.6} />}
              </button>
            </div>

            {state === "listening"
              ? <p className="oziv-live">Microphone is on — tap the orb when you're done</p>
              : <p className="oziv-status">{STATUS_LABEL[state]}</p>}
            {hint && <p className="oziv-status" role="alert" style={{ color: "#b45309" }}>{hint}</p>}

            {!turns.length && state === "idle" && (
              <div style={{ textAlign: "center", display: "grid", gap: ".875rem", maxWidth: 480 }}>
                <p style={{ fontFamily: '"Instrument Serif",serif', fontSize: "1.375rem" }}>{greeting}</p>
                <p style={{ fontSize: ".875rem", color: "#5b6b81", lineHeight: 1.6 }}>
                  I'm listening whenever you tap the orb — tell me what's happening in {ctx.householdName} and I'll take care of it.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: ".5rem", justifyContent: "center" }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="oziv-suggest" onClick={() => void runTurn(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}

            {turns.length > 0 && (
              <div className="oziv-transcript">
                {turns.map((t, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: ".375rem", alignItems: t.role === "user" ? "flex-end" : "flex-start" }}>
                    <div className={t.role === "user" ? "oziv-msg-user" : "oziv-msg-ai"}>{t.content}</div>
                    {t.actions && t.actions.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: ".375rem" }}>
                        {t.actions.map((a, j) => <span key={j} className="oziv-chip"><Check size={11} /> {a}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {showPrivacy && (
              <div className="oziv-panel">
                <h3><ShieldCheck size={16} /> Voice &amp; privacy</h3>
                <p>
                  The microphone records only between your taps — there is no always-on or wake-word listening.
                  Recordings are transcribed once, then discarded; OziUno never stores your voice. This conversation
                  lives only on this device and you can clear it below. Voice is never identity verification — your
                  own sign-in controls what you can do, and sensitive actions always ask you to confirm first.
                </p>
                <div className="oziv-row">
                  <span style={{ fontSize: ".875rem" }}>Read replies aloud</span>
                  <button type="button" className={`oziv-iconbtn${speakReplies ? " on" : ""}`} onClick={() => { if (speakReplies) voiceEngine.tts.stop(); setSpeakReplies(!speakReplies); }} aria-label={speakReplies ? "Turn spoken replies off" : "Turn spoken replies on"}>
                    {speakReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: ".5rem" }}>
                  <button type="button" className="oziv-textbtn" onClick={clearConversation}><Trash2 size={14} /> Clear this conversation</button>
                  <button type="button" className="oziv-textbtn danger" onClick={() => { clearConversation(); setEnabled(false); close(); }}><MicOff size={14} /> Turn voice assistant off</button>
                </div>
                <p style={{ fontSize: ".75rem", color: "#8595a9" }}>
                  Microphone permission itself is managed by your browser — look for the mic icon in the address bar or your browser's site settings.
                </p>
              </div>
            )}
          </div>

          <footer className="oziv-footer">
            <button type="button" className={`oziv-iconbtn${speakReplies ? " on" : ""}`} onClick={() => { if (speakReplies) voiceEngine.tts.stop(); setSpeakReplies(!speakReplies); }} aria-label={speakReplies ? "Mute spoken replies" : "Unmute spoken replies"} title={speakReplies ? "OziUno reads replies aloud — tap to mute" : "Tap to have OziUno read replies aloud"}>
              {speakReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <button type="button" className={`oziv-iconbtn${showPrivacy ? " on" : ""}`} onClick={() => setShowPrivacy((v) => !v)} aria-label="Voice and privacy settings" title="Voice & privacy">
              <Settings2 size={18} />
            </button>
          </footer>
        </div>
      )}
    </>
  );
}
