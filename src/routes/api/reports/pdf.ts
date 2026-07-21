// Server route do pobierania PDF raportu z zapisanego rekordu.
// GET /api/reports/pdf?recordId=<uuid>&mode=broker|client

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateReportPdf } from "@/server/pdf-report.server";
import { siteSessionGuard } from "@/server/site-session.server";
import { toUserMessage } from "@/lib/errors";
import type { AnalyzedLot } from "@/lib/types";

export const Route = createFileRoute("/api/reports/pdf")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const unauthorized = await siteSessionGuard();
          if (unauthorized) return unauthorized;

          const url = new URL(request.url);
          const recordId = url.searchParams.get("recordId");
          const modeParam = url.searchParams.get("mode") ?? "client";
          if (!recordId) {
            return new Response("Brakuje parametru recordId.", { status: 400 });
          }
          if (modeParam !== "broker" && modeParam !== "client") {
            return new Response("Parametr mode musi być 'broker' lub 'client'.", { status: 400 });
          }
          const mode = modeParam as "broker" | "client";

          const { data: row, error } = await supabaseAdmin
            .from("records")
            .select("id, title, analysis, criteria, client_id, clients:client_id(name)")
            .eq("id", recordId)
            .single();
          if (error || !row) {
            return new Response(
              `Nie znaleziono rekordu: ${error?.message ?? "brak dostępu lub błędny identyfikator"}`,
              { status: 404 },
            );
          }

          const analysis = (row.analysis as AnalyzedLot[] | null) ?? [];
          if (analysis.length === 0) {
            return new Response("Rekord nie ma jeszcze analizy — uruchom ponownie wyszukiwanie.", { status: 400 });
          }

          // dla klienta — TOP3 + 2 odrzucone (jak ustaliliśmy)
          let lots = [...analysis].sort((a, b) => b.analysis.score - a.analysis.score);
          if (mode === "client") {
            const top3 = lots.slice(0, 3);
            const fillers = lots.slice(-2).reverse(); // 2 najgorsze
            const seen = new Set(top3.map((l) => l.lot.lot_id));
            const fill = fillers.filter((l) => !seen.has(l.lot.lot_id));
            lots = [...top3, ...fill];
          }

          // pobierz kurs (fallback gdy API niedostępne)
          const fx = { usd_pln: 4.0, usd_eur: 0.92 };
          try {
            const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=PLN,EUR");
            if (r.ok) {
              const j = (await r.json()) as { rates?: { PLN?: number; EUR?: number } };
              if (j.rates?.PLN) fx.usd_pln = j.rates.PLN;
              if (j.rates?.EUR) fx.usd_eur = j.rates.EUR;
            }
          } catch {
            // fallback — kontynuujemy z domyślnymi kursami
          }

          const clientName = (row.clients as { name?: string } | null)?.name ?? row.title ?? "Klient";

          const pdf = await generateReportPdf({
            clientName,
            generatedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            lots,
            mode,
            fx,
          });

          const filename = `usa-car-scout-${mode}-${recordId.slice(0, 8)}.pdf`;
          return new Response(new Uint8Array(pdf), {
            status: 200,
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${filename}"`,
              "Cache-Control": "no-store",
            },
          });
        } catch (err) {
          return new Response(`Nie udało się wygenerować PDF: ${toUserMessage(err)}`, {
            status: 500,
          });
        }
      },
    },
  },
});
