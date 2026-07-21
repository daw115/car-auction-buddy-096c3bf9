// Unified server-only backend transport.
//
// Chooses between the new Ubuntu API (via ubuntu-api.server.ts) and the
// legacy API_BASE_URL/API_BEARER_TOKEN transport based on which environment
// variables are populated. This is the ONE place that owns transport
// selection — individual server functions must never inspect UBUNTU_* /
// CF_ACCESS_* / API_BASE_URL directly.
//
// Rules (see docs/lovable-ubuntu-deployment.md):
//   1. All four Ubuntu env vars present + valid → route through Ubuntu.
//   2. None of the four Ubuntu env vars present → use legacy transport.
//   3. Partial Ubuntu config → fail closed. No request is issued. No fallback.
//   4. Once Ubuntu is chosen, there is NO runtime fallback to legacy on
//      timeout / 401 / 403 / 429 / 5xx / network error. Critical for
//      POST/PUT/DELETE — a mutation must never be replayed against a
//      different backend.
//   5. Retry logic is confined to ubuntu-api.server.ts (GET/HEAD, one retry,
//      network / 502 / 503 / 504 only).
//
// Errors thrown are compatible with the previous `BackendError` shape used
// by callers: `{ status: number, message: string, body?: unknown }`.
// Messages are sanitized — no URLs, tokens, headers, or upstream bodies.

import {
  isUbuntuApiConfigured,
  readUbuntuApiConfig,
  ubuntuApiRequest,
  ubuntuApiStreamRequest,
  UbuntuApiError,
  canonicalizeBaseUrl,
} from "./ubuntu-api.server";

export type BackendMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type BackendResponseType = "json" | "text";

export type BackendTransportError = {
  status: number;
  message: string;
  body?: unknown;
};

export type BackendRequest<TBody = unknown> = {
  path: string;
  method?: BackendMethod;
  body?: TBody;
  timeoutMs?: number;
  responseType?: BackendResponseType;
  /** Optional runtime validator. Throw to mark payload invalid. */
  validate?: (raw: unknown) => void;
  /** Test seam — dependency-inject fetch for the legacy branch only. */
  fetchImpl?: typeof fetch;
};

export type BackendTransportKind = "ubuntu" | "legacy";

/** True when any single UBUNTU_/CF_ACCESS_ env var is set. */
function anyUbuntuEnvPresent(): boolean {
  return (
    !!process.env.UBUNTU_API_BASE_URL ||
    !!process.env.UBUNTU_API_BEARER_TOKEN ||
    !!process.env.CF_ACCESS_CLIENT_ID ||
    !!process.env.CF_ACCESS_CLIENT_SECRET
  );
}

/** True when all four UBUNTU_/CF_ACCESS_ env vars are set (regardless of URL validity). */
function allUbuntuEnvPresent(): boolean {
  return (
    !!process.env.UBUNTU_API_BASE_URL &&
    !!process.env.UBUNTU_API_BEARER_TOKEN &&
    !!process.env.CF_ACCESS_CLIENT_ID &&
    !!process.env.CF_ACCESS_CLIENT_SECRET
  );
}

function terr(status: number, message: string, body?: unknown): BackendTransportError {
  return { status, message, body };
}

/**
 * Decide transport for the current process env. Throws a fail-closed error
 * for partial Ubuntu configuration or invalid Ubuntu URL.
 */
export function selectBackendTransport(): BackendTransportKind {
  if (allUbuntuEnvPresent()) {
    // Config canonicalization also validates protocol/credentials.
    if (!isUbuntuApiConfigured()) {
      throw terr(
        500,
        "Incomplete Ubuntu API configuration. Set UBUNTU_API_BASE_URL (https, no credentials), UBUNTU_API_BEARER_TOKEN, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or unset all four to use the legacy backend.",
      );
    }
    return "ubuntu";
  }
  if (anyUbuntuEnvPresent()) {
    throw terr(
      500,
      "Incomplete Ubuntu API configuration. All four UBUNTU_API_BASE_URL, UBUNTU_API_BEARER_TOKEN, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together, or all four must be unset to use the legacy backend.",
    );
  }
  return "legacy";
}

/**
 * Split a "/path?a=b" into `{ path, query }` for the Ubuntu client, which
 * appends its own query string. Legacy transport uses the raw path as-is.
 */
function splitQuery(pathAndQuery: string): {
  path: string;
  query: Record<string, string> | undefined;
} {
  const qIdx = pathAndQuery.indexOf("?");
  if (qIdx === -1) return { path: pathAndQuery, query: undefined };
  const path = pathAndQuery.slice(0, qIdx);
  const query: Record<string, string> = {};
  const usp = new URLSearchParams(pathAndQuery.slice(qIdx + 1));
  for (const [k, v] of usp.entries()) query[k] = v;
  return { path, query };
}

function ubuntuErrorToTransport(err: unknown): BackendTransportError {
  if (err instanceof UbuntuApiError) {
    const status =
      err.status ?? (err.kind === "timeout" ? 408 : err.kind === "unconfigured" ? 500 : 0);
    let msg: string;
    switch (err.kind) {
      case "unauthorized":
      case "access_denied":
        msg = "Błąd konfiguracji — skontaktuj się z administratorem.";
        break;
      case "not_found":
        msg = "Nie znaleziono zasobu.";
        break;
      case "rate_limited":
        msg = "Backend rate limit — spróbuj ponownie za chwilę.";
        break;
      case "timeout":
        msg = "Przekroczono limit czasu — spróbuj ponownie.";
        break;
      case "network_error":
        msg = "Błąd połączenia z backendem.";
        break;
      case "invalid_response":
        msg = "Backend zwrócił nieprawidłową odpowiedź.";
        break;
      case "conflict":
        msg = "Konflikt zasobu.";
        break;
      case "upstream_error":
        msg = "Błąd backendu, spróbuj ponownie za chwilę.";
        break;
      case "unconfigured":
      default:
        msg = "Backend nieskonfigurowany.";
    }
    return terr(status, msg);
  }
  return terr(0, "Błąd połączenia z backendem.");
}

async function requestLegacy<T>(req: BackendRequest): Promise<T> {
  const baseRaw = (process.env.API_BASE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.API_BEARER_TOKEN ?? "";
  if (!baseRaw || !token) {
    throw terr(500, "Backend nieskonfigurowany — brak sekretów API_BASE_URL / API_BEARER_TOKEN.");
  }
  const method = req.method ?? "GET";
  const timeoutMs = req.timeoutMs ?? 30_000;
  const responseType = req.responseType ?? "json";
  const fetchImpl = req.fetchImpl ?? fetch;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseRaw}${req.path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: responseType === "json" ? "application/json" : "text/html, */*",
        ...(req.body != null ? { "Content-Type": "application/json" } : {}),
      },
      body: req.body != null ? JSON.stringify(req.body) : undefined,
      signal: ctrl.signal,
    });

    const rawText = await res.text();
    let parsed: unknown = rawText;
    if (responseType === "json" && rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        /* keep raw text */
      }
    }

    if (!res.ok) {
      let msg: string;
      if (res.status === 401 || res.status === 403)
        msg = "Błąd konfiguracji — skontaktuj się z administratorem.";
      else if (res.status === 404) msg = "Nie znaleziono zasobu.";
      else if (res.status >= 500) msg = "Błąd backendu, spróbuj ponownie za chwilę.";
      else msg = `Backend ${res.status}`;
      const detail =
        parsed && typeof parsed === "object" && "detail" in (parsed as Record<string, unknown>)
          ? (parsed as { detail?: unknown }).detail
          : undefined;
      const detailStr =
        typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : undefined;
      throw terr(res.status, detailStr ? `${msg}: ${detailStr}` : msg, parsed);
    }

    if (req.validate) {
      try {
        req.validate(parsed);
      } catch {
        throw terr(res.status, "Backend zwrócił nieprawidłową odpowiedź.");
      }
    }

    return parsed as T;
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) throw err;
    if ((err as Error).name === "AbortError") {
      throw terr(408, "Przekroczono limit czasu — spróbuj ponownie.");
    }
    throw terr(0, (err as Error).message || "Błąd połączenia z backendem.");
  } finally {
    clearTimeout(timer);
  }
}

async function requestUbuntu<T>(req: BackendRequest): Promise<T> {
  const responseType = req.responseType ?? "json";
  // The current ubuntu-api.server.ts only parses JSON. Text responses are
  // used for HTML reports and cache dumps — those endpoints are not part of
  // this etap 2 migration surface, so we surface a clear error instead of
  // silently corrupting the payload.
  if (responseType === "text") {
    throw terr(
      501,
      "Ubuntu API transport nie obsługuje odpowiedzi text/html w tym etapie migracji.",
    );
  }
  const { path, query } = splitQuery(req.path);
  try {
    const result = await ubuntuApiRequest<T>({
      method: req.method ?? "GET",
      path,
      query,
      body: req.body,
      timeoutMs: req.timeoutMs,
      validate: req.validate,
    });
    return result.data;
  } catch (err) {
    throw ubuntuErrorToTransport(err);
  }
}

/**
 * Unified request. Selects transport, delegates, normalizes errors.
 * No runtime fallback between transports.
 */
export async function backendRequest<T = unknown>(req: BackendRequest): Promise<T> {
  const transport = selectBackendTransport();
  if (transport === "ubuntu") return requestUbuntu<T>(req);
  return requestLegacy<T>(req);
}

/** Non-throwing variant with a caller-provided fallback (list/health flows). */
export async function backendRequestSafe<T>(req: BackendRequest, fallback: T): Promise<T> {
  try {
    return await backendRequest<T>(req);
  } catch {
    return fallback;
  }
}

/** Test-only helper: expose whether canonicalization considers the URL valid. */
export function _debugValidateUbuntuBaseUrl(input: string): boolean {
  return canonicalizeBaseUrl(input) !== null;
}

// -------------------- streaming (SSE proxy) --------------------

export type BackendStreamRequest = {
  path: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Optional timeout for the initial connect (headers received). */
  timeoutMs?: number;
  /** Test seam — dependency-inject fetch for the legacy branch only. */
  fetchImpl?: typeof fetch;
};

export type BackendStreamResponse = {
  body: ReadableStream<Uint8Array>;
  status: number;
  transport: BackendTransportKind;
};

async function streamLegacy(req: BackendStreamRequest): Promise<BackendStreamResponse> {
  const baseRaw = (process.env.API_BASE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.API_BEARER_TOKEN ?? "";
  if (!baseRaw || !token) {
    throw terr(500, "Backend nieskonfigurowany — brak sekretów API_BASE_URL / API_BEARER_TOKEN.");
  }
  const method = req.method ?? "GET";
  const fetchImpl = req.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (req.signal) {
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = req.timeoutMs ? setTimeout(() => controller.abort(), req.timeoutMs) : null;

  let response: Response;
  try {
    response = await fetchImpl(`${baseRaw}${req.path}`, {
      method,
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        ...(req.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (req.signal) req.signal.removeEventListener("abort", onAbort);
    if ((err as Error).name === "AbortError") {
      throw terr(408, "Przekroczono limit czasu — spróbuj ponownie.");
    }
    throw terr(0, "Błąd połączenia z backendem.");
  }
  if (timer) clearTimeout(timer);

  if (!response.ok) {
    if (req.signal) req.signal.removeEventListener("abort", onAbort);
    let msg: string;
    if (response.status === 401 || response.status === 403)
      msg = "Błąd konfiguracji — skontaktuj się z administratorem.";
    else if (response.status === 404) msg = "Nie znaleziono zasobu.";
    else if (response.status >= 500) msg = "Błąd backendu, spróbuj ponownie za chwilę.";
    else msg = `Backend ${response.status}`;
    throw terr(response.status, msg);
  }
  if (!response.body) {
    if (req.signal) req.signal.removeEventListener("abort", onAbort);
    throw terr(response.status, "Backend zwrócił nieprawidłową odpowiedź.");
  }
  return { body: response.body, status: response.status, transport: "legacy" };
}

async function streamUbuntu(req: BackendStreamRequest): Promise<BackendStreamResponse> {
  const { path, query } = splitQuery(req.path);
  try {
    const result = await ubuntuApiStreamRequest({
      method: req.method ?? "GET",
      path,
      query,
      headers: req.headers,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    return { body: result.body, status: result.status, transport: "ubuntu" };
  } catch (err) {
    throw ubuntuErrorToTransport(err);
  }
}

/**
 * Streaming request. Selects transport identically to `backendRequest`
 * (fail-closed on partial Ubuntu config, no runtime fallback between
 * transports). Returns the raw upstream `ReadableStream` — the caller is
 * responsible for wrapping it in a `Response` with SSE headers.
 */
export async function backendStreamRequest(
  req: BackendStreamRequest,
): Promise<BackendStreamResponse> {
  const transport = selectBackendTransport();
  if (transport === "ubuntu") return streamUbuntu(req);
  return streamLegacy(req);
}
