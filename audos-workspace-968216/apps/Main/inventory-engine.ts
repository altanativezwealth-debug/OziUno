/* ---------------------------------------------------------------------------
 * OziUno Inventory Engine
 *
 * Deterministic, auditable household-inventory intelligence:
 *  - Controlled unit system + conversions (never AI-inferred)
 *  - Hardcoded default-unit taxonomy (Eggs → pcs, NEVER kg)
 *  - Ingredient name normalization (Egg/Eggs/Chicken eggs → eggs)
 *  - Inventory states: on_hand / committed / actual_consumed / projected
 *  - Transaction ledger: every quantity change is a hh_inventory_ledger row
 *    (opening_balance | purchase | consumption | waste_spoilage |
 *     manual_adjustment | return | donation | transfer)
 *  - Household-size meal scaling and the shopping-requirement formula
 *
 * CRITICAL PRINCIPLE: a planned meal is a FORECAST, not a consumption event.
 * Nothing in this module deducts inventory for a plan — only confirmed events
 * (consumption, waste, purchases, manual corrections) post transactions.
 * ------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */

const dbRoot = () => (window as any).__workspaceDb;
const ldb = (table: string) => dbRoot().from(table, { shared: true });

export const roundQty = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------- unit system ------------------------------ */

export type UnitKind = "count" | "weight" | "volume" | "other";

/** Canonical controlled units. Anything else is kept verbatim as "other". */
export const CANONICAL_UNITS: { unit: string; kind: UnitKind; aliases: string[] }[] = [
  { unit: "pcs", kind: "count", aliases: ["pc", "piece", "pieces", "unit", "units", "item", "items", "pcs."] },
  { unit: "dozen", kind: "count", aliases: ["dozens", "doz", "dz"] },
  { unit: "packs", kind: "count", aliases: ["pack", "packet", "packets", "sachet", "sachets"] },
  { unit: "boxes", kind: "count", aliases: ["box"] },
  { unit: "cartons", kind: "count", aliases: ["carton", "crate", "crates"] },
  { unit: "bottles", kind: "count", aliases: ["bottle", "btl"] },
  { unit: "cans", kind: "count", aliases: ["can", "tin", "tins"] },
  { unit: "jars", kind: "count", aliases: ["jar"] },
  { unit: "tubes", kind: "count", aliases: ["tube"] },
  { unit: "loaves", kind: "count", aliases: ["loaf"] },
  { unit: "rolls", kind: "count", aliases: ["roll"] },
  { unit: "bars", kind: "count", aliases: ["bar"] },
  { unit: "bags", kind: "count", aliases: ["bag"] },
  { unit: "bunches", kind: "count", aliases: ["bunch"] },
  { unit: "mg", kind: "weight", aliases: ["milligram", "milligrams"] },
  { unit: "g", kind: "weight", aliases: ["gram", "grams", "gramme", "grammes", "gr"] },
  { unit: "kg", kind: "weight", aliases: ["kilo", "kilos", "kilogram", "kilograms", "kgs"] },
  { unit: "ml", kind: "volume", aliases: ["milliliter", "milliliters", "millilitre", "millilitres", "mls", "cl"] },
  { unit: "L", kind: "volume", aliases: ["l", "litre", "litres", "liter", "liters", "ltr", "ltrs"] },
];

const UNIT_LOOKUP: Map<string, { unit: string; kind: UnitKind }> = (() => {
  const m = new Map<string, { unit: string; kind: UnitKind }>();
  for (const def of CANONICAL_UNITS) {
    m.set(def.unit.toLowerCase(), { unit: def.unit, kind: def.kind });
    for (const a of def.aliases) m.set(a.toLowerCase(), { unit: def.unit, kind: def.kind });
  }
  return m;
})();

/** Normalize any free-text unit to its canonical form ("Litres" → "L",
 * "pieces" → "pcs"). Unknown units come back lowercased but otherwise kept —
 * legacy data is never destroyed. */
export function normalizeUnit(raw: unknown): string {
  const k = String(raw ?? "").trim().toLowerCase();
  if (!k) return "pcs";
  const hit = UNIT_LOOKUP.get(k);
  return hit ? hit.unit : k;
}

export function unitKind(unit: unknown): UnitKind {
  const hit = UNIT_LOOKUP.get(String(unit ?? "").trim().toLowerCase());
  return hit ? hit.kind : "other";
}

/** Conversion factors into each kind's base unit (pcs / g / ml). */
const TO_BASE: Record<string, { base: "pcs" | "g" | "ml"; factor: number }> = {
  pcs: { base: "pcs", factor: 1 },
  dozen: { base: "pcs", factor: 12 },
  mg: { base: "g", factor: 0.001 },
  g: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  ml: { base: "ml", factor: 1 },
  L: { base: "ml", factor: 1000 },
};

/**
 * Convert a quantity between units. Returns null when the conversion is
 * impossible (different kinds, or package-style count units with no shared
 * base) — callers must handle null, NEVER assume 1:1.
 * Supported: 1 dozen = 12 pcs, 1 kg = 1000 g, 1 L = 1000 ml (+ mg).
 */
export function convertUnits(qty: number, fromUnit: unknown, toUnit: unknown): number | null {
  const f = normalizeUnit(fromUnit);
  const t = normalizeUnit(toUnit);
  if (f === t) return qty;
  const ff = TO_BASE[f];
  const tt = TO_BASE[t];
  if (!ff || !tt || ff.base !== tt.base) return null;
  return (qty * ff.factor) / tt.factor;
}

/* -------------------------- default-unit taxonomy ------------------------- */

interface TaxonomyEntry {
  key: string;               // canonical ingredient key
  re: RegExp;                // matches the item name
  unit: string;              // hardcoded default unit
  allowedKinds: UnitKind[];  // unit kinds that are plausible for this item
  shelfLifeDays?: number;    // typical shelf life once opened/cooked
}

/**
 * HARDCODED item taxonomy — the single source of default units. AI output is
 * never allowed to override these kinds (Eggs are pcs, never kg).
 */
export const ITEM_TAXONOMY: TaxonomyEntry[] = [
  { key: "eggs", re: /\beggs?\b/i, unit: "pcs", allowedKinds: ["count"], shelfLifeDays: 21 },
  { key: "bread", re: /\bbread\b/i, unit: "loaves", allowedKinds: ["count"], shelfLifeDays: 4 },
  { key: "milk", re: /\bmilk\b/i, unit: "L", allowedKinds: ["volume", "count"], shelfLifeDays: 5 },
  { key: "rice", re: /\brice\b/i, unit: "kg", allowedKinds: ["weight", "count"] },
  { key: "beans", re: /\bbeans?\b/i, unit: "kg", allowedKinds: ["weight", "count"] },
  { key: "garri", re: /\bgar+i\b/i, unit: "kg", allowedKinds: ["weight", "count"] },
  { key: "chicken", re: /\bchicken\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 2 },
  { key: "meat", re: /\b(meat|beef|goat|pork|mutton|suya)\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 2 },
  { key: "fish", re: /\b(fish|tilapia|mackerel|sardine|titus|croaker|snapper)\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 2 },
  { key: "tomatoes", re: /\btomato(es)?\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 5 },
  { key: "onions", re: /\bonions?\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 14 },
  { key: "potatoes", re: /\bpotato(es)?\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 14 },
  { key: "pepper", re: /\bpeppers?\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 7 },
  { key: "cooking oil", re: /\b(cooking|vegetable|palm|groundnut|sunflower|olive)\s*oil\b/i, unit: "L", allowedKinds: ["volume", "count"] },
  { key: "salt", re: /\bsalt\b/i, unit: "g", allowedKinds: ["weight", "count"] },
  { key: "sugar", re: /\bsugar\b/i, unit: "kg", allowedKinds: ["weight", "count"] },
  { key: "butter", re: /\b(butter|margarine)\b/i, unit: "g", allowedKinds: ["weight", "count"], shelfLifeDays: 30 },
  { key: "flour", re: /\bflour\b/i, unit: "kg", allowedKinds: ["weight", "count"] },
  { key: "toothpaste", re: /\btooth\s*paste\b/i, unit: "tubes", allowedKinds: ["count"] },
  { key: "soap", re: /\bsoap\b/i, unit: "bars", allowedKinds: ["count"] },
  { key: "toilet paper", re: /\b(toilet\s*(paper|roll|tissue)|tissue)\b/i, unit: "rolls", allowedKinds: ["count"] },
  { key: "detergent", re: /\b(detergent|washing\s*powder)\b/i, unit: "kg", allowedKinds: ["weight", "volume", "count"] },
  { key: "water", re: /\bwater\b/i, unit: "L", allowedKinds: ["volume", "count"] },
  { key: "vegetables", re: /\b(vegetables?|spinach|ugu|greens|lettuce|cabbage|okro|okra)\b/i, unit: "kg", allowedKinds: ["weight", "count"], shelfLifeDays: 4 },
];

export function taxonomyFor(name: unknown): TaxonomyEntry | null {
  const n = String(name ?? "").toLowerCase();
  for (const t of ITEM_TAXONOMY) if (t.re.test(n)) return t;
  return null;
}

/** Explicit synonym resolutions — merges spelling/plural variations of the
 * SAME product; genuinely different products are never merged. */
const NAME_SYNONYMS: Record<string, string> = {
  egg: "eggs", "chicken egg": "eggs", "chicken eggs": "eggs", "fresh egg": "eggs", "fresh eggs": "eggs",
  tomato: "tomatoes", onion: "onions", potato: "potatoes", "irish potato": "potatoes", "irish potatoes": "potatoes",
  pepper: "pepper", peppers: "pepper",
  "toilet roll": "toilet paper", "toilet rolls": "toilet paper", "toilet tissue": "toilet paper",
  "washing powder": "detergent",
  gari: "garri",
};

const DESCRIPTOR_WORDS = /\b(fresh|raw|dried|frozen|organic|whole|large|small|big|new)\b/gi;

/** Normalized matching key for an ingredient/item name. Conservative: known
 * synonyms and descriptor stripping only — different products stay distinct. */
export function ingredientKeyOf(name: unknown): string {
  let n = String(name ?? "").toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(DESCRIPTOR_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) return "";
  if (NAME_SYNONYMS[n]) return NAME_SYNONYMS[n];
  const tax = taxonomyFor(n);
  // Taxonomy key only when the name IS essentially that item (e.g. "eggs"),
  // not a compound product ("egg noodles" keeps its own key).
  if (tax && (n === tax.key || n.replace(/s$/, "") === tax.key.replace(/s$/, ""))) return tax.key;
  if (NAME_SYNONYMS[n.replace(/s$/, "")]) return NAME_SYNONYMS[n.replace(/s$/, "")];
  return n;
}

export interface IngredientPref {
  ingredient_key?: string; preferred_unit?: string | null;
  package_name?: string | null; package_size?: number | string | null; package_unit?: string | null;
}

/** Default unit for an item: household preference → hardcoded taxonomy →
 * null (caller decides; NEVER guessed by AI). */
export function defaultUnitFor(name: unknown, prefs?: IngredientPref[] | null): string | null {
  const key = ingredientKeyOf(name);
  const pref = (prefs ?? []).find((p) => String(p.ingredient_key || "") === key && p.preferred_unit);
  if (pref) return normalizeUnit(pref.preferred_unit);
  const tax = taxonomyFor(name);
  return tax ? tax.unit : null;
}

/** Does the stored unit contradict the taxonomy (e.g. Eggs in kg)? Used to
 * FLAG records for review — never to silently rewrite them. */
export function unitConflictsWithTaxonomy(name: unknown, unit: unknown): boolean {
  const tax = taxonomyFor(name);
  if (!tax) return false;
  const kind = unitKind(unit);
  if (kind === "other") return false; // unknown units are not judged
  return !tax.allowedKinds.includes(kind);
}

/**
 * Normalize a quantity+unit pair on entry: "2 dozen" → 24 pcs (package memory
 * kept: dozen = 12 pcs). Returns the normalized amount plus package details
 * when a package conversion was applied.
 */
export function normalizeQuantityInput(qty: number, unit: unknown, name?: unknown): {
  qty: number; unit: string;
  package_name?: string; package_size?: number; package_unit?: string;
} {
  const u = normalizeUnit(unit);
  if (u === "dozen") {
    return { qty: roundQty(qty * 12), unit: "pcs", package_name: "dozen", package_size: 12, package_unit: "pcs" };
  }
  if (!UNIT_LOOKUP.has(u)) {
    // Unknown free-text unit: fall back to the taxonomy default when the item
    // is known (e.g. "Eggs" with unit "unit" → pcs). High-confidence only.
    const def = name != null ? defaultUnitFor(name) : null;
    if (def && (u === "unit" || u === "")) return { qty, unit: def };
  }
  return { qty, unit: u };
}

/* ------------------------- package-aware quantities ------------------------ */

export interface InvItemLike {
  id?: number | string; name?: unknown; unit?: unknown; quantity?: unknown;
  package_size?: unknown; package_unit?: unknown; package_name?: unknown;
  min_stock_level?: unknown; expires_at?: unknown; best_before_date?: unknown;
  ingredient_key?: unknown; status?: unknown;
}

/** Package expansion is only REAL when the package is measured in a
 * DIFFERENT unit from the item's own stock unit ("2 bags" × 5 kg = 10 kg).
 * When they match — e.g. "2 dozen" eggs saved as 24 pcs with the dozen
 * (= 12 pcs) remembered as the preferred package — the stock quantity is
 * already in base units and expanding it again would multiply stock and
 * divide deductions (24 pcs shown as 288 pcs; a 6-pcs meal deducting 0.5). */
export function packageExpansion(item: InvItemLike): { size: number; unit: string } | null {
  const size = Number(item.package_size) || 0;
  const pUnit = String(item.package_unit || "");
  if (!(size > 0) || !pUnit) return null;
  if (normalizeUnit(pUnit) === normalizeUnit(item.unit)) return null;
  return { size, unit: pUnit };
}

/** An item's stock expressed in its BASE unit: packages expand via their
 * explicit per-product size (2 bags × 5 kg = 10 kg). Nothing is assumed
 * globally — no package_size, no expansion. */
export function toBaseQty(item: InvItemLike): { qty: number; unit: string } {
  const qty = Number(item.quantity) || 0;
  const pkg = packageExpansion(item);
  if (pkg) return { qty: roundQty(qty * pkg.size), unit: normalizeUnit(pkg.unit) };
  return { qty, unit: normalizeUnit(item.unit) };
}

/** Express an amount (any convertible unit) in the item's OWN stored unit
 * (packages included: 750 g against a 5 kg bag = 0.15 bags). Null when the
 * conversion is impossible. */
export function amountInItemUnit(item: InvItemLike, qty: number, unit: unknown): number | null {
  const pkg = packageExpansion(item);
  if (pkg) {
    const inPkgUnit = convertUnits(qty, unit, pkg.unit);
    if (inPkgUnit == null) return null;
    return inPkgUnit / pkg.size;
  }
  return convertUnits(qty, unit, String(item.unit || ""));
}

/* ------------------------------ ledger + states ---------------------------- */

export type TxnType =
  | "opening_balance" | "purchase" | "consumption" | "waste_spoilage"
  | "manual_adjustment" | "return" | "donation" | "transfer";

export const DEDUCTIVE_TYPES: TxnType[] = ["consumption", "waste_spoilage", "donation", "transfer"];

export const TXN_LABELS: Record<TxnType, string> = {
  opening_balance: "Opening balance", purchase: "Purchase", consumption: "Consumption",
  waste_spoilage: "Waste / spoilage", manual_adjustment: "Manual adjustment",
  return: "Return", donation: "Donation", transfer: "Transfer",
};

/** Legacy status field kept in sync for older UI/hooks: ok | warn | empty. */
export function legacyStatus(onHand: number, minStock: number): "ok" | "warn" | "empty" {
  if (onHand <= 0) return "empty";
  if (minStock > 0 ? onHand <= minStock : onHand <= 1) return "warn";
  return "ok";
}

/**
 * Post ONE inventory transaction: converts the delta into the item's own
 * unit, clamps the resulting balance at zero (negative inventory is refused
 * unless explicitly allowed), updates the item row, and writes the ledger
 * row. Inventory quantity is NEVER changed anywhere without this ledger row.
 *
 * `delta` is SIGNED in `unit` (or the item's unit when omitted):
 * + adds stock (purchase, return, opening additions, upward corrections),
 * − removes stock (consumption, waste, donation, downward corrections).
 */
export async function postTxn(
  hid: number,
  item: Record<string, unknown>,
  opts: {
    type: TxnType; delta: number; unit?: string; mealPlanId?: number | null;
    reason?: string; createdBy?: string; allowNegative?: boolean;
    extraItemPatch?: Record<string, unknown>;
  },
): Promise<{ ok: boolean; newQty: number; applied: number; error?: string }> {
  const cur = Number(item.quantity) || 0;
  let deltaInItemUnit: number | null = opts.delta;
  if (opts.unit) {
    deltaInItemUnit = amountInItemUnit(item as InvItemLike, opts.delta, opts.unit);
    if (deltaInItemUnit == null) {
      return { ok: false, newQty: cur, applied: 0, error: `Cannot convert ${opts.unit} to ${String(item.unit)}` };
    }
  }
  let applied = roundQty(deltaInItemUnit);
  let newQty = roundQty(cur + applied);
  if (newQty < 0 && !opts.allowNegative) {
    applied = roundQty(-cur); // cap the deduction at what is actually there
    newQty = 0;
  }
  const min = Number(item.min_stock_level) || 0;
  if (applied !== 0 || opts.type === "manual_adjustment") {
    await ldb("hh_inventory_items").update(Number(item.id), {
      quantity: newQty,
      status: legacyStatus(newQty, min),
      ...(opts.extraItemPatch || {}),
    });
  }
  await ldb("hh_inventory_ledger").insert({
    household_id: hid, item_id: Number(item.id), item_name: String(item.name || ""),
    txn_type: opts.type, qty_delta: applied, unit: String(item.unit || ""),
    balance_after: newQty, meal_plan_id: opts.mealPlanId ?? null,
    reason: opts.reason || null, created_by: opts.createdBy || null,
    occurred_at: new Date().toISOString(),
  });
  return { ok: true, newQty, applied };
}

/** Record opening balances once per item: every inventory item that has no
 * ledger rows yet gets an opening_balance entry equal to its current stock.
 * Pure bookkeeping — quantities are NOT changed, existing data is preserved. */
export async function recordOpeningBalances(hid: number): Promise<number> {
  const [invRes, ledRes] = await Promise.all([
    ldb("hh_inventory_items").eq("household_id", hid).limit(1000).get(),
    ldb("hh_inventory_ledger").eq("household_id", hid).limit(1000).get(),
  ]);
  const covered = new Set((ledRes.data ?? []).map((l: Record<string, unknown>) => Number(l.item_id)));
  const pending = (invRes.data ?? []).filter((i: Record<string, unknown>) => !covered.has(Number(i.id)));
  if (!pending.length) return 0;
  const rows = pending.map((i: Record<string, unknown>) => ({
    household_id: hid, item_id: Number(i.id), item_name: String(i.name || ""),
    txn_type: "opening_balance", qty_delta: Number(i.quantity) || 0, unit: String(i.unit || ""),
    balance_after: Number(i.quantity) || 0, meal_plan_id: null,
    reason: "Opening balance (stock recorded before the ledger existed)",
    created_by: "OziUno", occurred_at: new Date().toISOString(),
  }));
  await ldb("hh_inventory_ledger").bulkInsert(rows);
  return rows.length;
}

/* --------------------------- item state computation ------------------------ */

export type InvState = "sufficient" | "running_low" | "out_of_stock" | "planned_shortage" | "expiring_soon";

export const INV_STATE_LABELS: Record<InvState, string> = {
  sufficient: "Sufficient", running_low: "Running low", out_of_stock: "Out of stock",
  planned_shortage: "Planned shortage", expiring_soon: "Expiring soon",
};

export interface ItemStates {
  onHand: number; committed: number; projected: number; minStock: number;
  unit: string; state: InvState; expiringDays: number | null;
}

const dayDiff = (from: Date, to: Date): number => {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86400000);
};

/**
 * The five UI-facing values per item. `committed` is the total of UNCONFIRMED
 * meal-plan requirements mapped to this item — it is NEVER deducted from
 * on-hand until the meal is confirmed eaten.
 *
 * State rules (Section 10/14):
 *  out_of_stock      on_hand = 0
 *  expiring_soon     expiry within 3 days (stock present)
 *  planned_shortage  on_hand > 0 but committed > on_hand
 *  running_low       projected < minimum stock (projected > 0 shortfall path)
 *  sufficient        projected >= minimum stock
 * An item is never "out of stock" merely because it appears in a meal plan.
 */
export function computeItemStates(item: InvItemLike, committedQty: number, now = new Date()): ItemStates {
  const onHand = Number(item.quantity) || 0;
  const committed = roundQty(Math.max(0, committedQty));
  const projected = roundQty(onHand - committed);
  const minStock = Number(item.min_stock_level) || 0;
  const unit = String(item.unit || "pcs");
  let expiringDays: number | null = null;
  const expiry = item.expires_at || item.best_before_date;
  if (expiry) {
    const d = new Date(String(expiry));
    if (!Number.isNaN(d.getTime())) expiringDays = dayDiff(now, d);
  }
  let state: InvState;
  if (onHand <= 0) state = "out_of_stock";
  else if (expiringDays !== null && expiringDays <= 3) state = "expiring_soon";
  else if (committed > onHand) state = "planned_shortage";
  else if (minStock > 0 && projected < minStock) state = "running_low";
  else state = "sufficient";
  return { onHand, committed, projected, minStock, unit, state, expiringDays };
}

/** Sum of unconfirmed committed requirements per matched inventory item, in
 * each item's own unit. Cancelled/consumed ingredients never count. */
export function committedByItem(mealIngredients: Record<string, unknown>[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const ing of mealIngredients) {
    if (String(ing.status || "committed") !== "committed") continue;
    if (ing.optional === true) continue;
    const itemId = Number(ing.matched_item_id);
    const q = Number(ing.required_qty) || 0;
    if (!(itemId > 0) || q <= 0) continue;
    m.set(itemId, roundQty((m.get(itemId) || 0) + q));
  }
  return m;
}

/* ------------------------- household meal scaling -------------------------- */

/** Children count as a configurable fraction of an adult serving. */
export const CHILD_SERVING_FACTOR = 0.5;
export const DEFAULT_RECIPE_YIELD = 4;

export function householdServings(adults: number, children: number, childFactor = CHILD_SERVING_FACTOR): number {
  const a = Math.max(0, Number(adults) || 0);
  const c = Math.max(0, Number(children) || 0);
  const s = a + c * childFactor;
  return s > 0 ? roundQty(s) : 1;
}

/** Required amount = ingredient_quantity × (household servings / recipe yield). */
export function scaleIngredientQty(qty: number, recipeYield: number, servings: number): number {
  const y = Number(recipeYield) > 0 ? Number(recipeYield) : DEFAULT_RECIPE_YIELD;
  const s = Number(servings) > 0 ? Number(servings) : y;
  return roundQty((Number(qty) || 0) * (s / y));
}

/* ------------------------ shopping list calculation ------------------------ */

/**
 * Net shopping requirement (Section 9):
 *   requirement = planned + desired minimum stock − on hand − confirmed incoming
 * (Available inventory = on hand − commitments, so this is equivalently
 *  minStock − (projected − incoming).) Never negative.
 */
export function shoppingRequirement(opts: { onHand: number; committed: number; minStock: number; incoming?: number }): number {
  const need = (opts.committed || 0) + (opts.minStock || 0) - (opts.onHand || 0) - (opts.incoming || 0);
  return Math.max(0, roundQty(need));
}

/** Round a requirement UP into the household's preferred package when one is
 * known and convertible ("4 pcs eggs, prefers dozens" → 1 dozen = 12 pcs). */
export function recommendPackage(
  qty: number, unit: string,
  pkg?: { package_name?: string | null; package_size?: number | string | null; package_unit?: string | null } | null,
): { qty: number; unit: string; label: string } {
  const plain = { qty: roundQty(qty), unit, label: `${roundQty(qty)} ${unit}` };
  if (!pkg || !pkg.package_name || !(Number(pkg.package_size) > 0) || !pkg.package_unit) return plain;
  const inPkgUnit = convertUnits(qty, unit, String(pkg.package_unit));
  if (inPkgUnit == null) return plain;
  const n = Math.max(1, Math.ceil(roundQty(inPkgUnit / Number(pkg.package_size))));
  const total = roundQty(n * Number(pkg.package_size));
  return {
    qty: total, unit: normalizeUnit(pkg.package_unit),
    label: `${n} ${String(pkg.package_name)}${n === 1 ? "" : "s"} (${total} ${normalizeUnit(pkg.package_unit)})`,
  };
}

/** Plain-English reason string every auto-generated shopping line must carry. */
export function shoppingReason(opts: {
  name: string; unit: string; onHand: number; committed: number; minStock: number; requirement: number;
}): string {
  const bits: string[] = [];
  if (opts.committed > 0) bits.push(`your planned meals this week need ${roundQty(opts.committed)} ${opts.unit}`);
  bits.push(`you have ${roundQty(Math.max(0, opts.onHand))} ${opts.unit} on hand`);
  if (opts.minStock > 0) bits.push(`you like to keep at least ${roundQty(opts.minStock)} ${opts.unit} in stock`);
  const lead = bits.join(", ").replace(/^./, (c) => c.toUpperCase());
  return `${lead}. OziUno recommends buying ${roundQty(opts.requirement)} ${opts.unit}.`;
}

/* --------------------------- consumption history --------------------------- */

export interface UsageRow { item_name?: unknown; item_key?: string; qty_used: number; unit?: unknown; at: number }

/** Map ledger rows to positive usage rows (consumption only). */
export function ledgerToUsage(ledger: Record<string, unknown>[]): UsageRow[] {
  const out: UsageRow[] = [];
  for (const l of ledger) {
    if (String(l.txn_type) !== "consumption") continue;
    const q = -(Number(l.qty_delta) || 0);
    if (q <= 0) continue;
    const t = new Date(String(l.occurred_at || l.created_at || "")).getTime();
    out.push({ item_name: l.item_name, item_key: ingredientKeyOf(l.item_name), qty_used: q, unit: l.unit, at: Number.isFinite(t) ? t : Date.now() });
  }
  return out;
}

/** Weekly consumption per ingredient over a window (default 4 weeks):
 * average per week + weeks of stock remaining at that pace (an ESTIMATE). */
export function weeklyConsumption(usage: UsageRow[], windowDays = 28): Map<string, { name: string; unit: string; perWeek: number }> {
  const cutoff = Date.now() - windowDays * 86400000;
  const byKey = new Map<string, { name: string; unit: string; total: number; first: number }>();
  for (const u of usage) {
    if (u.at < cutoff) continue;
    const key = u.item_key || ingredientKeyOf(u.item_name);
    if (!key) continue;
    const cur = byKey.get(key) || { name: String(u.item_name || key), unit: normalizeUnit(u.unit), total: 0, first: u.at };
    cur.total += u.qty_used;
    if (u.at < cur.first) cur.first = u.at;
    byKey.set(key, cur);
  }
  const out = new Map<string, { name: string; unit: string; perWeek: number }>();
  for (const [key, v] of byKey) {
    const spanDays = Math.min(windowDays, Math.max(7, (Date.now() - v.first) / 86400000));
    out.set(key, { name: v.name, unit: v.unit, perWeek: roundQty(v.total / (spanDays / 7)) });
  }
  return out;
}

export function estimateWeeksRemaining(onHand: number, perWeek: number): number | null {
  if (!(perWeek > 0)) return null;
  return Math.round((onHand / perWeek) * 10) / 10;
}

/* ------------------------------- leftovers -------------------------------- */

export const LEFTOVER_USE_BY_DAYS = 3;

export function leftoverUseBy(storedOn = new Date()): string {
  const d = new Date(storedOn.getTime() + LEFTOVER_USE_BY_DAYS * 86400000);
  return d.toISOString().slice(0, 10);
}

/* ------------------------- AI-output sanitization -------------------------- */

/**
 * Sanitize ONE AI-proposed recipe ingredient into the controlled model. The
 * AI may only PROPOSE names and rough quantities — units are forced through
 * the hardcoded taxonomy/preferences (never AI-decided when they conflict),
 * dozen inputs normalize to pcs, and unparseable rows are dropped.
 */
export function sanitizeIngredient(
  raw: { name?: unknown; quantity?: unknown; unit?: unknown; optional?: unknown; preparation_state?: unknown },
  prefs?: IngredientPref[] | null,
): { name: string; ingredient_key: string; quantity: number; unit: string; optional: boolean; preparation_state: string | null } | null {
  const name = String(raw.name ?? "").trim();
  const qty = Number(raw.quantity);
  if (!name || !(qty > 0)) return null;
  let unit = normalizeUnit(raw.unit);
  let quantity = qty;
  if (unit === "dozen") { quantity = qty * 12; unit = "pcs"; }
  const def = defaultUnitFor(name, prefs);
  if (def) {
    if (unitKind(unit) === "other") {
      unit = def; // unknown/free-text unit from AI → hardcoded default
    } else if (unitConflictsWithTaxonomy(name, unit)) {
      // Wrong KIND entirely (eggs in kg): the taxonomy wins; treat the number
      // as being in the default unit rather than invent a conversion.
      unit = def;
    }
  } else if (unitKind(unit) === "other") {
    unit = "pcs";
  }
  return {
    name, ingredient_key: ingredientKeyOf(name), quantity: roundQty(quantity), unit,
    optional: raw.optional === true, preparation_state: raw.preparation_state ? String(raw.preparation_state) : null,
  };
}

/** Match an ingredient to the household's inventory: ingredient_key first,
 * then exact normalized name. Food (pantry) items only. */
export function matchInventoryItem(items: Record<string, unknown>[], name: unknown): Record<string, unknown> | null {
  const key = ingredientKeyOf(name);
  if (!key) return null;
  return (
    items.find((i) => String(i.ingredient_key || "") === key) ||
    items.find((i) => ingredientKeyOf(i.name) === key) ||
    null
  );
}

/* ------------------------ meal outcome confirmation ------------------------ */

export type MealOutcome =
  | { kind: "yes" }
  | { kind: "no" }
  | {
      kind: "partial";
      /** Fraction of the planned meal actually eaten (0–1). */
      fraction: number;
      /** Optional explicit consumed qty per ingredient id (in required_unit) — overrides the fraction. */
      consumedByIngredient?: Record<number, number>;
      /** Leftovers to record ("Cooked rice", 500 g). */
      leftovers?: { name: string; qty: number; unit: string }[];
    }
  | {
      kind: "different";
      replacementTitle: string;
      /** Sanitized + scaled ingredients of the dish actually eaten. */
      ingredients: { name: string; ingredient_key: string; required_qty: number; unit: string }[];
    };

/**
 * Convert planned consumption → actual consumption (Section 11). This is the
 * ONLY path from a meal plan to the inventory ledger:
 *  - yes       → consumption transactions for every committed ingredient
 *  - no        → nothing deducted; commitments released (cancelled)
 *  - partial   → partial consumption transactions + optional leftover records
 *  - different → commitments released; the ACTUAL dish's ingredients consumed
 * Deductions are capped at on-hand (ledger never drives stock below zero).
 */
export async function confirmMealOutcome(
  hid: number,
  meal: Record<string, unknown>,
  ingredients: Record<string, unknown>[],
  invItems: Record<string, unknown>[],
  outcome: MealOutcome,
  memberName: string,
): Promise<{ consumed: string[]; leftovers: string[] }> {
  const mid = Number(meal.id);
  const title = String(meal.title || "meal");
  const consumedNotes: string[] = [];
  const leftoverNotes: string[] = [];
  const committed = ingredients.filter((i) => String(i.status || "committed") === "committed");
  const itemById = new Map(invItems.map((i) => [Number(i.id), i]));

  const consumeIngredient = async (ing: Record<string, unknown>, qty: number) => {
    const q = roundQty(qty);
    const unit = String(ing.required_unit || ing.unit || "pcs");
    const item = itemById.get(Number(ing.matched_item_id));
    if (item && q > 0) {
      const res = await postTxn(hid, item, {
        type: "consumption", delta: -q, unit,
        mealPlanId: mid, reason: `Confirmed: ${title} (${String(meal.meal || "meal")})`, createdBy: memberName,
      });
      if (res.ok && res.applied !== 0) {
        (item as Record<string, unknown>).quantity = res.newQty; // keep local copy current across ingredients
        consumedNotes.push(`${String(item.name)} −${Math.abs(res.applied)} ${String(item.unit || "")}`.trim());
      }
    }
    await ldb("hh_meal_ingredients").update(Number(ing.id), { status: q > 0 ? "consumed" : "cancelled", consumed_qty: q });
  };

  if (outcome.kind === "yes") {
    for (const ing of committed) await consumeIngredient(ing, Number(ing.required_qty) || 0);
    await ldb("hh_meal_plans").update(mid, { status: "consumed", consumed_at: new Date().toISOString(), confirmed_by: memberName });
  } else if (outcome.kind === "no") {
    for (const ing of committed) {
      await ldb("hh_meal_ingredients").update(Number(ing.id), { status: "cancelled" });
    }
    await ldb("hh_meal_plans").update(mid, { status: "skipped", consumed_at: new Date().toISOString(), confirmed_by: memberName });
  } else if (outcome.kind === "partial") {
    const f = Math.min(1, Math.max(0, Number(outcome.fraction) || 0));
    for (const ing of committed) {
      const explicit = outcome.consumedByIngredient?.[Number(ing.id)];
      const q = explicit != null ? Number(explicit) : (Number(ing.required_qty) || 0) * f;
      await consumeIngredient(ing, q);
      if (explicit == null || q < (Number(ing.required_qty) || 0)) {
        await ldb("hh_meal_ingredients").update(Number(ing.id), { status: "partial", consumed_qty: roundQty(q) });
      }
    }
    for (const lo of outcome.leftovers ?? []) {
      if (!(Number(lo.qty) > 0)) continue;
      await ldb("hh_leftovers").insert({
        household_id: hid, name: lo.name, source_meal_plan_id: mid, meal_title: title,
        qty: roundQty(Number(lo.qty)), unit: normalizeUnit(lo.unit),
        stored_on: new Date().toISOString().slice(0, 10), use_by: leftoverUseBy(), status: "available",
        notes: `Leftover from ${title}`,
      });
      leftoverNotes.push(`${roundQty(Number(lo.qty))} ${normalizeUnit(lo.unit)} ${lo.name}`);
    }
    await ldb("hh_meal_plans").update(mid, { status: "partial", consumed_at: new Date().toISOString(), confirmed_by: memberName });
  } else {
    // different meal: release the original commitments, consume the real dish.
    for (const ing of committed) {
      await ldb("hh_meal_ingredients").update(Number(ing.id), { status: "cancelled" });
    }
    for (const ing of outcome.ingredients) {
      const item = matchInventoryItem(invItems, ing.name);
      const inserted: Record<string, unknown> = {
        household_id: hid, meal_plan_id: mid, name: ing.name, ingredient_key: ing.ingredient_key,
        quantity: ing.required_qty, unit: ing.unit, recipe_yield: null,
        required_qty: ing.required_qty, required_unit: ing.unit,
        matched_item_id: item ? Number(item.id) : null, status: "consumed", consumed_qty: ing.required_qty,
      };
      await ldb("hh_meal_ingredients").insert(inserted);
      if (item && ing.required_qty > 0) {
        const res = await postTxn(hid, item, {
          type: "consumption", delta: -ing.required_qty, unit: ing.unit,
          mealPlanId: mid, reason: `Confirmed: ${outcome.replacementTitle} (instead of ${title})`, createdBy: memberName,
        });
        if (res.ok && res.applied !== 0) {
          (item as Record<string, unknown>).quantity = res.newQty;
          consumedNotes.push(`${String(item.name)} −${Math.abs(res.applied)} ${String(item.unit || "")}`.trim());
        }
      }
    }
    await ldb("hh_meal_plans").update(mid, {
      status: "consumed", consumed_at: new Date().toISOString(), confirmed_by: memberName,
      replaced_with: outcome.replacementTitle,
    });
  }
  return { consumed: consumedNotes, leftovers: leftoverNotes };
}

/** Record spoiled/wasted stock as a distinct waste_spoilage transaction —
 * never a silent quantity edit. Feeds WasteLess analytics. */
export async function recordWaste(
  hid: number, item: Record<string, unknown>, qty: number, unit: string, reason: string, memberName: string,
): Promise<{ ok: boolean; newQty: number; applied: number; error?: string }> {
  return postTxn(hid, item, {
    type: "waste_spoilage", delta: -Math.abs(qty), unit,
    reason: reason || "Spoiled / wasted", createdBy: memberName,
  });
}

/* --------------------------- migration helpers ----------------------------- */

/**
 * High-confidence unit inference for a legacy row. Only rows whose unit is
 * the meaningless placeholder ("unit", empty) AND whose name maps to the
 * hardcoded taxonomy get an inferred unit. Anything else — including a real
 * but WRONG-looking unit (eggs in kg) — is only FLAGGED for member review
 * (unit_review = true); OziUno never silently rewrites user data.
 */
export function inferLegacyUnit(item: InvItemLike): { unit?: string; flag: boolean } {
  const cur = String(item.unit || "").trim().toLowerCase();
  const isPlaceholder = !cur || cur === "unit" || cur === "units" || cur === "n/a";
  const tax = taxonomyFor(item.name);
  if (isPlaceholder) {
    if (tax) return { unit: tax.unit, flag: false };
    return { flag: false }; // no confident guess — leave as-is, don't flag noise
  }
  if (unitConflictsWithTaxonomy(item.name, cur)) return { flag: true };
  return { flag: false };
}
