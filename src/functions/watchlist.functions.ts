import { createServerFn } from "@tanstack/react-start";
import { siteSessionMiddleware } from "@/functions/site-session-middleware.functions";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertNoDbError, safeHandler } from "@/lib/errors";

const WatchlistInput = z.object({
  client_id: z.string().uuid().optional().nullable(),
  source: z.string().max(64).optional().nullable(),
  lot_id: z.string().max(128).optional().nullable(),
  url: z.string().max(2000).optional().nullable(),
  title: z.string().max(500).optional().nullable(),
  make: z.string().max(120).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  vin: z.string().max(32).optional().nullable(),
  current_bid_usd: z.number().nonnegative().optional().nullable(),
  buy_now_usd: z.number().nonnegative().optional().nullable(),
  score: z.number().optional().nullable(),
  category: z.string().max(64).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  snapshot: z.any().optional(),
});

type UnknownRecord = Record<string, unknown>;

function asUnknownRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export const listWatchlist = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .handler(async () =>
    safeHandler("Nie udało się pobrać watchlisty", async () => {
      const { data, error } = await supabaseAdmin
        .from("watchlist")
        .select("*")
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(500);
      assertNoDbError(error, "Watchlist");
      return data ?? [];
    }),
  );

export const addToWatchlist = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(WatchlistInput.parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się dodać do watchlisty", async () => {
      const { data: row, error } = await supabaseAdmin
        .from("watchlist")
        .insert({ ...data, snapshot: data.snapshot ?? {} })
        .select()
        .single();
      assertNoDbError(error, "Dodawanie do watchlisty");
      return row;
    }),
  );

export const updateWatchlist = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid(), patch: WatchlistInput.partial() }).parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się zapisać wpisu watchlisty", async () => {
      const { data: row, error } = await supabaseAdmin
        .from("watchlist")
        .update(data.patch)
        .eq("id", data.id)
        .select()
        .single();
      assertNoDbError(error, "Zapis watchlisty");
      return row;
    }),
  );

export const removeFromWatchlist = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się usunąć z watchlisty", async () => {
      const { error } = await supabaseAdmin.from("watchlist").delete().eq("id", data.id);
      assertNoDbError(error, "Usuwanie z watchlisty");
      return { ok: true };
    }),
  );

export const getWatchlistHistory = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się pobrać historii", async () => {
      const { data: rows, error } = await supabaseAdmin
        .from("watchlist_history")
        .select("*")
        .eq("watchlist_id", data.id)
        .order("recorded_at", { ascending: false })
        .limit(100);
      assertNoDbError(error, "Historia watchlisty");
      return rows ?? [];
    }),
  );

export const recordWatchlistSnapshot = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      current_bid_usd: z.number().optional().nullable(),
      score: z.number().optional().nullable(),
      status: z.string().max(64).optional().nullable(),
      payload: z.any().optional(),
    }).parse,
  )
  .handler(async ({ data }) =>
    safeHandler("Nie udało się zapisać snapshotu", async () => {
      const { error } = await supabaseAdmin.from("watchlist_history").insert({
        watchlist_id: data.id,
        current_bid_usd: data.current_bid_usd ?? null,
        score: data.score ?? null,
        status: data.status ?? null,
        payload: data.payload ?? null,
      });
      assertNoDbError(error, "Snapshot watchlisty");
      await supabaseAdmin
        .from("watchlist")
        .update({
          current_bid_usd: data.current_bid_usd ?? null,
          score: data.score ?? null,
        })
        .eq("id", data.id);
      return { ok: true };
    }),
  );

// ---------- Dashboard stats ----------
export const getDashboardStats = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .handler(async () =>
    safeHandler("Nie udało się policzyć statystyk dashboardu", async () => {
      const [recordsRes, clientsRes, watchRes] = await Promise.all([
        supabaseAdmin
          .from("records")
          .select("id, client_id, status, analysis, listings, created_at")
          .limit(1000),
        supabaseAdmin.from("clients").select("id").limit(1000),
        supabaseAdmin.from("watchlist").select("id, active").limit(1000),
      ]);
      assertNoDbError(recordsRes.error, "Statystyki rekordów");
      const records = recordsRes.data ?? [];
      const clients = clientsRes.data ?? [];
      const watch = watchRes.data ?? [];

      let totalScores = 0;
      let scoreCount = 0;
      const makeCount: Record<string, number> = {};
      const flagCount: Record<string, number> = {};
      const byDay: Record<string, number> = {};

      for (const r of records) {
        const day = new Date(r.created_at).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] ?? 0) + 1;
        const analysis = asUnknownRecord(r.analysis);
        const lots = analysis?.lots ?? analysis?.analyzed ?? [];
        if (Array.isArray(lots)) {
          for (const lotValue of lots) {
            const lot = asUnknownRecord(lotValue);
            if (!lot) continue;
            const ai = asUnknownRecord(lot.ai);
            const score = Number(lot.score ?? ai?.score);
            if (Number.isFinite(score)) {
              totalScores += score;
              scoreCount++;
            }
            const car = asUnknownRecord(lot.car);
            const make = lot.make ?? car?.make;
            if (typeof make === "string" && make) {
              makeCount[make] = (makeCount[make] ?? 0) + 1;
            }
            const flags = lot.red_flags ?? ai?.red_flags ?? [];
            if (Array.isArray(flags)) {
              for (const flag of flags) {
                const flagRecord = asUnknownRecord(flag);
                const key =
                  typeof flag === "string"
                    ? flag
                    : typeof flagRecord?.label === "string"
                      ? flagRecord.label
                      : typeof flagRecord?.title === "string"
                        ? flagRecord.title
                        : "inne";
                flagCount[key] = (flagCount[key] ?? 0) + 1;
              }
            }
          }
        }
      }

      const topMakes = Object.entries(makeCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([name, value]) => ({ name, value }));
      const topFlags = Object.entries(flagCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([name, value]) => ({ name, value }));
      const timeline = Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-30)
        .map(([date, count]) => ({ date, count }));

      return {
        totalRecords: records.length,
        totalClients: clients.length,
        totalWatchlist: watch.filter((entry: { active: boolean }) => entry.active).length,
        avgScore: scoreCount > 0 ? totalScores / scoreCount : 0,
        topMakes,
        topFlags,
        timeline,
      };
    }),
  );
