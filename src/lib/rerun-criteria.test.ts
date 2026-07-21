// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { RERUN_CRITERIA_KEY, toRerunCriteria } from "./rerun-criteria";
import { DEFAULT_AUCTION_SOURCES } from "./auction-sources";

describe("toRerunCriteria", () => {
  it("returns null for non-object inputs", () => {
    expect(toRerunCriteria(null)).toBeNull();
    expect(toRerunCriteria(undefined)).toBeNull();
    expect(toRerunCriteria("BMW")).toBeNull();
    expect(toRerunCriteria(42)).toBeNull();
  });

  it("returns null when make is missing or blank", () => {
    expect(toRerunCriteria({})).toBeNull();
    expect(toRerunCriteria({ make: "" })).toBeNull();
    expect(toRerunCriteria({ make: "   " })).toBeNull();
    expect(toRerunCriteria({ make: 123 })).toBeNull();
  });

  it("normalizes a minimal criteria object with defaults", () => {
    const out = toRerunCriteria({ make: "BMW" })!;
    expect(out.make).toBe("BMW");
    expect(out.model).toBeNull();
    expect(out.year_from).toBeNull();
    expect(out.year_to).toBeNull();
    expect(out.budget_usd).toBeNull();
    expect(out.max_odometer_mi).toBeNull();
    expect(out.fuel_type).toBeNull();
    expect(out.excluded_damage_types).toEqual([]);
    expect(out.max_results).toBe(15);
    expect(out.sources).toEqual(DEFAULT_AUCTION_SOURCES);
  });

  it("coerces numeric strings to numbers for year/budget/odometer", () => {
    const out = toRerunCriteria({
      make: "Audi",
      year_from: "2018",
      year_to: "2022",
      budget_usd: "25000",
      max_odometer_mi: "80000",
      max_results: "50",
    })!;
    expect(out.year_from).toBe(2018);
    expect(out.year_to).toBe(2022);
    expect(out.budget_usd).toBe(25000);
    expect(out.max_odometer_mi).toBe(80000);
    expect(out.max_results).toBe(50);
  });

  it("accepts only valid fuel_type values, else null", () => {
    expect(toRerunCriteria({ make: "BMW", fuel_type: "Gas" })!.fuel_type).toBe("Gas");
    expect(toRerunCriteria({ make: "BMW", fuel_type: "Hybrid" })!.fuel_type).toBe("Hybrid");
    expect(toRerunCriteria({ make: "BMW", fuel_type: "petrol" })!.fuel_type).toBeNull();
    expect(toRerunCriteria({ make: "BMW", fuel_type: 5 })!.fuel_type).toBeNull();
  });

  it("filters excluded_damage_types to non-empty strings", () => {
    const out = toRerunCriteria({
      make: "BMW",
      excluded_damage_types: ["FLOOD", "", "  FIRE", 42, null],
    })!;
    expect(out.excluded_damage_types).toEqual(["FLOOD", "  FIRE"]);
  });

  it("normalizes sources through auction-sources allow-list", () => {
    const out = toRerunCriteria({
      make: "BMW",
      sources: ["copart", "iaai", "copart", "junk"],
    })!;
    expect(out.sources).toEqual(["copart", "iaai"]);
  });

  it("falls back to default sources when list is missing or empty", () => {
    expect(toRerunCriteria({ make: "BMW" })!.sources).toEqual(DEFAULT_AUCTION_SOURCES);
    expect(toRerunCriteria({ make: "BMW", sources: [] })!.sources).toEqual([]);
  });

  it("round-trips through sessionStorage under RERUN_CRITERIA_KEY", () => {
    const raw = {
      make: "Audi",
      model: "A4",
      year_from: 2018,
      budget_usd: 25000,
      fuel_type: "Diesel",
      sources: ["copart"],
    };
    const normalized = toRerunCriteria(raw)!;
    sessionStorage.setItem(RERUN_CRITERIA_KEY, JSON.stringify(normalized));

    const readBack = sessionStorage.getItem(RERUN_CRITERIA_KEY);
    expect(readBack).not.toBeNull();
    const reparsed = toRerunCriteria(JSON.parse(readBack!))!;
    expect(reparsed).toEqual(normalized);
  });

  beforeEach(() => {
    sessionStorage.clear();
  });
});
