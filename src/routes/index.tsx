import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { defaultCriteriaQuery } from "@/queries/settings.queries";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import {
  backendSearch,
  backendSearchBatch,
  backendGenerateReport,
  backendListRecords,
  backendJobStatus,
  backendParseClientMessage,
  backendSourceCapabilities,
  type BackendSearchResponse,
  type BackendRecordSummary,
  type BackendBatchJob,
} from "@/functions/backend.functions";
import { useBatchJobsPolling, isTerminalStatus } from "@/hooks/use-batch-jobs-polling";
import type { AnalyzedLot, CarLot, ClientCriteria } from "@/lib/types";
import {
  auctionSourceLabel,
  DEFAULT_AUCTION_SOURCES,
  getUnavailableAuctionSources,
  normalizeAuctionSources,
} from "@/lib/auction-sources";
import { RERUN_CRITERIA_KEY, toRerunCriteria } from "@/lib/rerun-criteria";

import { ClientMessageCard, type ParseError } from "@/components/panels/client-message-card";

import { CriteriaForm } from "@/components/panels/criteria-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Loader2,
  ExternalLink,
  FileText,
  Mail,
  RefreshCcw,
  Plus,
  X,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "USA Car Finder — panel operatora" },
      {
        name: "description",
        content: "Wyszukiwanie i analiza AI ofert z aukcji Copart, IAAI i Manheim.",
      },
    ],
  }),
  component: HomePage,
});

// ---------------- helpers ----------------

const REPORT_MODES = [
  { id: "client-html", label: "Raport klienta (HTML)", icon: FileText },
  { id: "broker-html", label: "Raport brokera (HTML)", icon: FileText },
  { id: "client-llm", label: "Raport klienta (LLM)", icon: FileText },
  { id: "broker-llm", label: "Raport brokera (LLM)", icon: FileText },
  { id: "offer-email-html", label: "E-mail ofertowy", icon: Mail },
] as const;
type ReportMode = (typeof REPORT_MODES)[number]["id"];

function recommendationTone(r?: string) {
  const v = (r ?? "").toUpperCase();
  if (v === "POLECAM") return "bg-emerald-500/15 text-emerald-500 border-emerald-500/30";
  if (v === "RYZYKO") return "bg-amber-500/15 text-amber-500 border-amber-500/30";
  if (v === "ODRZUĆ" || v === "ODRZUC") return "bg-rose-500/15 text-rose-500 border-rose-500/30";
  return "bg-muted text-muted-foreground border-border";
}

function fmtUsd(v?: number | null) {
  if (v == null) return "—";
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function openHtmlInNewTab(html: string) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank", "noopener,noreferrer");
  if (!w) {
    toast.error("Przeglądarka zablokowała nowe okno.");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Backend zwraca lekki `CarLot[]` (listings) — analiza dogrywana asynchronicznie,
// dlatego traktujemy każdą pozycję jako AnalyzedLot (analiza opcjonalna).
type SearchResult =
  | { kind: "listings"; lots: CarLot[]; source: BackendSearchResponse["source"]; jobId: string }
  | { kind: "analyzed"; lots: AnalyzedLot[]; jobId: string };

function normalizeResponse(res: BackendSearchResponse): SearchResult {
  if (res.analyzed_lots && res.analyzed_lots.length > 0) {
    return { kind: "analyzed", lots: res.analyzed_lots, jobId: res.job_id };
  }
  return { kind: "listings", lots: res.listings ?? [], source: res.source, jobId: res.job_id };
}

// ---------------- page ----------------

function buildAuctionExtras(
  disable: boolean,
  minH: number | "",
  maxH: number | "",
): { disable_auction_filter?: boolean; auction_min_hours?: number; auction_max_hours?: number } {
  const out: {
    disable_auction_filter?: boolean;
    auction_min_hours?: number;
    auction_max_hours?: number;
  } = {};
  if (disable) out.disable_auction_filter = true;
  if (typeof minH === "number" && Number.isFinite(minH)) out.auction_min_hours = minH;
  if (typeof maxH === "number" && Number.isFinite(maxH)) out.auction_max_hours = maxH;
  return out;
}

function labelForCriteria(c: ClientCriteria): string {
  const parts = [c.make, c.model].filter(Boolean).join(" ");
  const years =
    c.year_from || c.year_to ? ` ${c.year_from ?? ""}${c.year_to ? `-${c.year_to}` : ""}` : "";
  return `${parts}${years}`.trim() || "—";
}

type BatchEntry = {
  jobId: string;
  label: string;
  criteria: ClientCriteria;
  idempotent?: boolean;
  /** status znany już w chwili POST /api/search/batch (np. reused done) */
  initialStatus?: string;
};

function HomePage() {
  const runSearch = useServerFn(backendSearch);
  const runBatch = useServerFn(backendSearchBatch);
  const genReport = useServerFn(backendGenerateReport);
  const loadRecords = useServerFn(backendListRecords);
  const backendJobStatusFn = useServerFn(backendJobStatus);
  const parseMessageFn = useServerFn(backendParseClientMessage);
  const loadSourceCapabilities = useServerFn(backendSourceCapabilities);
  const capabilitiesQ = useQuery({
    queryKey: ["backend", "source-capabilities"],
    queryFn: () => loadSourceCapabilities(),
    staleTime: 30_000,
    retry: 1,
  });

  const [criteria, setCriteria] = useState<ClientCriteria>({
    make: "",
    model: "",
    year_from: null,
    year_to: null,
    budget_usd: null,
    max_odometer_mi: null,
    fuel_type: null,
    excluded_damage_types: [],
    max_results: 15,
    sources: [...DEFAULT_AUCTION_SOURCES],
  });

  // Auction window (per-search, poza criteria)
  const [disableAuctionFilter, setDisableAuctionFilter] = useState(false);
  const [auctionMinHours, setAuctionMinHours] = useState<number | "">("");
  const [auctionMaxHours, setAuctionMaxHours] = useState<number | "">("");

  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [clientName, setClientName] = useState("");
  const [reporting, setReporting] = useState<ReportMode | null>(null);

  const [records, setRecords] = useState<BackendRecordSummary[] | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);

  // --- BATCH multi-car ---
  const [batchQueue, setBatchQueue] = useState<ClientCriteria[]>([]);
  const [batchEntries, setBatchEntries] = useState<BatchEntry[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);

  // Prefill formularza z /api/settings/default-criteria — tylko przy pierwszym udanym pobraniu,
  // przed ewentualnym nadpisaniem z rozpoznanej wiadomości klienta.
  const defaultsQ = useQuery(defaultCriteriaQuery());
  const prefilledRef = useRef(false);

  // Rerun z rekordu: RecordDetailView zapisuje kryteria w sessionStorage pod
  // RERUN_CRITERIA_KEY. Ma priorytet nad defaultsQ — konsumujemy raz przy
  // mounting i ustawiamy `prefilledRef`, żeby defaults nie nadpisały.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(RERUN_CRITERIA_KEY);
      if (raw) window.sessionStorage.removeItem(RERUN_CRITERIA_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const cc = toRerunCriteria(parsed);
    if (!cc) return;
    prefilledRef.current = true;
    setCriteria(cc);
    toast.info('Załadowano kryteria z rekordu — sprawdź i kliknij "🔎 Wyszukaj".');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (prefilledRef.current) return;
    if (!defaultsQ.data) return;
    // Druga blokada: nie nadpisuj, jeśli criteria zostało już ustawione z innego źródła
    // (parse wiadomości klienta, ręczna edycja użytkownika) zanim query się rozwiązało.
    const pristine =
      (criteria.make ?? "") === "" &&
      (criteria.model ?? "") === "" &&
      criteria.year_from == null &&
      criteria.year_to == null &&
      criteria.budget_usd == null &&
      criteria.max_odometer_mi == null &&
      criteria.fuel_type == null &&
      (criteria.excluded_damage_types ?? []).length === 0;
    if (!pristine) {
      prefilledRef.current = true; // nie próbuj już nigdy — user/parse wygrał wyścig
      return;
    }
    prefilledRef.current = true;
    const d = defaultsQ.data;
    const fuel = d.fuel_type as ClientCriteria["fuel_type"] | null;
    setCriteria((prev) => ({
      ...prev,
      make: d.make ?? prev.make ?? "",
      model: d.model ?? prev.model ?? "",
      year_from: d.year_from ?? prev.year_from ?? null,
      year_to: d.year_to ?? prev.year_to ?? null,
      budget_usd: d.budget_usd ?? prev.budget_usd ?? null,
      max_odometer_mi: d.max_odometer_mi ?? prev.max_odometer_mi ?? null,
      fuel_type: fuel ?? prev.fuel_type ?? null,
      excluded_damage_types:
        d.excluded_damage_types && d.excluded_damage_types.length > 0
          ? d.excluded_damage_types
          : (prev.excluded_damage_types ?? []),
      max_results: d.max_results ?? prev.max_results ?? 15,
      sources: normalizeAuctionSources(d.sources ?? prev.sources),
    }));
  }, [defaultsQ.data, criteria]);

  // --- Parse client message ---
  const [clientMessage, setClientMessage] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsedList, setParsedList] = useState<ClientCriteria[]>([]);
  const [parseSummary, setParseSummary] = useState("");
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [parseError, setParseError] = useState<ParseError | null>(null);
  const [parseSelected, setParseSelected] = useState<Record<number, boolean>>({});

  async function onParseMessage() {
    if (!clientMessage.trim()) return;
    setParsing(true);
    setParseError(null);
    try {
      const res = await parseMessageFn({ data: { message: clientMessage } });
      if (!res.ok) {
        setParsedList([]);
        setParseSummary("");
        setParseWarnings([]);
        setParseSelected({});
        setParseError({ status: res.status, detail: res.detail });
        return;
      }
      const list = (res.criteria_list ?? [])
        .filter((c): c is ClientCriteria => !!c)
        .map((c) => ({ ...c, sources: normalizeAuctionSources(c.sources) }));
      setParsedList(list);
      setParseSummary(res.summary || "");
      setParseWarnings(res.warnings || []);
      setParseSelected(Object.fromEntries(list.map((_, i) => [i, true])));
      if (list.length === 0) {
        setParseError({ status: 400, detail: "Nie rozpoznano żadnego auta." });
        return;
      }
      if (list.length === 1) {
        setCriteria({
          make: list[0].make ?? "",
          model: list[0].model ?? "",
          year_from: list[0].year_from ?? null,
          year_to: list[0].year_to ?? null,
          budget_usd: list[0].budget_usd ?? null,
          max_odometer_mi: list[0].max_odometer_mi ?? null,
          fuel_type: list[0].fuel_type ?? null,
          excluded_damage_types: list[0].excluded_damage_types ?? [],
          max_results: list[0].max_results ?? 15,
          sources: normalizeAuctionSources(list[0].sources),
        });
        toast.success(`Rozpoznano: ${list[0].make ?? "?"} ${list[0].model ?? ""}`);
      } else {
        toast.success(`Rozpoznano ${list.length} aut. Zaznacz i kliknij „Szukaj zaznaczone".`);
      }
    } catch (e) {
      const err = e as { message?: string };
      setParseError({ status: 500, detail: err.message ?? "Nieznany błąd" });
    } finally {
      setParsing(false);
    }
  }

  function toggleParseSelected(idx: number) {
    setParseSelected((s) => ({ ...s, [idx]: !s[idx] }));
  }

  function clearParsed() {
    setParsedList([]);
    setParseSummary("");
    setParseWarnings([]);
    setParseError(null);
    setParseSelected({});
    setClientMessage("");
  }

  async function onSearchParsedSelected() {
    const chosen = parsedList.filter((_, i) => parseSelected[i]);
    if (chosen.length === 0) {
      toast.error("Zaznacz przynajmniej jedno auto.");
      return;
    }
    if (chosen.length === 1) {
      setCriteria({
        make: chosen[0].make ?? "",
        model: chosen[0].model ?? "",
        year_from: chosen[0].year_from ?? null,
        year_to: chosen[0].year_to ?? null,
        budget_usd: chosen[0].budget_usd ?? null,
        max_odometer_mi: chosen[0].max_odometer_mi ?? null,
        fuel_type: chosen[0].fuel_type ?? null,
        excluded_damage_types: chosen[0].excluded_damage_types ?? [],
        max_results: chosen[0].max_results ?? 15,
        sources: normalizeAuctionSources(chosen[0].sources),
      });
      toast.info('Kryteria załadowane do formularza — kliknij "🔎 Wyszukaj".');
      return;
    }
    // wiele aut → batch; kolejka pokaże niedostępne źródła i pozwoli je naprawić.
    const unavailableMessage = unavailableSourcesMessage(...chosen);
    setBatchQueue(chosen);
    setBatchEntries([]);
    if (unavailableMessage) {
      toast.warning(`${unavailableMessage} Popraw źródła w kolejce przed uruchomieniem batcha.`);
    } else {
      toast.success(`Dodano ${chosen.length} aut do batcha — kliknij "Wyszukaj wszystkie".`);
    }
  }

  const listings: CarLot[] = useMemo(() => {
    if (!result) return [];
    return result.kind === "analyzed" ? result.lots.map((a) => a.lot) : result.lots;
  }, [result]);

  const analyzedByLotId: Record<string, AnalyzedLot | undefined> = useMemo(() => {
    if (!result || result.kind !== "analyzed") return {};
    return Object.fromEntries(result.lots.map((a) => [a.lot.lot_id, a]));
  }, [result]);

  function unavailableSourcesMessage(...values: ClientCriteria[]): string | null {
    const unavailable = Array.from(
      new Set(
        values.flatMap((value) => getUnavailableAuctionSources(value.sources, capabilitiesQ.data)),
      ),
    );
    if (unavailable.length === 0) return null;
    return `Niedostępne źródła: ${unavailable.map(auctionSourceLabel).join(", ")}. Sprawdź konfigurację backendu.`;
  }

  async function onSearch() {
    if (!criteria.make.trim()) {
      toast.error("Podaj markę pojazdu.");
      return;
    }
    if (!criteria.sources || criteria.sources.length === 0) {
      toast.error("Wybierz co najmniej jedno źródło aukcji.");
      return;
    }
    const unavailableMessage = unavailableSourcesMessage(criteria);
    if (unavailableMessage) {
      toast.error(unavailableMessage);
      return;
    }
    setLoading(true);
    setLoadingMsg("Trwa wyszukiwanie i analiza AI… to może potrwać kilka minut.");
    setResult(null);
    setSelected({});
    try {
      const auctionExtras = buildAuctionExtras(
        disableAuctionFilter,
        auctionMinHours,
        auctionMaxHours,
      );
      const res = await runSearch({ data: { criteria, ...auctionExtras } });
      const initial = normalizeResponse(res);
      setResult(initial);
      const total = res.analyzed_lots?.length ?? res.listings?.length ?? 0;
      if (total === 0) {
        toast.info("Nie znaleziono aukcji spełniających kryteria.");
      } else {
        toast.success(`Znaleziono ${total} ofert.`);
      }
      if (res.analysis_notice) toast.message(res.analysis_notice);

      // Jeśli backend zwrócił tylko listings — dopytaj job o analyzed_lots.
      if (initial.kind === "listings" && res.job_id) {
        void pollAnalysis(res.job_id);
      }
    } catch (e) {
      const err = e as { message?: string; status?: number };
      toast.error(err.message || "Błąd wyszukiwania.");
    } finally {
      setLoading(false);
      setLoadingMsg("");
    }
  }

  async function pollAnalysis(jobId: string) {
    const deadline = Date.now() + 4 * 60 * 1000;
    let delay = 4000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 1000, 10000);
      try {
        const s = await backendJobStatusFn({ data: { jobId } });
        if (s.analyzed_lots && s.analyzed_lots.length > 0) {
          setResult({ kind: "analyzed", lots: s.analyzed_lots, jobId });
          return;
        }
        if (["done", "completed", "failed", "error", "cancelled"].includes(s.status)) return;
      } catch {
        // ignoruj — spróbujemy jeszcze raz
      }
    }
  }

  function addCurrentToBatch() {
    if (!criteria.make.trim()) {
      toast.error("Podaj markę zanim dodasz do batcha.");
      return;
    }
    if (!criteria.sources || criteria.sources.length === 0) {
      toast.error("Wybierz co najmniej jedno źródło aukcji.");
      return;
    }
    const unavailableMessage = unavailableSourcesMessage(criteria);
    if (unavailableMessage) {
      toast.error(unavailableMessage);
      return;
    }
    setBatchQueue((q) => [...q, { ...criteria }]);
    toast.success(`Dodano do batcha: ${labelForCriteria(criteria)}`);
  }

  function removeFromQueue(idx: number) {
    setBatchQueue((q) => q.filter((_, i) => i !== idx));
  }

  function removeUnavailableSourcesFromQueue(idx: number) {
    const entry = batchQueue[idx];
    if (!entry) return;
    const unavailable = new Set(getUnavailableAuctionSources(entry.sources, capabilitiesQ.data));
    const sources = (entry.sources ?? DEFAULT_AUCTION_SOURCES).filter(
      (source) => !unavailable.has(source),
    );
    if (sources.length === 0) {
      setCriteria({ ...entry, sources: normalizeAuctionSources(entry.sources) });
      removeFromQueue(idx);
      toast.info("Przeniesiono kryteria do formularza — odznacz niedostępne źródło.");
      return;
    }
    setBatchQueue((queue) =>
      queue.map((item, itemIndex) => (itemIndex === idx ? { ...item, sources } : item)),
    );
    toast.success("Usunięto niedostępne źródła z wpisu batcha.");
  }

  async function runBatchSearch() {
    if (batchQueue.length === 0) {
      toast.error("Batch jest pusty — najpierw dodaj kryteria.");
      return;
    }
    if (batchQueue.length > 20) {
      toast.error("Max 20 wyszukiwań w jednym batchu.");
      return;
    }
    if (batchQueue.some((entry) => !entry.sources || entry.sources.length === 0)) {
      toast.error("Każde wyszukiwanie musi mieć co najmniej jedno źródło aukcji.");
      return;
    }
    const unavailableMessage = unavailableSourcesMessage(...batchQueue);
    if (unavailableMessage) {
      toast.error(unavailableMessage);
      return;
    }
    setBatchRunning(true);
    setBatchEntries([]);
    try {
      const auctionExtras = buildAuctionExtras(
        disableAuctionFilter,
        auctionMinHours,
        auctionMaxHours,
      );
      const res = await runBatch({
        data: { searches: batchQueue.map((c) => ({ criteria: c, ...auctionExtras })) },
      });
      const initial: BatchEntry[] = res.jobs.map((j: BackendBatchJob, i: number) => ({
        jobId: j.job_id,
        label: j.label || labelForCriteria(batchQueue[i]),
        criteria: batchQueue[i],
        initialStatus: j.reused_status || "queued",
        idempotent: j.idempotent,
      }));
      setBatchEntries(initial);
      toast.success(`Batch wystartował: ${res.jobs.length} jobów (queued: ${res.queued_count}).`);
      // polling od teraz obsługuje useBatchJobsPolling(activeJobIds)
    } catch (e) {
      const err = e as { message?: string };
      toast.error(err.message || "Błąd batcha.");
    } finally {
      setBatchRunning(false);
    }
  }

  async function retryFailedBatch() {
    const failed = batchEntries.filter((e) =>
      !isTerminalStatus(batchJobs[e.jobId]?.status)
        ? false
        : ["error", "failed", "cancelled", "interrupted"].includes(
            batchJobs[e.jobId]?.status || "",
          ),
    );
    if (failed.length === 0) {
      toast.info("Brak jobów do ponowienia.");
      return;
    }
    const unavailableMessage = unavailableSourcesMessage(...failed.map((entry) => entry.criteria));
    if (unavailableMessage) {
      toast.error(unavailableMessage);
      return;
    }
    setBatchRunning(true);
    try {
      const auctionExtras = buildAuctionExtras(
        disableAuctionFilter,
        auctionMinHours,
        auctionMaxHours,
      );
      const res = await runBatch({
        data: { searches: failed.map((e) => ({ criteria: e.criteria, ...auctionExtras })) },
      });
      const newByOldJobId = new Map<string, BatchEntry>();
      res.jobs.forEach((j: BackendBatchJob, i: number) => {
        const old = failed[i];
        newByOldJobId.set(old.jobId, {
          jobId: j.job_id,
          label: j.label || old.label,
          criteria: old.criteria,
          initialStatus: j.reused_status || "queued",
          idempotent: j.idempotent,
        });
      });
      setBatchEntries((entries) => entries.map((e) => newByOldJobId.get(e.jobId) ?? e));
      toast.success(`Ponowiono ${res.jobs.length} jobów.`);
    } catch (e) {
      const err = e as { message?: string };
      toast.error(err.message || "Błąd ponowienia batcha.");
    } finally {
      setBatchRunning(false);
    }
  }

  function loadBatchResultsIntoView() {
    const all = batchEntries.flatMap((e) => batchJobs[e.jobId]?.analyzed_lots ?? []);
    if (all.length === 0) {
      toast.error("Batch nie zwrócił jeszcze wyników.");
      return;
    }
    setResult({ kind: "analyzed", lots: all, jobId: batchEntries.map((e) => e.jobId).join(",") });
    setSelected({});
    toast.success(`Załadowano ${all.length} wyników do widoku raportów.`);
  }

  function clearBatch() {
    setBatchEntries([]);
    setBatchQueue([]);
  }

  // JEDEN interval na cały batch. Zwraca też agregaty (done/running/queued/errored/interrupted).
  const activeJobIds = useMemo(() => batchEntries.map((e) => e.jobId), [batchEntries]);
  const {
    jobs: batchJobs,
    done: batchDone,
    running: batchRunningCount,
    queued: batchQueuedCount,
    errored: batchErroredCount,
    interrupted: batchInterruptedCount,
    allFinished: batchAllFinished,
  } = useBatchJobsPolling(activeJobIds);

  const failedJobIds = useMemo(
    () =>
      batchEntries
        .filter((e) => {
          const s = batchJobs[e.jobId]?.status;
          return s === "error" || s === "failed" || s === "cancelled" || s === "interrupted";
        })
        .map((e) => e.jobId),
    [batchEntries, batchJobs],
  );

  function toggleSelected(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }

  function selectAll(v: boolean) {
    setSelected(v ? Object.fromEntries(listings.map((l) => [l.lot_id, true])) : {});
  }

  async function onGenerateReport(mode: ReportMode) {
    const chosen = listings.filter((l) => selected[l.lot_id]);
    if (chosen.length === 0) {
      toast.error("Zaznacz przynajmniej jedno auto.");
      return;
    }
    setReporting(mode);
    try {
      const approved_lots = chosen.map((lot) => {
        const a = analyzedByLotId[lot.lot_id];
        return a ? { ...a, included_in_report: true } : { lot, included_in_report: true };
      });
      const { html } = await genReport({
        data: {
          mode,
          approved_lots,
          criteria,
          client_name: clientName || undefined,
        },
      });
      openHtmlInNewTab(html);
      toast.success("Raport wygenerowany.");
    } catch (e) {
      const err = e as { message?: string };
      toast.error(err.message || "Błąd generowania raportu.");
    } finally {
      setReporting(null);
    }
  }

  async function onLoadRecords() {
    setRecordsLoading(true);
    try {
      const res = await loadRecords();
      const list = (res as unknown as { records?: BackendRecordSummary[] }).records ?? [];
      setRecords(list);
    } catch (e) {
      const err = e as { message?: string };
      toast.error(err.message || "Nie udało się pobrać historii.");
    } finally {
      setRecordsLoading(false);
    }
  }

  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      {/* Parser wiadomości klienta */}
      <ClientMessageCard
        clientMessage={clientMessage}
        setClientMessage={setClientMessage}
        parsing={parsing}
        parsedList={parsedList}
        summary={parseSummary}
        warnings={parseWarnings}
        error={parseError}
        selected={parseSelected}
        toggleSelected={toggleParseSelected}
        onParse={onParseMessage}
        onSearchSelected={onSearchParsedSelected}
        onClear={clearParsed}
        disabled={loading || batchRunning}
      />

      {/* Formularz kryteriów */}
      <Card className="p-4">
        <CriteriaForm
          criteria={criteria}
          setCriteria={setCriteria}
          capabilities={capabilitiesQ.data}
          capabilitiesLoading={capabilitiesQ.isLoading}
        />
        <Separator className="my-4" />
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Okno aukcji (opcjonalnie)
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Min. godzin do aukcji
              </label>
              <Input
                type="number"
                min={0}
                className="w-32"
                placeholder="12"
                value={auctionMinHours}
                onChange={(e) =>
                  setAuctionMinHours(e.target.value === "" ? "" : Math.max(0, +e.target.value))
                }
                disabled={disableAuctionFilter}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Max. godzin do aukcji
              </label>
              <Input
                type="number"
                min={0}
                className="w-32"
                placeholder="120"
                value={auctionMaxHours}
                onChange={(e) =>
                  setAuctionMaxHours(e.target.value === "" ? "" : Math.max(0, +e.target.value))
                }
                disabled={disableAuctionFilter}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={disableAuctionFilter}
                onChange={(e) => setDisableAuctionFilter(e.target.checked)}
              />
              Wyłącz filtr okna aukcji (pokaż też przyszłe / spoza okna)
            </label>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Domyślnie backend zawęża do 12–120 h. Puste pola = domyślne wartości backendu.
          </p>
        </div>
        <Separator className="my-4" />
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Klient (opcjonalnie — trafi na raport)
            </label>
            <Input
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Jan Kowalski"
            />
          </div>
          <Button
            size="lg"
            onClick={onSearch}
            disabled={loading || batchRunning}
            className="min-w-[180px]"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Szukam…
              </>
            ) : (
              "🔎 Wyszukaj"
            )}
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={addCurrentToBatch}
            disabled={loading || batchRunning}
            title="Dodaj bieżące kryteria do batcha (max 20)"
          >
            <Plus className="mr-2 h-4 w-4" /> Dodaj do batcha
          </Button>
        </div>
      </Card>

      {/* Batch multi-car */}
      {(batchQueue.length > 0 || batchEntries.length > 0) && (
        <Card className="p-4 border-primary/30">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">📦</span>
              <h2 className="text-lg font-semibold">
                Batch wyszukiwanie
                {batchEntries.length > 0 && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {batchDone}/{batchEntries.length} gotowe
                  </Badge>
                )}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              {batchEntries.length === 0 && batchQueue.length > 0 && (
                <Button
                  size="sm"
                  onClick={runBatchSearch}
                  disabled={batchRunning || batchQueue.length === 0 || batchQueue.length > 20}
                >
                  {batchRunning ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <>🚀 </>}
                  Wyszukaj wszystkie ({batchQueue.length})
                </Button>
              )}
              {batchEntries.length > 0 && batchAllFinished && (
                <Button size="sm" onClick={loadBatchResultsIntoView}>
                  Załaduj wyniki do widoku
                </Button>
              )}
              {!batchRunning && failedJobIds.length > 0 && (
                <Button size="sm" variant="secondary" onClick={retryFailedBatch}>
                  🔁 Ponów nieudane ({failedJobIds.length})
                </Button>
              )}
              {!batchRunning && (
                <Button size="sm" variant="ghost" onClick={clearBatch}>
                  <X className="mr-1 h-3 w-3" /> Wyczyść
                </Button>
              )}
            </div>
          </div>

          {batchEntries.length > 0 &&
            (() => {
              const total = batchEntries.length;
              const failedTotal = batchErroredCount + batchInterruptedCount;
              const pct = Math.round((batchDone / total) * 100);
              return (
                <div className="mb-3">
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      {pct}% ({batchDone}/{total})
                    </span>
                    {batchRunningCount > 0 && (
                      <span className="text-primary">▶ {batchRunningCount} w toku</span>
                    )}
                    {batchQueuedCount > 0 && <span>⏳ {batchQueuedCount} w kolejce</span>}
                    {failedTotal > 0 && (
                      <span className="text-destructive">
                        ✕ {failedTotal} nieudane
                        {batchInterruptedCount > 0
                          ? ` (w tym ${batchInterruptedCount} przerwane restartem)`
                          : ""}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

          {batchEntries.length === 0 ? (
            <ul className="space-y-1">
              {batchQueue.map((c, i) => {
                const sources = c.sources ?? DEFAULT_AUCTION_SOURCES;
                const unavailable = getUnavailableAuctionSources(sources, capabilitiesQ.data);
                const hasAvailableSource = sources.some((source) => !unavailable.includes(source));
                return (
                  <li
                    key={i}
                    className={`flex items-center justify-between gap-3 rounded border p-2 text-sm ${
                      unavailable.length > 0 ? "border-destructive/40" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <span>
                        {i + 1}. {labelForCriteria(c)}
                        {c.budget_usd ? ` · budżet $${c.budget_usd.toLocaleString()}` : ""}
                        {` · źródła: ${sources.map(auctionSourceLabel).join(", ")}`}
                      </span>
                      {unavailable.length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive">
                          <span>Niedostępne: {unavailable.map(auctionSourceLabel).join(", ")}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            onClick={() => removeUnavailableSourcesFromQueue(i)}
                          >
                            {hasAvailableSource ? "Usuń niedostępne" : "Edytuj w formularzu"}
                          </Button>
                        </div>
                      )}
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeFromQueue(i)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </li>
                );
              })}
              {batchQueue.length > 20 && (
                <li className="text-xs text-destructive">Max 20 — usuń nadmiar.</li>
              )}
            </ul>
          ) : (
            <ul className="space-y-1">
              {batchEntries.map((e) => {
                const live = batchJobs[e.jobId];
                const status = live?.status ?? e.initialStatus ?? "queued";
                const done = status === "done" || status === "completed";
                const interrupted = status === "interrupted";
                const failed =
                  interrupted ||
                  status === "error" ||
                  status === "failed" ||
                  status === "cancelled";
                const running = status === "running";
                const phase = live?.phase;
                const listingsCount = live?.listings?.length ?? live?.analyzed_lots?.length;
                const backendError = live?.error || undefined;
                const errorMessage = backendError
                  ? backendError
                  : interrupted
                    ? "Zadanie przerwane restartem serwera — spróbuj ponownie."
                    : failed
                      ? live?.message
                      : undefined;
                const errorPhases =
                  failed && Array.isArray(live?.phases)
                    ? (live!.phases as any[]).filter(
                        (p) => p && (p.status === "error" || p.status === "failed" || p.error),
                      )
                    : undefined;
                return (
                  <li
                    key={e.jobId}
                    className={`rounded border p-2 text-sm ${
                      running ? "border-primary/40 bg-primary/5" : ""
                    } ${failed ? "border-destructive/40" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      {done ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                      ) : failed ? (
                        <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                      ) : running ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                      ) : (
                        <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="flex-1 truncate" title={errorMessage ?? ""}>
                        {e.label}
                        {e.idempotent && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            reużyty
                          </Badge>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {status}
                        {phase ? ` · ${phase}` : ""}
                        {listingsCount != null ? ` · ${listingsCount} ofert` : ""}
                      </span>
                    </div>
                    {failed && (errorMessage || errorPhases?.length) && (
                      <details className="mt-2 ml-6">
                        <summary className="cursor-pointer text-xs text-destructive hover:underline">
                          Szczegóły błędu
                        </summary>
                        <div className="mt-1 space-y-1 rounded bg-destructive/5 p-2 text-xs">
                          {errorMessage && (
                            <div>
                              <span className="font-medium">Komunikat:</span>{" "}
                              <span className="text-muted-foreground">{errorMessage}</span>
                            </div>
                          )}
                          {errorPhases?.map((p: any, i: number) => (
                            <div key={i} className="border-l-2 border-destructive/40 pl-2">
                              <span className="font-medium">{p.name || "phase"}</span>
                              {p.status ? ` · ${p.status}` : ""}
                              {(p.message || p.error) && (
                                <div className="text-muted-foreground">{p.message || p.error}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            Backend puszcza scrapy sekwencyjnie (SEARCH_MAX_CONCURRENT=1) — batch tylko oszczędza N
            requestów, nie przyspiesza wykonania.
          </p>
        </Card>
      )}

      {/* Loader */}
      {loading && (
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <div>
              <div className="font-medium">{loadingMsg}</div>
              <div className="text-xs text-muted-foreground">
                Nie zamykaj karty — request idzie do zewnętrznego scrapera + analizy AI.
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Wyniki */}
      {result && !loading && (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">
                Wyniki ({listings.length})
                {result.kind === "listings" && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    źródło: {result.source}
                  </Badge>
                )}
              </h2>
              <p className="text-xs text-muted-foreground">Job ID: {result.jobId}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => selectAll(true)}>
                Zaznacz wszystkie
              </Button>
              <Button variant="outline" size="sm" onClick={() => selectAll(false)}>
                Wyczyść
              </Button>
            </div>
          </div>

          {listings.length === 0 ? (
            <p className="text-sm text-muted-foreground">Brak wyników.</p>
          ) : (
            <div className="space-y-3">
              {listings.map((lot) => {
                const a = analyzedByLotId[lot.lot_id];
                const isSel = !!selected[lot.lot_id];
                return (
                  <div
                    key={`${lot.source}-${lot.lot_id}`}
                    className={`rounded-lg border p-3 transition ${
                      isSel ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    <div className="flex gap-3">
                      <Checkbox
                        checked={isSel}
                        onCheckedChange={() => toggleSelected(lot.lot_id)}
                        className="mt-1"
                      />
                      {lot.images?.[0] && (
                        <img
                          src={lot.images[0]}
                          alt={`${lot.year ?? ""} ${lot.make ?? ""} ${lot.model ?? ""}`}
                          className="h-20 w-28 rounded-md object-cover"
                          loading="lazy"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {lot.year ?? "—"} {lot.make} {lot.model}
                          </span>
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {lot.source}
                          </Badge>
                          {a?.analysis.recommendation && (
                            <Badge
                              variant="outline"
                              className={`text-xs ${recommendationTone(a.analysis.recommendation)}`}
                            >
                              {a.analysis.recommendation}
                              {typeof a.analysis.score === "number" && ` · ${a.analysis.score}/10`}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          VIN: {lot.vin || lot.full_vin || "—"} · Lot: {lot.lot_id} · Przebieg:{" "}
                          {lot.odometer_mi != null ? `${lot.odometer_mi.toLocaleString()} mi` : "—"}{" "}
                          · Uszk.: {lot.damage_primary ?? "—"}
                        </div>
                        <div className="mt-1 text-xs">
                          Bid: <b>{fmtUsd(lot.current_bid_usd)}</b> · Buy now:{" "}
                          <b>{fmtUsd(lot.buy_now_price_usd)}</b>
                          {a?.analysis.estimated_total_cost_usd != null && (
                            <>
                              {" "}
                              · Est. total: <b>{fmtUsd(a.analysis.estimated_total_cost_usd)}</b>
                            </>
                          )}
                        </div>
                        {a?.analysis.client_description_pl && (
                          <p className="mt-2 line-clamp-2 text-sm">
                            {a.analysis.client_description_pl}
                          </p>
                        )}
                        {lot.url && (
                          <a
                            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            href={lot.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3 w-3" /> Zobacz aukcję
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Sekcja raportów */}
          {listings.length > 0 && (
            <>
              <Separator className="my-4" />
              <div className="flex flex-wrap items-center gap-2">
                <div className="mr-2 text-sm">
                  Zaznaczone: <b>{selectedCount}</b> / {listings.length}
                </div>
                {REPORT_MODES.map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    variant="secondary"
                    size="sm"
                    disabled={selectedCount === 0 || reporting !== null}
                    onClick={() => onGenerateReport(id)}
                  >
                    {reporting === id ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <Icon className="mr-2 h-3 w-3" />
                    )}
                    {label}
                  </Button>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* Historia */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Historia wyszukiwań (backend)</h2>
          <Button variant="outline" size="sm" onClick={onLoadRecords} disabled={recordsLoading}>
            {recordsLoading ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCcw className="mr-2 h-3 w-3" />
            )}
            Odśwież
          </Button>
        </div>
        {records == null ? (
          <p className="text-sm text-muted-foreground">
            Kliknij „Odśwież", żeby pobrać listę z <code>/api/records</code>.
          </p>
        ) : records.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak zapisanych rekordów.</p>
        ) : (
          <ul className="divide-y">
            {records.slice(0, 50).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {r.make ?? "—"} {r.model ?? ""}{" "}
                    {r.client_name && (
                      <span className="text-muted-foreground">· {r.client_name}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {r.id} · {r.created_at ?? "—"} · status: {r.status ?? "—"} · ofert:{" "}
                    {r.listings_count ?? "—"}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
