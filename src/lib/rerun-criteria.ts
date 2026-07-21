// Shared contract for handing a record's criteria to the search form on the
// home page without adding a query-param route contract. The RecordDetailView
// writes to sessionStorage under RERUN_CRITERIA_KEY, HomePage consumes and
// clears it on mount.

import type { ClientCriteria } from "@/lib/types";
import { normalizeAuctionSources } from "@/lib/auction-sources";

export const RERUN_CRITERIA_KEY = "car-auction-buddy:rerun-criteria";

type Fuel = ClientCriteria["fuel_type"];
const FUEL_VALUES: readonly string[] = ["Gas", "Hybrid", "Diesel", "Electric"];

function toStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}
function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function toStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/**
 * Coerce raw record criteria (any shape from the backend) into a validated
 * `ClientCriteria`. Returns null when `make` is missing/empty — callers use
 * this to disable the rerun buttons.
 */
export function toRerunCriteria(raw: unknown): ClientCriteria | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const make = toStr(r.make);
  if (!make) return null;
  const fuelRaw = toStr(r.fuel_type);
  const fuel_type: Fuel = fuelRaw && FUEL_VALUES.includes(fuelRaw) ? (fuelRaw as Fuel) : null;
  const maxResults = toNum(r.max_results);
  return {
    make,
    model: toStr(r.model) ?? null,
    year_from: toNum(r.year_from) ?? null,
    year_to: toNum(r.year_to) ?? null,
    budget_usd: toNum(r.budget_usd) ?? null,
    max_odometer_mi: toNum(r.max_odometer_mi) ?? null,
    fuel_type,
    excluded_damage_types: toStrArr(r.excluded_damage_types),
    max_results: maxResults ?? 15,
    sources: normalizeAuctionSources(Array.isArray(r.sources) ? (r.sources as string[]) : null),
  };
}
