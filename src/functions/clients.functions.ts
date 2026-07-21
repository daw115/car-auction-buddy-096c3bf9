// CRM klientów + spraw + powiązania z wyszukiwaniami.
// Wszystkie funkcje chronione siteSessionMiddleware — używamy supabaseAdmin,
// bo tabele są dostępne tylko dla service_role (RLS zdefiniowane w migracji).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { siteSessionMiddleware } from "@/functions/site-session-middleware.functions";
import { backendSearch } from "@/functions/backend.functions";
import { AppError, assertNoDbError, safeHandler } from "@/lib/errors";

// ---------- typy publiczne ----------

export type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ClientCase = {
  id: string;
  client_id: string;
  title: string;
  description: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default_criteria: Record<string, any> | null;
  status: "open" | "paused" | "closed";
  auto_refresh_enabled: boolean;
  auto_refresh_interval_hours: number;
  last_auto_run_at: string | null;
  next_auto_run_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CaseSearch = {
  id: string;
  case_id: string;
  record_id: string;
  searched_by: string | null;
  new_lot_ids: string[];
  triggered_by: string;
  created_at: string;
};

// ---------- klienci ----------

export const listClients = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .handler(async (): Promise<Client[]> =>
    safeHandler("Nie udało się pobrać listy klientów", async () => {
      const { data, error } = await supabaseAdmin
        .from("clients_v2")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(500);
      assertNoDbError(error, "Baza klientów");
      return (data ?? []) as Client[];
    }),
  );

export const getClient = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }): Promise<Client | null> =>
    safeHandler("Nie udało się pobrać klienta", async () => {
      const { data: row, error } = await supabaseAdmin
        .from("clients_v2")
        .select("*")
        .eq("id", data.id)
        .maybeSingle();
      assertNoDbError(error, "Klient");
      return (row ?? null) as Client | null;
    }),
  );

export const createClient = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      name: z.string().min(1, "Podaj nazwę klienta").max(200),
      email: z.string().email("Nieprawidłowy email").max(200).optional().nullable(),
      phone: z.string().max(60).optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
    }).parse,
  )
  .handler(async ({ data, context }): Promise<Client> =>
    safeHandler("Nie udało się dodać klienta", async () => {
      const { data: row, error } = await supabaseAdmin
        .from("clients_v2")
        .insert({
          name: data.name,
          email: data.email ?? null,
          phone: data.phone ?? null,
          notes: data.notes ?? null,
          created_by: context.siteUser,
        })
        .select("*")
        .single();
      assertNoDbError(error, "Dodawanie klienta");
      return row as Client;
    }),
  );

export const updateClient = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(200).optional(),
      email: z.string().email("Nieprawidłowy email").max(200).nullable().optional(),
      phone: z.string().max(60).nullable().optional(),
      notes: z.string().max(4000).nullable().optional(),
    }).parse,
  )
  .handler(async ({ data }): Promise<Client> =>
    safeHandler("Nie udało się zapisać klienta", async () => {
      const { id, ...patch } = data;
      const { data: row, error } = await supabaseAdmin
        .from("clients_v2")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single();
      assertNoDbError(error, "Zapis klienta");
      return row as Client;
    }),
  );

export const deleteClient = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się usunąć klienta", async () => {
      const { error } = await supabaseAdmin.from("clients_v2").delete().eq("id", data.id);
      assertNoDbError(error, "Usuwanie klienta");
      return { ok: true };
    }),
  );

// ---------- sprawy ----------

const criteriaJsonSchema = z.record(z.string(), z.unknown());

export const listCases = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ clientId: z.string().uuid().optional() }).parse)
  .handler(async ({ data }): Promise<ClientCase[]> =>
    safeHandler("Nie udało się pobrać spraw", async () => {
      let q = supabaseAdmin
        .from("client_cases")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(500);
      if (data.clientId) q = q.eq("client_id", data.clientId);
      const { data: rows, error } = await q;
      assertNoDbError(error, "Sprawy klienta");
      return (rows ?? []) as ClientCase[];
    }),
  );

export const getCase = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }): Promise<ClientCase | null> =>
    safeHandler("Nie udało się pobrać sprawy", async () => {
      const { data: row, error } = await supabaseAdmin
        .from("client_cases")
        .select("*")
        .eq("id", data.id)
        .maybeSingle();
      assertNoDbError(error, "Sprawa");
      return (row ?? null) as ClientCase | null;
    }),
  );

export const createCase = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      client_id: z.string().uuid(),
      title: z.string().min(1, "Podaj tytuł sprawy").max(200),
      description: z.string().max(4000).optional().nullable(),
      default_criteria: criteriaJsonSchema.optional().nullable(),
    }).parse,
  )
  .handler(async ({ data, context }): Promise<ClientCase> =>
    safeHandler("Nie udało się utworzyć sprawy", async () => {
      const { data: row, error } = await supabaseAdmin
        .from("client_cases")
        .insert({
          client_id: data.client_id,
          title: data.title,
          description: data.description ?? null,
          default_criteria: (data.default_criteria ?? null) as never,
          created_by: context.siteUser,
        })
        .select("*")
        .single();
      assertNoDbError(error, "Tworzenie sprawy");
      return row as ClientCase;
    }),
  );

export const updateCase = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(4000).nullable().optional(),
      default_criteria: criteriaJsonSchema.nullable().optional(),
      status: z.enum(["open", "paused", "closed"]).optional(),
    }).parse,
  )
  .handler(async ({ data }): Promise<ClientCase> =>
    safeHandler("Nie udało się zapisać sprawy", async () => {
      const { id, ...patch } = data;
      const { data: row, error } = await supabaseAdmin
        .from("client_cases")
        .update(patch as never)
        .eq("id", id)
        .select("*")
        .single();
      assertNoDbError(error, "Zapis sprawy");
      return row as ClientCase;
    }),
  );

export const deleteCase = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się usunąć sprawy", async () => {
      const { error } = await supabaseAdmin.from("client_cases").delete().eq("id", data.id);
      assertNoDbError(error, "Usuwanie sprawy");
      return { ok: true };
    }),
  );

export const toggleCaseAutoRefresh = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      enabled: z.boolean(),
      intervalHours: z.number().int().min(1).max(168).optional(),
    }).parse,
  )
  .handler(async ({ data }): Promise<ClientCase> =>
    safeHandler("Nie udało się przełączyć auto-odświeżania", async () => {
      const now = new Date();
      const interval = data.intervalHours ?? 24;
      const patch: Record<string, unknown> = {
        auto_refresh_enabled: data.enabled,
        auto_refresh_interval_hours: interval,
      };
      if (data.enabled) {
        patch.next_auto_run_at = new Date(now.getTime() + interval * 60 * 60 * 1000).toISOString();
      } else {
        patch.next_auto_run_at = null;
      }
      const { data: row, error } = await supabaseAdmin
        .from("client_cases")
        .update(patch as never)
        .eq("id", data.id)
        .select("*")
        .single();
      assertNoDbError(error, "Auto-odświeżanie");
      return row as ClientCase;
    }),
  );

// ---------- powiązania sprawy z wyszukiwaniem ----------

export const listCaseSearches = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ caseId: z.string().uuid() }).parse)
  .handler(async ({ data }): Promise<CaseSearch[]> =>
    safeHandler("Nie udało się pobrać wyszukiwań sprawy", async () => {
      const { data: rows, error } = await supabaseAdmin
        .from("case_searches")
        .select("*")
        .eq("case_id", data.caseId)
        .order("created_at", { ascending: false })
        .limit(200);
      assertNoDbError(error, "Wyszukiwania sprawy");
      return (rows ?? []) as CaseSearch[];
    }),
  );

export const attachSearchToCase = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      caseId: z.string().uuid(),
      recordId: z.string().min(1).max(200),
      newLotIds: z.array(z.string().max(200)).max(500).optional(),
      triggeredBy: z.enum(["manual", "auto"]).optional(),
    }).parse,
  )
  .handler(async ({ data, context }): Promise<CaseSearch> =>
    safeHandler("Nie udało się dołączyć wyszukiwania do sprawy", async () => {
      const { data: row, error } = await supabaseAdmin
        .from("case_searches")
        .upsert(
          {
            case_id: data.caseId,
            record_id: data.recordId,
            searched_by: context.siteUser,
            new_lot_ids: data.newLotIds ?? [],
            triggered_by: data.triggeredBy ?? "manual",
          },
          { onConflict: "case_id,record_id" },
        )
        .select("*")
        .single();
      assertNoDbError(error, "Powiązanie wyszukiwania");
      return row as CaseSearch;
    }),
  );

export const detachSearchFromCase = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się odłączyć wyszukiwania", async () => {
      const { error } = await supabaseAdmin.from("case_searches").delete().eq("id", data.id);
      assertNoDbError(error, "Odłączanie wyszukiwania");
      return { ok: true };
    }),
  );

/** Distinct operators dla sprawy (kto szukał + ile razy + ostatnia aktywność). */
export const getCaseOperators = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ caseId: z.string().uuid() }).parse)
  .handler(async ({ data }) =>
    safeHandler("Nie udało się pobrać operatorów sprawy", async () => {
      const { data: rows, error } = await supabaseAdmin
        .from("case_searches")
        .select("searched_by, created_at")
        .eq("case_id", data.caseId);
      assertNoDbError(error, "Operatorzy sprawy");
      const map = new Map<string, { user: string; count: number; last_at: string }>();
      for (const r of rows ?? []) {
        const u = (r as { searched_by: string | null }).searched_by ?? "(nieznany)";
        const t = (r as { created_at: string }).created_at;
        const cur = map.get(u);
        if (!cur) map.set(u, { user: u, count: 1, last_at: t });
        else {
          cur.count += 1;
          if (t > cur.last_at) cur.last_at = t;
        }
      }
      return Array.from(map.values()).sort((a, b) => b.last_at.localeCompare(a.last_at));
    }),
  );

/** Uruchom teraz — wywołuje backendSearch z default_criteria i attachuje wynik do sprawy. */
export const runCaseNow = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ caseId: z.string().uuid() }).parse)
  .handler(async ({ data, context }) =>
    safeHandler("Nie udało się uruchomić sprawy", async () => {
      const { data: kase, error } = await supabaseAdmin
        .from("client_cases")
        .select("*")
        .eq("id", data.caseId)
        .single();
      assertNoDbError(error, "Sprawa");
      const criteria = (kase.default_criteria ?? {}) as Record<string, unknown>;
      if (!criteria.make) {
        throw new AppError(
          "Sprawa nie ma zdefiniowanych domyślnych kryteriów — ustaw przynajmniej markę (`make`).",
          { status: 400 },
        );
      }

      // Weź poprzednie loty, żeby policzyć diff.
      const { data: prev } = await supabaseAdmin
        .from("case_searches")
        .select("new_lot_ids, record_id")
        .eq("case_id", data.caseId)
        .order("created_at", { ascending: false })
        .limit(50);

      const seenLotIds = new Set<string>();
      for (const p of prev ?? []) {
        for (const id of (p as { new_lot_ids: string[] | null }).new_lot_ids ?? []) {
          seenLotIds.add(id);
        }
      }

      const resp = await backendSearch({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { criteria: criteria as any },
      });
      const listings = resp.listings ?? [];
      const currentLotIds = listings.map((l) => l.lot_id).filter(Boolean);
      const newLotIds = currentLotIds.filter((id) => !seenLotIds.has(id));

      // Attach — record_id = job_id (backend indeksuje po job_id w /api/records).
      await supabaseAdmin
        .from("case_searches")
        .upsert(
          {
            case_id: data.caseId,
            record_id: resp.job_id,
            searched_by: context.siteUser,
            new_lot_ids: newLotIds,
            triggered_by: "manual",
          },
          { onConflict: "case_id,record_id" },
        );

      const patch: Record<string, unknown> = { last_auto_run_at: new Date().toISOString() };
      if (kase.auto_refresh_enabled) {
        patch.next_auto_run_at = new Date(
          Date.now() + kase.auto_refresh_interval_hours * 60 * 60 * 1000,
        ).toISOString();
      }
      await supabaseAdmin.from("client_cases").update(patch as never).eq("id", data.caseId);

      return {
        job_id: resp.job_id,
        total_lots: currentLotIds.length,
        new_lots: newLotIds.length,
        new_lot_ids: newLotIds,
      };
    }),
  );
