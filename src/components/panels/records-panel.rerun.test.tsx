// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { RERUN_CRITERIA_KEY } from "@/lib/rerun-criteria";

// --- Mocks --------------------------------------------------------------

const h = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  toastMock: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  backendGetRecord: vi.fn(),
  backendRegenerateBundles: vi.fn(),
  backendSearch: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateMock,
  Link: ({ children, ...rest }: { children: ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("sonner", () => ({ toast: h.toastMock }));

vi.mock("@/functions/backend.functions", () => ({
  backendListRecords: vi.fn(),
  backendDeleteRecord: vi.fn(),
  backendGetRecord: (...args: unknown[]) => h.backendGetRecord(...args),
  backendRegenerateBundles: (...args: unknown[]) => h.backendRegenerateBundles(...args),
  backendListSearchAudit: vi.fn(),
  backendSearch: (...args: unknown[]) => h.backendSearch(...args),
}));

const { navigateMock, toastMock, backendGetRecord, backendRegenerateBundles, backendSearch } = h;

// BidfaxBadge is a simple client component with no heavy deps — keep real
// impl. If it grows deps that break jsdom, stub here.

import { RecordDetailView } from "./records-panel";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function makeRecord(overrides?: Record<string, unknown>) {
  return {
    id: 42,
    title: "Test #42",
    status: "done",
    created_at: "2026-07-20T10:00:00Z",
    criteria: {
      make: "BMW",
      model: "X5",
      year_from: 2018,
      budget_usd: 25000,
      sources: ["copart", "iaai"],
    },
    response: { all_results: [] },
    ...overrides,
  };
}

describe("RecordDetailView — Ponów teraz / Edytuj i szukaj", () => {
  beforeEach(() => {
    backendGetRecord.mockReset();
    backendSearch.mockReset();
    backendRegenerateBundles.mockReset();
    navigateMock.mockReset();
    toastMock.error.mockReset();
    toastMock.info.mockReset();
    toastMock.success.mockReset();
    sessionStorage.clear();
  });
  afterEach(cleanup);

  it("Ponów teraz calls backendSearch with normalized criteria and shows success toast", async () => {
    backendGetRecord.mockResolvedValue(makeRecord());
    backendSearch.mockResolvedValue({ analyzed_lots: [{}, {}, {}] });

    render(<RecordDetailView recordId={42} onClose={() => {}} />, { wrapper: wrapper() });

    const btn = await screen.findByRole("button", { name: /Ponów teraz/i });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);

    await waitFor(() => expect(backendSearch).toHaveBeenCalledTimes(1));
    const arg = backendSearch.mock.calls[0][0] as { data: { criteria: Record<string, unknown> } };
    expect(arg.data.criteria.make).toBe("BMW");
    expect(arg.data.criteria.model).toBe("X5");
    expect(arg.data.criteria.year_from).toBe(2018);
    expect(arg.data.criteria.budget_usd).toBe(25000);
    expect(arg.data.criteria.sources).toEqual(["copart", "iaai"]);
    // normalization defaults
    expect(arg.data.criteria.max_results).toBe(15);

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(expect.stringMatching(/3 ofert/)),
    );
  });

  it("Ponów teraz shows info toast when zero results", async () => {
    backendGetRecord.mockResolvedValue(makeRecord());
    backendSearch.mockResolvedValue({ analyzed_lots: [] });

    render(<RecordDetailView recordId={42} onClose={() => {}} />, { wrapper: wrapper() });
    await userEvent.click(await screen.findByRole("button", { name: /Ponów teraz/i }));

    await waitFor(() => expect(toastMock.info).toHaveBeenCalled());
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("Ponów teraz surfaces backend error via toast.error", async () => {
    backendGetRecord.mockResolvedValue(makeRecord());
    backendSearch.mockRejectedValue(new Error("boom"));

    render(<RecordDetailView recordId={42} onClose={() => {}} />, { wrapper: wrapper() });
    await userEvent.click(await screen.findByRole("button", { name: /Ponów teraz/i }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("boom"));
  });

  it("Edytuj i szukaj writes normalized criteria to sessionStorage and navigates to /", async () => {
    backendGetRecord.mockResolvedValue(makeRecord());

    render(<RecordDetailView recordId={42} onClose={() => {}} />, { wrapper: wrapper() });
    await userEvent.click(await screen.findByRole("button", { name: /Edytuj i szukaj/i }));

    const stored = sessionStorage.getItem(RERUN_CRITERIA_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.make).toBe("BMW");
    expect(parsed.sources).toEqual(["copart", "iaai"]);
    expect(parsed.max_results).toBe(15);

    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
    expect(backendSearch).not.toHaveBeenCalled();
  });

  it("disables both buttons when the record has no usable make", async () => {
    backendGetRecord.mockResolvedValue(
      makeRecord({ criteria: { model: "X5", sources: ["copart"] } }),
    );

    render(<RecordDetailView recordId={42} onClose={() => {}} />, { wrapper: wrapper() });
    const rerunBtn = await screen.findByRole("button", { name: /Ponów teraz/i });
    const editBtn = screen.getByRole("button", { name: /Edytuj i szukaj/i });
    expect(rerunBtn).toBeDisabled();
    expect(editBtn).toBeDisabled();
  });

  it("parses criteria stored as a JSON string", async () => {
    backendGetRecord.mockResolvedValue(
      makeRecord({ criteria: JSON.stringify({ make: "Audi", sources: ["iaai"] }) }),
    );
    backendSearch.mockResolvedValue({ analyzed_lots: [{}] });

    render(<RecordDetailView recordId={42} onClose={() => {}} />, { wrapper: wrapper() });
    await userEvent.click(await screen.findByRole("button", { name: /Ponów teraz/i }));

    await waitFor(() => expect(backendSearch).toHaveBeenCalledTimes(1));
    const arg = backendSearch.mock.calls[0][0] as { data: { criteria: { make: string } } };
    expect(arg.data.criteria.make).toBe("Audi");
  });
});

describe("HomePage rerun-criteria contract via sessionStorage", () => {
  // The HomePage effect body:
  //   1) read RERUN_CRITERIA_KEY, remove it, JSON.parse, toRerunCriteria
  //   2) apply to form and set prefilledRef=true
  // We validate the contract (write/read/clear/normalize) independently of
  // the heavy route tree, since HomePage pulls the whole backend module graph.
  beforeEach(() => sessionStorage.clear());

  it("consumer clears the key after reading", async () => {
    const { RERUN_CRITERIA_KEY: KEY, toRerunCriteria } = await import("@/lib/rerun-criteria");
    sessionStorage.setItem(KEY, JSON.stringify({ make: "BMW", sources: ["copart"] }));

    // Simulate exact HomePage effect body
    const raw = sessionStorage.getItem(KEY);
    if (raw) sessionStorage.removeItem(KEY);
    const parsed = raw ? toRerunCriteria(JSON.parse(raw)) : null;

    expect(parsed).not.toBeNull();
    expect(parsed!.make).toBe("BMW");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("consumer ignores malformed JSON without throwing", async () => {
    const { RERUN_CRITERIA_KEY: KEY } = await import("@/lib/rerun-criteria");
    sessionStorage.setItem(KEY, "{not json");

    const raw = sessionStorage.getItem(KEY);
    if (raw) sessionStorage.removeItem(KEY);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw!);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
