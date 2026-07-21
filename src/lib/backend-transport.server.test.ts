// Tests for the unified backend transport (legacy vs Ubuntu selection).
// All tests mock fetch — no real network activity.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backendRequest,
  backendRequestSafe,
  backendStreamRequest,
  selectBackendTransport,
  type BackendTransportError,
} from "./backend-transport.server";

const UBU_URL = "https://ubuntu.example.org/api";
const UBU_BEARER = "ubuntu-bearer-token";
const CF_ID = "cf-client-id";
const CF_SECRET = "cf-client-secret";
const LEG_URL = "https://legacy.example.org";
const LEG_BEARER = "legacy-bearer-token";

function setUbuntuEnv() {
  process.env.UBUNTU_API_BASE_URL = UBU_URL;
  process.env.UBUNTU_API_BEARER_TOKEN = UBU_BEARER;
  process.env.CF_ACCESS_CLIENT_ID = CF_ID;
  process.env.CF_ACCESS_CLIENT_SECRET = CF_SECRET;
}
function clearUbuntuEnv() {
  delete process.env.UBUNTU_API_BASE_URL;
  delete process.env.UBUNTU_API_BEARER_TOKEN;
  delete process.env.CF_ACCESS_CLIENT_ID;
  delete process.env.CF_ACCESS_CLIENT_SECRET;
}
function setLegacyEnv() {
  process.env.API_BASE_URL = LEG_URL;
  process.env.API_BEARER_TOKEN = LEG_BEARER;
}
function clearLegacyEnv() {
  delete process.env.API_BASE_URL;
  delete process.env.API_BEARER_TOKEN;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  clearUbuntuEnv();
  clearLegacyEnv();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  clearUbuntuEnv();
  clearLegacyEnv();
});

describe("selectBackendTransport", () => {
  it("returns 'ubuntu' when all four Ubuntu env vars are present and URL is valid", () => {
    setUbuntuEnv();
    expect(selectBackendTransport()).toBe("ubuntu");
  });

  it("returns 'legacy' when no Ubuntu env vars are set", () => {
    setLegacyEnv();
    expect(selectBackendTransport()).toBe("legacy");
  });

  it("fails closed with a sanitized error for partial Ubuntu config", () => {
    process.env.UBUNTU_API_BASE_URL = UBU_URL;
    // Missing bearer / CF creds.
    try {
      selectBackendTransport();
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as BackendTransportError;
      expect(e.status).toBe(500);
      expect(e.message).toContain("Incomplete Ubuntu API configuration");
      expect(e.message).not.toContain(UBU_URL);
    }
  });

  it("fails closed with an invalid Ubuntu URL even when all four env vars are set", () => {
    setUbuntuEnv();
    process.env.UBUNTU_API_BASE_URL = "http://insecure.example.org"; // non-https
    try {
      selectBackendTransport();
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as BackendTransportError;
      expect(e.status).toBe(500);
      expect(e.message).toContain("Incomplete Ubuntu API configuration");
    }
  });
});

describe("backendRequest — Ubuntu transport", () => {
  it("routes to UBUNTU_API_BASE_URL and sends CF-Access + bearer headers, never legacy URL", async () => {
    setUbuntuEnv();
    setLegacyEnv(); // Both configured — Ubuntu must win.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await backendRequest<{ ok: boolean }>({ path: "/api/health" });
    expect(data.ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(UBU_URL)).toBe(true);
    expect(url).not.toContain(LEG_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${UBU_BEARER}`);
    expect(headers["CF-Access-Client-Id"]).toBe(CF_ID);
    expect(headers["CF-Access-Client-Secret"]).toBe(CF_SECRET);
  });

  it("does NOT fall back to legacy on 401/403/500 after Ubuntu was chosen", async () => {
    setUbuntuEnv();
    setLegacyEnv();
    for (const status of [401, 403, 500]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      await expect(backendRequest({ path: "/api/records" })).rejects.toMatchObject({
        status,
      });
      // Only ONE fetch call — no retry to legacy. (Non-retryable status.)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).not.toContain(LEG_URL);
    }
  });

  it("does NOT retry POST/PUT/DELETE via any fallback layer", async () => {
    setUbuntuEnv();
    setLegacyEnv();
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      await expect(
        backendRequest({ path: "/api/records/1", method, body: {} }),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe("backendRequest — legacy transport", () => {
  it("uses API_BASE_URL + API_BEARER_TOKEN and omits CF-Access headers", async () => {
    setLegacyEnv();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await backendRequest({ path: "/api/records" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LEG_URL}/api/records`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${LEG_BEARER}`);
    expect(headers["CF-Access-Client-Id"]).toBeUndefined();
    expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
  });
});

describe("backendRequest — partial / invalid Ubuntu config", () => {
  it("does not issue any HTTP request when Ubuntu config is partial", async () => {
    process.env.UBUNTU_API_BASE_URL = UBU_URL;
    process.env.UBUNTU_API_BEARER_TOKEN = UBU_BEARER;
    // CF_ACCESS_* missing.
    setLegacyEnv(); // legacy is configured — must NOT be used.
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(backendRequest({ path: "/api/records" })).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not issue any HTTP request when the Ubuntu URL is invalid", async () => {
    setUbuntuEnv();
    process.env.UBUNTU_API_BASE_URL = "not-a-url";
    setLegacyEnv();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(backendRequest({ path: "/api/records" })).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("backendRequest — error sanitization", () => {
  it("never leaks the Ubuntu URL, bearer token, or upstream body in error messages", async () => {
    setUbuntuEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(`{"detail":"secret-leaked-${UBU_BEARER}"}`, { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await backendRequest({ path: "/api/records" });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as BackendTransportError;
      expect(e.message).not.toContain(UBU_BEARER);
      expect(e.message).not.toContain(UBU_URL);
      expect(e.message).not.toContain("secret-leaked");
      expect(e.message).not.toContain(CF_ID);
      expect(e.message).not.toContain(CF_SECRET);
    }
  });
});

describe("backendRequest — validator", () => {
  it("rejects invalid payload via the validate callback", async () => {
    setLegacyEnv();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ wrong: true })) as unknown as typeof fetch;

    await expect(
      backendRequest({
        path: "/api/records",
        validate: (raw) => {
          const r = raw as Record<string, unknown>;
          if (typeof r.records !== "object") throw new Error("bad shape");
        },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("nieprawidłową") });
  });
});

describe("backendRequestSafe", () => {
  it("returns the caller fallback when the request throws", async () => {
    setLegacyEnv();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch;
    const res = await backendRequestSafe({ path: "/api/records" }, { records: [] });
    expect(res).toEqual({ records: [] });
  });
});

describe("backendStreamRequest", () => {
  function emptyStreamResponse(status = 200): Response {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    return new Response(stream, { status });
  }

  it("fails closed without any fetch call when Ubuntu config is partial", async () => {
    process.env.UBUNTU_API_BASE_URL = UBU_URL;
    // Missing bearer / CF creds.
    setLegacyEnv();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(backendStreamRequest({ path: "/api/logs/stream" })).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Ubuntu transport with auth + SSE headers when configured (legacy present, ignored)", async () => {
    setUbuntuEnv();
    setLegacyEnv();
    const fetchMock = vi.fn().mockResolvedValue(emptyStreamResponse(200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await backendStreamRequest({ path: "/api/logs/stream" });
    expect(res.transport).toBe("ubuntu");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(UBU_URL)).toBe(true);
    expect(url).not.toContain(LEG_URL);
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${UBU_BEARER}`);
    expect(h["CF-Access-Client-Id"]).toBe(CF_ID);
    expect(h.Accept).toBe("text/event-stream");
  });

  it("uses legacy transport (API_BASE_URL + API_BEARER_TOKEN) without CF-Access headers", async () => {
    setLegacyEnv();
    const fetchMock = vi.fn().mockResolvedValue(emptyStreamResponse(200));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await backendStreamRequest({ path: "/api/logs/stream" });
    expect(res.transport).toBe("legacy");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LEG_URL}/api/logs/stream`);
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${LEG_BEARER}`);
    expect(h["CF-Access-Client-Id"]).toBeUndefined();
    expect(h.Accept).toBe("text/event-stream");
  });

  it("does NOT fall back to legacy after Ubuntu was chosen (4xx/5xx)", async () => {
    setUbuntuEnv();
    setLegacyEnv();
    for (const status of [404, 500, 503] as const) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("no", { status }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      await expect(backendStreamRequest({ path: "/api/logs/stream" })).rejects.toMatchObject({
        status,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).not.toContain(LEG_URL);
    }
  });
});
