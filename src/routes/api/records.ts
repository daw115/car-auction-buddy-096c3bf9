import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { siteSessionGuard } from "@/server/site-session.server";
import { toJsonError } from "@/lib/errors";

export const Route = createFileRoute("/api/records")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const unauthorized = await siteSessionGuard();
          if (unauthorized) return unauthorized;

          const { data, error } = await supabaseAdmin
            .from("records")
            .select("id, client_id, title, status, created_at, updated_at, clients(name)")
            .order("created_at", { ascending: false })
            .limit(200);
          if (error) {
            return Response.json(
              { error: `Baza rekordów: ${error.message}` },
              { status: 500 },
            );
          }
          return Response.json({ records: data ?? [] });
        } catch (err) {
          const { status, body } = toJsonError(err, "Pobieranie rekordów");
          return Response.json(body, { status });
        }
      },
    },
  },
});
