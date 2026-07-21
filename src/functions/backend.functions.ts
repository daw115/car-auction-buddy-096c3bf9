// Proxy do zewnętrznego backendu USA Car Finder (FastAPI).
// Wszystkie wywołania idą przez server function (Cloudflare Worker),
// żeby API_BEARER_TOKEN nie trafił nigdy do bundla klienta.
//
// Sekrety (Lovable Cloud):
//   API_BASE_URL             — np. https://moneybitches.organof.org
//   API_BEARER_TOKEN         — Bearer token dodawany do każdego requestu
//   MANHEIM_BACKEND_ENABLED  — fallback "true" tylko po wdrożeniu oficjalnego adaptera API
//
// Uwaga: legacy sekrety SCRAPER_BASE_URL / SCRAPER_API_TOKEN wskazywały
// historycznie na ten sam backend (potwierdzone diagnostycznie). Zostały
// scalone do API_BASE_URL / API_BEARER_TOKEN i skasowane.

import { createServerFn } from "@tanstack/react-start";
import { siteSessionMiddleware } from "@/functions/site-session-middleware.functions";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CarLot, ClientCriteria, AnalyzedLot } from "@/lib/types";
import {
  backendRequest,
  backendRequestSafe,
  type BackendRequest,
} from "@/lib/backend-transport.server";
import {
  auctionSourceCapabilitiesPayloadSchema,
  auctionSourceSchema,
  getUnavailableAuctionSources,
  type AuctionSource,
  type AuctionSourceCapabilities,
} from "@/lib/auction-sources";

// ---------- konfiguracja ----------
// Wybór transportu (Ubuntu API za Cloudflare Access vs legacy API_BASE_URL)
// znajduje się w src/server/backend-transport.server.ts. Nie odczytuj tu envów
// bezpośrednio poza wąskim probem /health i sprawdzeniem capabilities.

type BackendError = { status: number; message: string; body?: unknown };

function backendError(status: number, message: string, body?: unknown): BackendError {
  return { status, message, body };
}

// Wspólne wywołanie backendu — delegowane do zunifikowanego transportu.
async function callBackend<T>(opts: {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  timeoutMs?: number;
  responseType?: "json" | "text";
}): Promise<T> {
  const req: BackendRequest = {
    path: opts.path,
    method: opts.method,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    responseType: opts.responseType,
  };
  try {
    return await backendRequest<T>(req);
  } catch (err) {
    const e = err as Partial<BackendError>;
    throw backendError(
      typeof e?.status === "number" ? e.status : 0,
      typeof e?.message === "string" ? e.message : "Błąd połączenia z backendem.",
      e?.body,
    );
  }
}

// Wariant safe (nie rzuca, zwraca fallback) — dla list/health.
async function callBackendSafe<T>(
  opts: Parameters<typeof callBackend>[0],
  fallback: T,
): Promise<T> {
  return backendRequestSafe<T>(
    {
      path: opts.path,
      method: opts.method,
      body: opts.body,
      timeoutMs: opts.timeoutMs,
      responseType: opts.responseType,
    },
    fallback,
  );
}

let sourceCapabilitiesCache: { expiresAt: number; value: AuctionSourceCapabilities } | undefined;

function fallbackSourceCapabilities(): AuctionSourceCapabilities {
  const legacyConfigured = !!process.env.API_BASE_URL && !!process.env.API_BEARER_TOKEN;
  const ubuntuConfigured =
    !!process.env.UBUNTU_API_BASE_URL &&
    !!process.env.UBUNTU_API_BEARER_TOKEN &&
    !!process.env.CF_ACCESS_CLIENT_ID &&
    !!process.env.CF_ACCESS_CLIENT_SECRET;
  const backendConfigured = ubuntuConfigured || legacyConfigured;
  const manheimEnabled = process.env.MANHEIM_BACKEND_ENABLED === "true";
  return {
    checkedAt: new Date().toISOString(),
    sources: {
      copart: {
        available: backendConfigured,
        mode: backendConfigured ? "live" : "unavailable",
        reason: backendConfigured ? undefined : "backend_unconfigured",
      },
      iaai: {
        available: backendConfigured,
        mode: backendConfigured ? "live" : "unavailable",
        reason: backendConfigured ? undefined : "backend_unconfigured",
      },
      manheim: {
        available: backendConfigured && manheimEnabled,
        mode: backendConfigured && manheimEnabled ? "official_api" : "unavailable",
        reason:
          backendConfigured && manheimEnabled
            ? "enabled_by_server_configuration"
            : backendConfigured
              ? "credentials_or_adapter_missing"
              : "backend_unconfigured",
      },
    },
  };
}

function withManheimUnavailable(
  capabilities: AuctionSourceCapabilities,
  reason: string,
): AuctionSourceCapabilities {
  return {
    ...capabilities,
    checkedAt: new Date().toISOString(),
    sources: {
      ...capabilities.sources,
      manheim: { available: false, mode: "unavailable", reason },
    },
  };
}

function allSourcesUnavailable(reason: string): AuctionSourceCapabilities {
  const unavailable = { available: false as const, mode: "unavailable" as const, reason };
  return {
    checkedAt: new Date().toISOString(),
    sources: {
      copart: { ...unavailable },
      iaai: { ...unavailable },
      manheim: { ...unavailable },
    },
  };
}

async function getSourceCapabilities(options?: {
  forceRefresh?: boolean;
}): Promise<AuctionSourceCapabilities> {
  if (
    !options?.forceRefresh &&
    sourceCapabilitiesCache &&
    sourceCapabilitiesCache.expiresAt > Date.now()
  ) {
    return sourceCapabilitiesCache.value;
  }

  const fallback = fallbackSourceCapabilities();
  if (!fallback.sources.copart.available) return fallback;

  let value: AuctionSourceCapabilities;
  try {
    const raw = await callBackend<unknown>({ path: "/api/capabilities" });
    const parsed = auctionSourceCapabilitiesPayloadSchema.safeParse(raw);
    value = parsed.success
      ? {
          checkedAt: parsed.data.checkedAt ?? new Date().toISOString(),
          sources: parsed.data.sources,
        }
      : withManheimUnavailable(fallback, "invalid_capabilities_response");
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : 0;
    if (status === 404) {
      // Kompatybilność ze starszym backendem: operator musi jawnie potwierdzić adapter env-em.
      value = fallback;
    } else if (status === 401 || status === 403) {
      value = allSourcesUnavailable("backend_authorization_failed");
    } else {
      value = withManheimUnavailable(fallback, "capabilities_unreachable");
    }
  }

  sourceCapabilitiesCache = { expiresAt: Date.now() + 30_000, value };
  return value;
}

export async function assertAuctionSourcesAvailable(
  sources: readonly AuctionSource[] | undefined,
): Promise<void> {
  if (!sources?.length) return;
  const capabilities = await getSourceCapabilities({
    forceRefresh: sources.includes("manheim"),
  });
  const unavailable = getUnavailableAuctionSources(sources, capabilities);
  if (unavailable.length === 0) return;

  const includesManheim = unavailable.includes("manheim");
  throw backendError(
    503,
    includesManheim
      ? "Manheim Marketplace nie jest skonfigurowany w backendzie. Wymagany jest oficjalny adapter i poświadczenia API."
      : `Niedostępne źródła aukcyjne: ${unavailable.join(", ")}.`,
    {
      sources: unavailable.map((source) => ({
        source,
        reason: capabilities.sources[source].reason,
      })),
    },
  );
}

/** Dostępność źródeł potwierdzona przez backend; nie zwraca żadnych sekretów. */
export const backendSourceCapabilities = createServerFn({ method: "GET" }).middleware([siteSessionMiddleware]).handler(async () =>
  getSourceCapabilities(),
);

// ---------- typy odpowiedzi backendu ----------

export type BackendSearchResponse = {
  listings: CarLot[];
  analyzed_lots?: AnalyzedLot[];
  source: "mock" | "live";
  job_id: string;
  criteria: ClientCriteria;
  vin_coverage?: any;
  analysis_notice?: string | null;
};

export type BackendJobStatus = {
  job_id: string;
  status: string;
  progress?: number;
  phase?: string;
  phases?: any[];
  step?: string;
  message?: string;
  error?: string | null;
  current?: number;
  total?: number;
  listings?: CarLot[];
  analyzed_lots?: AnalyzedLot[];
  report_endpoints?: Record<string, string>;
  client_reports_html?: string[];
  broker_reports_html?: string[];
};

export type BackendRecordSummary = {
  id: string;
  created_at?: string;
  status?: string;
  client_name?: string | null;
  make?: string | null;
  model?: string | null;
  listings_count?: number;
  [k: string]: any;
};

export type BackendRecord = {
  id: number;
  title: string;
  status: "new" | "done" | "cancelled" | "error" | "interrupted";
  notes?: string | null;
  client?: { name?: string; email?: string; phone?: string } | null;
  collected_count: number;
  analysis_notice?: string | null;
  artifact_urls?: Record<string, string>;
  job_id?: string | null;
  searched_by?: string | null;
  created_at: string;
  updated_at: string;
};

export type ActiveJob = {
  id: string;
  label: string;
  status: "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";
  phase?: string | null;
  phase_info?: Record<string, any>;
  phases?: Array<{
    name: string;
    status: string;
    info?: Record<string, any>;
    started_at: string;
    finished_at?: string | null;
  }>;
  criteria?: Record<string, any>;
  created_at: string;
  finished_at?: string | null;
  listings_count?: number;
  analysis_notice?: string | null;
};

export type SearchAuditEntry = {
  id: string;
  created_at: string;
  searched_by: string | null;
  message: string;
  make: string | null;
  model: string | null;
  budget_usd: number | null;
  client_id: string | null;
  record_id: string | null;
};

// ---------- kryteria wyszukiwania ----------

const criteriaShape = z.object({
  make: z.string().min(1).max(80),
  model: z.string().max(80).optional().nullable(),
  year_from: z.number().int().min(1900).max(2100).optional().nullable(),
  year_to: z.number().int().min(1900).max(2100).optional().nullable(),
  budget_usd: z.number().min(0).max(1_000_000).optional().nullable(),
  max_odometer_mi: z.number().int().min(0).max(1_000_000).optional().nullable(),
  fuel_type: z.enum(["Gas", "Hybrid", "Diesel", "Electric"]).optional().nullable(),
  allowed_damage_types: z.array(z.string().max(40)).max(40).optional(),
  excluded_damage_types: z.array(z.string().max(40)).max(40).optional(),
  max_results: z.number().int().min(1).max(15).optional(),
  sources: z.array(auctionSourceSchema).min(1).max(3).optional(),
});

const searchExtras = {
  demo: z.boolean().optional(),
  disable_auction_filter: z.boolean().optional(),
  auction_min_hours: z.number().min(0).max(10000).optional().nullable(),
  auction_max_hours: z.number().min(0).max(10000).optional().nullable(),
};

// ---------- SEARCH ----------

/** POST /api/search — synchroniczne wywołanie (do kilku minut). */
export const backendSearch = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ criteria: criteriaShape, ...searchExtras }).parse)
  .handler(async ({ data }) => {
    await assertAuctionSourcesAvailable(data.criteria.sources);
    return callBackend<BackendSearchResponse>({
      path: "/api/search",
      method: "POST",
      body: data,
      timeoutMs: 5 * 60 * 1000,
    });
  });

export type BackendBatchJob = {
  job_id: string;
  status_url: string;
  stream_url?: string;
  cancel_url?: string;
  label?: string;
  idempotent?: boolean;
  reused_status?: string;
};

export type BackendBatchResponse = {
  jobs: BackendBatchJob[];
  queued_count: number;
};

/** POST /api/search/batch — do 20 wyszukiwań w jednym requestcie. */
export const backendSearchBatch = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      searches: z
        .array(z.object({ criteria: criteriaShape, ...searchExtras }))
        .min(1)
        .max(20),
    }).parse,
  )
  .handler(async ({ data }) => {
    await assertAuctionSourcesAvailable(
      Array.from(new Set(data.searches.flatMap((search) => search.criteria.sources ?? []))),
    );
    return callBackend<BackendBatchResponse>({
      path: "/api/search/batch",
      method: "POST",
      body: data,
      timeoutMs: 60_000,
    });
  });

// ---------- JOBS ----------

/** GET /api/jobs/{job_id} — polling statusu (używane przez batch + active pill). */
export const backendJobStatus = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ jobId: z.string().min(1).max(200) }).parse)
  .handler(async ({ data }) => {
    return callBackend<BackendJobStatus>({
      path: `/api/jobs/${encodeURIComponent(data.jobId)}`,
    });
  });

/**
 * GET /api/jobs — lista zadań.
 * Scalone z legacy listActiveScraperJobs + listAllJobs. Zwraca zawsze { jobs, total }.
 */
export const backendListJobs = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator((d: { activeOnly?: boolean; limit?: number } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const params = new URLSearchParams();
    params.set("active_only", data.activeOnly ? "true" : "false");
    if (data.limit) params.set("limit", String(data.limit));
    return callBackendSafe<{ jobs: ActiveJob[]; total: number }>(
      { path: `/api/jobs?${params}` },
      { jobs: [], total: 0 },
    );
  });

/** DELETE /api/jobs/{id} (fallback POST /cancel). */
export const backendCancelJob = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ jobId: z.string().min(1) }).parse)
  .handler(async ({ data }): Promise<{ ok: boolean; status?: string }> => {
    try {
      const r = await callBackend<{ status?: string }>({
        path: `/api/jobs/${encodeURIComponent(data.jobId)}`,
        method: "DELETE",
      });
      return { ok: true, status: r?.status ?? "cancelled" };
    } catch {
      const r = await callBackend<{ status?: string }>({
        path: `/api/jobs/${encodeURIComponent(data.jobId)}/cancel`,
        method: "POST",
      });
      return { ok: true, status: r?.status ?? "cancelled" };
    }
  });

// ---------- RECORDS ----------

/**
 * GET /api/records — lista rekordów (historia).
 * Zwraca zawsze { records, total }. Filtry opcjonalne.
 */
export const backendListRecords = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator((d: { query?: string; status?: string; limit?: number } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const params = new URLSearchParams();
    if (data.query) params.set("query", data.query);
    if (data.status) params.set("status", data.status);
    if (data.limit) params.set("limit", String(data.limit));
    return callBackendSafe<{ records: BackendRecord[]; total: number }>(
      { path: `/api/records?${params}` },
      { records: [], total: 0 },
    );
  });

/** GET /api/records/{id} — szczegóły rekordu. */
export const backendGetRecord = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.coerce.string().min(1).max(200) }).parse)
  .handler(async ({ data }) => {
    return callBackendSafe<Record<string, any> | null>(
      { path: `/api/records/${encodeURIComponent(data.id)}` },
      null,
    );
  });

/** DELETE /api/records/{id}. */
export const backendDeleteRecord = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.coerce.string().min(1) }).parse)
  .handler(async ({ data }) => {
    try {
      const json = await callBackend<any>({
        path: `/api/records/${encodeURIComponent(data.id)}`,
        method: "DELETE",
      });
      return {
        ok: true as const,
        status: 200,
        record_id: json?.record_id ?? data.id,
        files_removed: json?.files_removed ?? 0,
        bytes_freed: json?.bytes_freed ?? 0,
        skipped: json?.skipped ?? [],
      };
    } catch (e: any) {
      return { ok: false as const, status: e?.status ?? 0, detail: e?.message ?? "Błąd sieci" };
    }
  });

/** POST /api/records/{id}/regenerate-bundles?engine=... */
export const backendRegenerateBundles = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      recordId: z.number().int(),
      engine: z.enum(["template", "hybrid"]).optional().default("template"),
    }).parse,
  )
  .handler(async ({ data }) => {
    return callBackend<any>({
      path: `/api/records/${data.recordId}/regenerate-bundles?engine=${data.engine}`,
      method: "POST",
    });
  });

// ---------- REPORTS ----------

const reportModeSchema = z.enum([
  "client-html",
  "broker-html",
  "client-llm",
  "broker-llm",
  "offer-email-html",
  "pdf",
]);

export const backendGenerateReport = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      mode: reportModeSchema,
      approved_lots: z.array(z.any()).min(1),
      criteria: criteriaShape.optional(),
      client_name: z.string().max(200).optional(),
      client_email: z.string().max(200).optional(),
      tracking_url: z.string().max(500).optional(),
    }).parse,
  )
  .handler(async ({ data }) => {
    const pathMap: Record<z.infer<typeof reportModeSchema>, string> = {
      "client-html": "/report/client-html",
      "broker-html": "/report/broker-html",
      "client-llm": "/report/client-llm",
      "broker-llm": "/report/broker-llm",
      "offer-email-html": "/report/offer-email-html",
      pdf: "/report",
    };
    const { mode, ...body } = data;
    const html = await callBackend<string>({
      path: pathMap[mode],
      method: "POST",
      body,
      timeoutMs: 3 * 60 * 1000,
      responseType: "text",
    });
    return { mode, html };
  });

// ---------- FEEDBACK ----------

/** GET /api/records/{id}/feedback. */
export const backendGetFeedback = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ recordId: z.coerce.string().min(1).max(200) }).parse)
  .handler(async ({ data }) => {
    return callBackendSafe<any>(
      { path: `/api/records/${encodeURIComponent(data.recordId)}/feedback` },
      { feedback: [], up: 0, down: 0, total: 0 },
    );
  });

/** POST /api/records/{id}/feedback — typowany kciuk-w-górę/dół dla lotu. */
export const backendSubmitFeedback = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      recordId: z.coerce.string().min(1),
      lot_id: z.string().min(1),
      source: auctionSourceSchema,
      vote: z.enum(["up", "down"]),
      reason: z.string().max(500).optional(),
    }).parse,
  )
  .handler(async ({ data }) => {
    const { recordId, ...body } = data;
    return callBackend<any>({
      path: `/api/records/${encodeURIComponent(recordId)}/feedback`,
      method: "POST",
      body,
    });
  });

/** DELETE /api/records/{id}/feedback/{lot_id}?source=... */
export const backendDeleteFeedback = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.object({
      recordId: z.coerce.string().min(1),
      lot_id: z.string().min(1),
      source: auctionSourceSchema,
    }).parse,
  )
  .handler(async ({ data }) => {
    const params = new URLSearchParams({ source: data.source });
    return callBackend<any>({
      path: `/api/records/${encodeURIComponent(data.recordId)}/feedback/${encodeURIComponent(data.lot_id)}?${params}`,
      method: "DELETE",
    });
  });

/** POST /api/feedback/analyze — meta-analiza. */
export const backendAnalyzeFeedback = createServerFn({ method: "POST" }).middleware([siteSessionMiddleware]).handler(async () =>
  callBackend<any>({ path: "/api/feedback/analyze", method: "POST" }),
);

// ---------- LLM cache ----------

export const backendClearLlmCache = createServerFn({ method: "POST" }).middleware([siteSessionMiddleware]).handler(async () => {
  return callBackendSafe<{ removed: number }>(
    { path: "/api/llm-cache", method: "DELETE" },
    { removed: 0 },
  );
});

export const backendListLlmCacheEntries = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator((d: { limit?: number } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const params = new URLSearchParams();
    if (data.limit) params.set("limit", String(data.limit));
    const json = await callBackendSafe<{ items?: any[] }>(
      { path: `/api/llm-cache/list?${params}` },
      { items: [] },
    );
    return json.items ?? [];
  });

export const backendDeleteLlmCacheEntry = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ key: z.string().min(1) }).parse)
  .handler(async ({ data }) => {
    await callBackend<any>({
      path: `/api/llm-cache/entry/${encodeURIComponent(data.key)}`,
      method: "DELETE",
    });
    return { ok: true };
  });

// ---------- HTML cache ----------

export const backendListHtmlCache = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator((d: { source?: string; limit?: number } | undefined) => d ?? {})
  .handler(async ({ data }) => {
    const params = new URLSearchParams();
    if (data.source) params.set("source", data.source);
    if (data.limit) params.set("limit", String(data.limit));
    const json = await callBackendSafe<{ items?: any[] }>(
      { path: `/api/html-cache?${params}` },
      { items: [] },
    );
    return json.items ?? [];
  });

/** Pobiera surowy HTML wyłącznie z dozwolonych endpointów cache. */
export const backendFetchHtml = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("llm-cache"),
        key: z.string().min(1).max(300),
      }),
      z.object({
        kind: z.literal("html-cache"),
        source: auctionSourceSchema,
        filename: z.string().min(1).max(300),
      }),
    ]).parse,
  )
  .handler(async ({ data }) => {
    const path =
      data.kind === "llm-cache"
        ? `/api/llm-cache/entry/${encodeURIComponent(data.key)}`
        : `/api/html-cache/${encodeURIComponent(data.source)}/${encodeURIComponent(data.filename)}`;
    return callBackend<string>({ path, responseType: "text" });
  });

// ---------- Model normalizations ----------

export const backendListModelNormalizations = createServerFn({ method: "GET" }).middleware([siteSessionMiddleware]).handler(
  async () => {
    return callBackendSafe<{
      items: Array<{
        id: string | number;
        make: string;
        original_text: string;
        normalized_model: string;
        reason?: string;
        verified_count?: number;
      }>;
      stats?: { total: number; by_make: Record<string, number> };
    }>({ path: "/api/model-normalizations" }, { items: [] });
  },
);

export const backendDeleteModelNormalization = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ id: z.coerce.string().min(1) }).parse)
  .handler(async ({ data }) => {
    await callBackend<any>({
      path: `/api/model-normalizations/${encodeURIComponent(data.id)}`,
      method: "DELETE",
    });
    return { ok: true };
  });

// ---------- Client message parsing ----------

/** POST /api/parse-client-message — LLM zamienia wiadomość klienta na criteria. */
export const backendParseClientMessage = createServerFn({ method: "POST" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ message: z.string().min(1).max(5000) }).parse)
  .handler(async ({ data }) => {
    try {
      const body = await callBackend<{
        criteria?: any;
        criteria_list?: any[];
        count?: number;
        summary?: string;
        warnings?: string[];
      }>({
        path: "/api/parse-client-message",
        method: "POST",
        body: { message: data.message },
        timeoutMs: 60_000,
      });
      const list: any[] = body.criteria_list ?? (body.criteria ? [body.criteria] : []);
      return {
        ok: true as const,
        criteria: body.criteria ?? list[0] ?? null,
        criteria_list: list,
        count: body.count ?? list.length,
        summary: body.summary ?? "",
        warnings: body.warnings ?? [],
      };
    } catch (e: any) {
      return { ok: false as const, status: e?.status ?? 0, detail: e?.message ?? "Błąd" };
    }
  });

// ---------- Database browser ----------

export const backendDbOverview = createServerFn({ method: "GET" }).middleware([siteSessionMiddleware]).handler(async () => {
  return callBackendSafe<any>({ path: "/api/db/overview" }, null);
});

// ---------- Health ----------

type ServiceStatus = "ok" | "down" | "unconfigured";

/** Zbiorczy health-check: baza (Supabase) + backend (usacar-api /health). */
export const backendHealth = createServerFn({ method: "GET" }).middleware([siteSessionMiddleware]).handler(
  async (): Promise<{
    checkedAt: string;
    durationMs: number;
    services: {
      database: { status: ServiceStatus; error?: string };
      backend: { status: ServiceStatus; url?: string; error?: string };
    };
  }> => {
    const startedAt = Date.now();

    let dbStatus: ServiceStatus = "ok";
    let dbError: string | undefined;
    try {
      const { error } = await supabaseAdmin.from("app_config").select("id").limit(1);
      if (error) {
        dbStatus = "down";
        dbError = error.message;
      }
    } catch (e) {
      dbStatus = "down";
      dbError = (e as Error).message;
    }

    const backendUrl = process.env.API_BASE_URL?.replace(/\/+$/, "");
    let backendStatus: ServiceStatus = "unconfigured";
    let backendErrorMsg: string | undefined;
    if (backendUrl) {
      try {
        const token = process.env.API_BEARER_TOKEN;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`${backendUrl}/health`, {
          signal: ctrl.signal,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        clearTimeout(timer);
        if (res.ok) backendStatus = "ok";
        else {
          backendStatus = "down";
          backendErrorMsg = `HTTP ${res.status}`;
        }
      } catch (e) {
        backendStatus = "down";
        backendErrorMsg = (e as Error).message?.includes("abort")
          ? "Timeout (5s)"
          : (e as Error).message;
      }
    }

    return {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      services: {
        database: { status: dbStatus, error: dbError },
        backend: {
          status: backendStatus,
          url: backendUrl ? new URL(backendUrl).host : undefined,
          error: backendErrorMsg,
        },
      },
    };
  },
);

// ---------- Search audit (Supabase operation_logs) ----------

export const backendListSearchAudit = createServerFn({ method: "GET" })
  .middleware([siteSessionMiddleware])
  .inputValidator(z.object({ limit: z.number().min(1).max(200).optional() }).parse)
  .handler(async ({ data }): Promise<{ entries: SearchAuditEntry[] }> => {
    const { data: rows, error } = await supabaseAdmin
      .from("operation_logs")
      .select("id, created_at, message, details, client_id, record_id")
      .eq("operation", "audit")
      .eq("step", "search.start")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 50);
    if (error) throw new Error(error.message);
    const entries: SearchAuditEntry[] = (rows ?? []).map((r: Record<string, unknown>) => {
      const d = (r.details ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id),
        created_at: String(r.created_at),
        searched_by: (d.searched_by as string | null) ?? null,
        message: (r.message as string | null) ?? "",
        make: (d.make as string | null) ?? null,
        model: (d.model as string | null) ?? null,
        budget_usd: (d.budget_usd as number | null) ?? null,
        client_id: (r.client_id as string | null) ?? null,
        record_id: (r.record_id as string | null) ?? null,
      };
    });
    return { entries };
  });
