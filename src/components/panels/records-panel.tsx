import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, RefreshCw, Trash2, Play, PenLine } from "lucide-react";

import {
  backendListRecords,
  backendDeleteRecord,
  backendGetRecord,
  backendRegenerateBundles,
  backendListSearchAudit,
  backendSearch,
} from "@/functions/backend.functions";
import type { BackendRecord, SearchAuditEntry } from "@/functions/backend.functions";
import { SITE_USERS } from "@/lib/site-user";
import { RERUN_CRITERIA_KEY, toRerunCriteria } from "@/lib/rerun-criteria";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BidfaxBadge } from "@/components/BidfaxBadge";

export function getRecordSearchedBy(r: any): string | null {
  return r?.searched_by ?? r?.criteria?.searched_by ?? r?.meta?.searched_by ?? null;
}

export function formatTimeUntilAuction(
  auctionDate?: string | null,
): { text: string; variant: "default" | "warning" | "danger" | "muted" } | null {
  if (!auctionDate) return null;
  const dt = new Date(auctionDate.replace(" ", "T") + "Z");
  if (isNaN(dt.getTime())) return null;
  const diffMs = dt.getTime() - Date.now();
  if (diffMs < 0) return { text: "🏁 zakończona", variant: "muted" };
  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (totalMins < 60) return { text: `⚠️ za ${totalMins}min`, variant: "danger" };
  if (totalMins < 24 * 60) return { text: `⏰ za ${hours}h ${mins}min`, variant: "danger" };
  if (days < 3) return { text: `⏰ za ${days}d ${hours}h`, variant: "warning" };
  return { text: `⏰ za ${days} dni`, variant: "default" };
}

export function BackendRecordsPanel({
  activeRecordId,
  onSelectRecord,
}: {
  activeRecordId: number | null;
  onSelectRecord: (id: number) => void;
}) {
  const fnListBackend = useServerFn(backendListRecords);
  const fnDeleteBackend = useServerFn(backendDeleteRecord);
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("default");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const { data: recordsData, isLoading, refetch } = useQuery({
    queryKey: ["backend-records", statusFilter],
    queryFn: () => fnListBackend({ data: { limit: 100, status: statusFilter || undefined } }),
    refetchInterval: 30000,
  });

  const allRecords = recordsData?.records ?? [];
  const records = allRecords.filter((r) => {
    if (userFilter === "all") return true;
    const sb = getRecordSearchedBy(r);
    if (userFilter === "__none__") return !sb;
    return sb === userFilter;
  });
  const sortedRecords = [...records].sort((a, b) => {
    switch (sortBy) {
      case "searched_by_asc": {
        const sa = getRecordSearchedBy(a) ?? "";
        const sb = getRecordSearchedBy(b) ?? "";
        return sa.localeCompare(sb);
      }
      case "searched_by_desc": {
        const sa = getRecordSearchedBy(a) ?? "";
        const sb = getRecordSearchedBy(b) ?? "";
        return sb.localeCompare(sa);
      }
      case "date_asc":
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      case "date_desc":
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      default:
        return 0;
    }
  });
  const total = recordsData?.total ?? 0;

  const filters = [
    { value: "", label: "Wszystkie" },
    { value: "done", label: "✅ Ukończone" },
    { value: "cancelled", label: "⛔ Anulowane" },
    { value: "error", label: "❌ Błędy" },
    { value: "interrupted", label: "⚠️ Przerwane" },
  ];

  async function handleDelete(r: BackendRecord) {
    if (!confirm(`Usunąć rekord "${r.title}"? Tej operacji nie można cofnąć.`)) return;
    setDeletingId(r.id);
    try {
      const res = await fnDeleteBackend({ data: { id: String(r.id) } });
      if (res.ok) {
        toast.success(`Usunięto rekord (pliki: ${res.files_removed})`);
        await queryClient.invalidateQueries({ queryKey: ["backend-records"] });
      } else {
        toast.error(`Nie usunięto: ${res.detail}`);
      }
    } catch (e: any) {
      toast.error(`Błąd: ${e?.message ?? "nieznany"}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          📂 Rekordy backendu ({records.length}/{total})
        </h2>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {filters.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={statusFilter === f.value ? "default" : "ghost"}
            className="h-6 px-2 text-[10px]"
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>
      <div className="mb-2">
        <Select value={userFilter} onValueChange={setUserFilter}>
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue placeholder="Filtruj po użytkowniku" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">👥 Wszyscy użytkownicy</SelectItem>
            {SITE_USERS.map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
            <SelectItem value="__none__">— Bez przypisania</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mb-2">
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue placeholder="Sortuj" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">📋 Domyślnie</SelectItem>
            <SelectItem value="searched_by_asc">👤 Zrobione przez (A-Z)</SelectItem>
            <SelectItem value="searched_by_desc">👤 Zrobione przez (Z-A)</SelectItem>
            <SelectItem value="date_desc">📅 Data (od najnowszych)</SelectItem>
            <SelectItem value="date_asc">📅 Data (od najstarszych)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="max-h-[600px] overflow-auto space-y-1">
        {!sortedRecords.length && !isLoading && (
          <div className="text-sm text-muted-foreground italic py-8 text-center">
            Brak rekordów{statusFilter ? ` o statusie "${statusFilter}"` : ""}
            {userFilter !== "all" ? ` (filtr: ${userFilter})` : ""}.
          </div>
        )}
        {sortedRecords.map((r) => (
          <BackendRecordRow
            key={r.id}
            record={r}
            isActive={activeRecordId === r.id}
            isDeleting={deletingId === r.id}
            onClick={() => onSelectRecord(r.id)}
            onDelete={() => handleDelete(r)}
          />
        ))}
      </div>
    </Card>
  );
}

export function SearchAuditPanel() {
  const fnList = useServerFn(backendListSearchAudit);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["search-audit"],
    queryFn: () => fnList({ data: { limit: 50 } }),
    refetchInterval: 30000,
  });
  const [userFilter, setUserFilter] = useState<string>("all");
  const entries: SearchAuditEntry[] = data?.entries ?? [];
  const filtered = entries.filter((e) => {
    if (userFilter === "all") return true;
    if (userFilter === "__none__") return !e.searched_by;
    return e.searched_by === userFilter;
  });
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          🕓 Historia audytu wyszukiwań ({filtered.length}/{entries.length})
        </h2>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="mb-2">
        <Select value={userFilter} onValueChange={setUserFilter}>
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue placeholder="Filtruj po użytkowniku" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">👥 Wszyscy użytkownicy</SelectItem>
            {SITE_USERS.map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
            <SelectItem value="__none__">— Bez przypisania</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="max-h-[320px] overflow-auto space-y-1">
        {!filtered.length && !isLoading && (
          <div className="text-xs italic text-muted-foreground py-4 text-center">
            Brak wpisów audytu{userFilter !== "all" ? ` (filtr: ${userFilter})` : ""}.
          </div>
        )}
        {filtered.map((e) => (
          <div key={e.id} className="text-[11px] p-1.5 rounded border border-border/50 hover:bg-muted/30">
            <div className="flex items-center gap-1.5 flex-wrap">
              {e.searched_by ? (
                <Badge variant="secondary" className="text-[9px] py-0 px-1">
                  👤 {e.searched_by}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[9px] py-0 px-1 italic">
                  nieprzypisane
                </Badge>
              )}
              <span className="text-muted-foreground">
                {new Date(e.created_at).toLocaleString("pl-PL")}
              </span>
            </div>
            <div className="mt-0.5 text-foreground/80 truncate">
              {[e.make, e.model].filter(Boolean).join(" ") || "—"}
              {e.budget_usd ? ` · $${e.budget_usd.toLocaleString("en-US")}` : ""}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function BackendRecordRow({
  record,
  isActive,
  isDeleting,
  onClick,
  onDelete,
}: {
  record: BackendRecord;
  isActive?: boolean;
  isDeleting?: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const statusIcon: Record<string, string> = {
    done: "✅",
    new: "✅",
    cancelled: "⛔",
    error: "❌",
    interrupted: "⚠️",
  };
  const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    done: "default",
    new: "default",
    cancelled: "secondary",
    error: "destructive",
    interrupted: "outline",
  };
  const searchedBy = getRecordSearchedBy(record);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className={`group w-full p-2 rounded border transition-colors text-left cursor-pointer ${
        isActive ? "border-primary bg-accent" : "hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium truncate flex-1">{record.title}</span>
        <Badge variant={statusVariant[record.status] ?? "outline"} className="text-[10px] shrink-0">
          {statusIcon[record.status] ?? "?"} {record.status}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0 opacity-60 hover:opacity-100 hover:text-destructive"
          disabled={isDeleting}
          title="Usuń rekord"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          {isDeleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground flex-wrap">
        <span>{new Date(record.created_at).toLocaleString("pl-PL")}</span>
        {record.collected_count > 0 && <span>· {record.collected_count} lotów</span>}
        {record.client?.name && <span>· {record.client.name}</span>}
        {searchedBy ? (
          <span className="inline-flex items-center gap-1">
            · <span className="text-[9px] text-muted-foreground">Zrobione przez:</span>{" "}
            <Badge variant="secondary" className="text-[9px] py-0 px-1">
              {searchedBy}
            </Badge>
          </span>
        ) : (
          <span className="text-[9px] italic">· nieprzypisane</span>
        )}
      </div>
      {record.analysis_notice && (
        <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400 truncate">
          {record.analysis_notice}
        </div>
      )}
    </div>
  );
}

export function RecordDetailView({
  recordId,
  onClose,
}: {
  recordId: number;
  onClose: () => void;
}) {
  const fnDetailBackend = useServerFn(backendGetRecord);
  const fnRegenerateBundles = useServerFn(backendRegenerateBundles);
  const fnRunSearch = useServerFn(backendSearch);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [rerunning, setRerunning] = useState(false);

  const { data: record, isLoading } = useQuery({
    queryKey: ["backend-record-detail", recordId],
    queryFn: () => fnDetailBackend({ data: { id: String(recordId) } }),
  });

  const [sortBy, setSortBy] = useState<"score" | "auction_date">("auction_date");

  const parsedData = useMemo(() => {
    if (!record) return null;
    const crit = (() => {
      try {
        return typeof record.criteria === "string"
          ? JSON.parse(record.criteria)
          : (record.criteria ?? {});
      } catch {
        return {};
      }
    })();
    const resp = (() => {
      try {
        const r = (record as any).response ?? (record as any).response_json;
        return typeof r === "string" ? JSON.parse(r) : (r ?? {});
      } catch {
        return {};
      }
    })();
    const all: any[] = resp.all_results || [];
    return {
      criteria: crit,
      response: resp,
      allResults: all,
      showcase: all.filter((al: any) => al.is_top_recommendation),
      autoReports: (resp.auto_reports_by_lot_id || {}) as Record<string, any>,
      collectedCount: (record as any).collected_count || 0,
      aiAnalyzedCount: all.length,
      showcaseCount: all.filter((al: any) => al.is_top_recommendation).length,
    };
  }, [record]);

  const sortedResults = useMemo(() => {
    if (!parsedData) return [];
    const arr = [...parsedData.allResults];
    if (sortBy === "score") {
      const order: Record<string, number> = { POLECAM: 0, RYZYKO: 1, ODRZUĆ: 2 };
      arr.sort((a, b) => {
        const ra = order[a.analysis?.recommendation] ?? 99;
        const rb = order[b.analysis?.recommendation] ?? 99;
        if (ra !== rb) return ra - rb;
        return (b.analysis?.score || 0) - (a.analysis?.score || 0);
      });
    } else {
      arr.sort((a, b) => {
        const da = a.lot?.auction_date || "9999-12-31";
        const db = b.lot?.auction_date || "9999-12-31";
        return da.localeCompare(db);
      });
    }
    return arr;
  }, [parsedData, sortBy]);

  if (isLoading || !record || !parsedData) {
    return (
      <Card className="p-4 flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  const { criteria, allResults, autoReports, collectedCount, aiAnalyzedCount, showcaseCount } =
    parsedData;
  const artifactUrls = (record as any).artifact_urls || {};
  const searchedBy = getRecordSearchedBy(record);
  const rerunCriteria = toRerunCriteria(parsedData.criteria);
  const canRerun = rerunCriteria !== null;

  async function onRerunNow() {
    if (!rerunCriteria) {
      toast.error("Rekord nie ma zapisanych kryteriów wyszukiwania.");
      return;
    }
    setRerunning(true);
    try {
      const res = await fnRunSearch({ data: { criteria: rerunCriteria } });
      const total = res.analyzed_lots?.length ?? res.listings?.length ?? 0;
      if (total === 0) {
        toast.info("Nie znaleziono aukcji spełniających kryteria.");
      } else {
        toast.success(`Ponowione wyszukiwanie: znaleziono ${total} ofert.`);
      }
      await queryClient.invalidateQueries({ queryKey: ["backend-records"] });
    } catch (e) {
      const err = e as { message?: string };
      toast.error(err?.message || "Błąd ponownego wyszukiwania.");
    } finally {
      setRerunning(false);
    }
  }

  function onEditAndSearch() {
    if (!rerunCriteria) {
      toast.error("Rekord nie ma zapisanych kryteriów wyszukiwania.");
      return;
    }
    try {
      sessionStorage.setItem(RERUN_CRITERIA_KEY, JSON.stringify(rerunCriteria));
    } catch {
      toast.error("Nie udało się przekazać kryteriów do formularza.");
      return;
    }
    void navigate({ to: "/" });
  }

  return (
    <Card className="p-4">
      {/* HEADER */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">
            {(record as any).title ?? `Rekord #${recordId}`}
          </h2>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
            <Badge>{(record as any).status}</Badge>
            <span>{new Date((record as any).created_at).toLocaleString("pl-PL")}</span>
            {(record as any).client?.name && <span>· {(record as any).client.name}</span>}
            {searchedBy ? (
              <>
                <span>·</span>
                <Badge variant="secondary" className="text-[10px]">
                  👤 {searchedBy}
                </Badge>
                <Link
                  to="/records"
                  className="text-[10px] text-blue-500 hover:underline ml-1"
                  title="Zobacz wszystkie rekordy"
                >
                  📜 Historia
                </Link>
              </>
            ) : (
              <span className="text-[10px] italic">· nieprzypisane</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => void onRerunNow()}
            disabled={!canRerun || rerunning}
            title={
              canRerun
                ? "Uruchom to samo wyszukiwanie od nowa"
                : "Rekord nie ma zapisanych kryteriów wyszukiwania."
            }
          >
            {rerunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            <span className="ml-1">Ponów teraz</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onEditAndSearch}
            disabled={!canRerun}
            title="Załaduj kryteria do formularza i przejdź do wyszukiwarki"
          >
            <PenLine className="h-4 w-4" />
            <span className="ml-1">Edytuj i szukaj</span>
          </Button>
          <Button variant="ghost" onClick={onClose}>
            ← Zamknij
          </Button>
        </div>
      </div>

      {/* AUTO-BUNDLE REPORTS */}
      {(artifactUrls.client_bundle ||
        artifactUrls.client_short_bundle ||
        artifactUrls.broker_bundle) && (
        <Card className="p-3 mb-4 border-amber-500/30 bg-amber-500/5">
          <div className="text-sm font-semibold mb-2">📦 Auto-zbiorcze raporty</div>
          <div className="text-xs text-muted-foreground mb-2">
            Klient = tylko POLECAM. Broker = wszystkie showcase (POLECAM + RYZYKO).
          </div>
          <div className="flex gap-2 flex-wrap">
            {artifactUrls.client_bundle && (
              <Button variant="default" size="sm" asChild>
                <a href={artifactUrls.client_bundle} target="_blank" rel="noopener">
                  📄 Zbiorczy pełny klient (POLECAM)
                </a>
              </Button>
            )}
            {artifactUrls.client_short_bundle && (
              <Button variant="default" size="sm" asChild>
                <a href={artifactUrls.client_short_bundle} target="_blank" rel="noopener">
                  ⚡ Zbiorczy krótki klient (POLECAM)
                </a>
              </Button>
            )}
            {artifactUrls.broker_bundle && (
              <Button variant="default" size="sm" asChild>
                <a href={artifactUrls.broker_bundle} target="_blank" rel="noopener">
                  📋 Zbiorczy broker (wszystkie)
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                toast.info("Odświeżam bundle...");
                await fnRegenerateBundles({
                  data: { recordId: (record as any).id, engine: "template" },
                });
                toast.success("Bundle odświeżony — refresh strony");
                queryClient.invalidateQueries({ queryKey: ["backend-record-detail", recordId] });
              }}
            >
              🔄 Odśwież layout bundle
            </Button>
          </div>
        </Card>
      )}

      {/* PIPELINE FUNNEL */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">🔍 Zescrapowane</div>
          <div className="text-2xl font-bold">{collectedCount}</div>
          <div className="text-xs text-muted-foreground">Copart + IAAI + Manheim po filtrach</div>
        </Card>
        <Card className="p-3 border-blue-500/40">
          <div className="text-xs text-muted-foreground">🤖 Analiza AI</div>
          <div className="text-2xl font-bold">{aiAnalyzedCount}</div>
          <div className="text-xs text-muted-foreground">
            Top {aiAnalyzedCount} po pre-rank → AI ocenia
          </div>
        </Card>
        <Card className="p-3 border-green-500/40">
          <div className="text-xs text-muted-foreground">🎯 Showcase</div>
          <div className="text-2xl font-bold">{showcaseCount}</div>
          <div className="text-xs text-muted-foreground">Wszystkie POLECAM + 2 RYZYKO</div>
        </Card>
      </div>

      {/* KRYTERIA */}
      <Card className="p-3 mb-4 bg-muted/30">
        <h3 className="text-sm font-semibold mb-2">📋 Kryteria wyszukiwania</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div>
            Marka: <strong>{criteria.make}</strong>
          </div>
          <div>
            Model: <strong>{criteria.model || "—"}</strong>
          </div>
          <div>
            Rocznik: {criteria.year_from || "?"}–{criteria.year_to || "?"}
          </div>
          <div>Budżet: {criteria.budget_usd ? `$${criteria.budget_usd}` : "bez limitu"}</div>
          <div>
            Max przebieg: {criteria.max_odometer_mi ? `${criteria.max_odometer_mi} mi` : "bez limitu"}
          </div>
          {criteria.fuel_type && (
            <div>
              Paliwo: <strong>{criteria.fuel_type}</strong>
            </div>
          )}
          <div>Źródła: {(criteria.sources || []).join(", ")}</div>
          <div>Wyklucz: {(criteria.excluded_damage_types || []).join(", ")}</div>
        </div>
      </Card>

      {/* NOTATKA DIAGNOSTYCZNA */}
      {(record as any).analysis_notice && collectedCount <= 2 && (
        <Alert className="mb-4 border-amber-500/40">
          <AlertDescription className="text-xs whitespace-pre-line">
            {(record as any).analysis_notice}
          </AlertDescription>
        </Alert>
      )}

      {/* LISTA LOTÓW */}
      {allResults.length > 0 ? (
        <Card className="p-3">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">🚗 Loty z analizą AI ({allResults.length})</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Sortuj:</span>
              <Button
                size="sm"
                variant={sortBy === "auction_date" ? "default" : "outline"}
                onClick={() => setSortBy("auction_date")}
              >
                ⏰ Czas do aukcji
              </Button>
              <Button
                size="sm"
                variant={sortBy === "score" ? "default" : "outline"}
                onClick={() => setSortBy("score")}
              >
                🎯 AI Score
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {sortedResults.map((al: any) => {
              const lot = al.lot;
              const ai = al.analysis;
              const reports = autoReports[lot.lot_id] || {};
              const isShowcase = al.is_top_recommendation;
              const auctionInfo = formatTimeUntilAuction(lot.auction_date);

              return (
                <div
                  key={lot.lot_id}
                  className={`p-3 rounded border transition-colors ${
                    isShowcase
                      ? "bg-emerald-500/10 dark:bg-emerald-500/15 border-emerald-500/40 text-foreground"
                      : "border-border"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-semibold text-sm">
                        {lot.year} {lot.make} {lot.model} {lot.trim || ""}
                      </span>
                      {isShowcase && (
                        <Badge variant="default" className="text-xs">
                          🎯 Showcase
                        </Badge>
                      )}
                      {auctionInfo && (
                        <Badge
                          variant={
                            auctionInfo.variant === "danger"
                              ? "destructive"
                              : auctionInfo.variant === "warning"
                                ? "secondary"
                                : "outline"
                          }
                          className={
                            auctionInfo.variant === "danger"
                              ? "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/40"
                              : auctionInfo.variant === "warning"
                                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40"
                                : "text-muted-foreground"
                          }
                        >
                          {auctionInfo.text}
                        </Badge>
                      )}
                      {ai?.recommendation && (
                        <Badge
                          variant={
                            ai.recommendation === "POLECAM"
                              ? "default"
                              : ai.recommendation === "RYZYKO"
                                ? "secondary"
                                : "destructive"
                          }
                          className="text-xs shrink-0 ml-auto"
                        >
                          {ai.recommendation} · {ai.score?.toFixed(1)}/10
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground mb-2">
                      <span>
                        {lot.source}/{lot.lot_id}
                      </span>
                      <span>{lot.damage_primary}</span>
                      <span>{lot.title_type}</span>
                      <span>{lot.location_state}</span>
                      {lot.odometer_mi && <span>{lot.odometer_mi.toLocaleString()} mi</span>}
                      {lot.current_bid_usd && <span>${lot.current_bid_usd.toLocaleString()}</span>}
                      {lot.seller_type && (
                        <Badge variant="outline" className="text-xs">
                          {lot.seller_type}
                        </Badge>
                      )}
                    </div>

                    <BidfaxBadge lot={lot} />

                    {ai?.client_description_pl && (
                      <div className="text-xs mt-1 italic">{ai.client_description_pl}</div>
                    )}

                    {ai?.red_flags && ai.red_flags.length > 0 && (
                      <div className="text-xs mt-1 text-amber-600">
                        ⚠️ {ai.red_flags.join(" · ")}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 mt-2">
                      {lot.url && (
                        <a
                          href={lot.url}
                          target="_blank"
                          rel="noopener"
                          className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80"
                        >
                          🔗 Aukcja
                        </a>
                      )}
                      {reports.client_short_url && (
                        <a
                          href={reports.client_short_url}
                          target="_blank"
                          rel="noopener"
                          className="text-xs px-2 py-1 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                          title="Krótki — szybki Jinja2, podstawowe dane"
                        >
                          📄 Auto-raport krótki klient
                        </a>
                      )}
                      {reports.client_url && (
                        <a
                          href={reports.client_url}
                          target="_blank"
                          rel="noopener"
                          className="text-xs px-2 py-1 rounded bg-green-500/10 hover:bg-green-500/20 text-green-700 dark:text-green-400"
                          title="Pełny — Gemini+Otomoto+storytelling"
                        >
                          📄 Auto-raport pełny klient
                        </a>
                      )}
                      {reports.broker_url && (
                        <a
                          href={reports.broker_url}
                          target="_blank"
                          rel="noopener"
                          className="text-xs px-2 py-1 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-700 dark:text-blue-400"
                          title="Pełny brokerski — scoring + bid + market"
                        >
                          📋 Auto-raport broker
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <div className="p-6 text-center text-sm text-muted-foreground">
          Brak lotów do wyświetlenia (status: {(record as any).status})
          {(record as any).analysis_notice && (
            <div className="text-xs mt-2 italic whitespace-pre-line">
              {(record as any).analysis_notice}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
