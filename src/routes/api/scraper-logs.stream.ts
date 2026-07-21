import { createFileRoute } from "@tanstack/react-router";
import { siteSessionGuard } from "@/server/site-session.server";
import { backendStreamRequest } from "@/lib/backend-transport.server";

// SSE proxy: streams logs from upstream FastAPI backend. Tries several known
// paths and returns the first stream that succeeds. Transport selection
// (Ubuntu API vs legacy API_BASE_URL) is delegated to the unified transport
// module — this route MUST NOT read SCRAPER_* / API_* / UBUNTU_* / CF_ACCESS_*
// directly.
const CANDIDATE_PATHS = ["/api/logs/stream", "/logs/stream", "/api/stream/logs"];

export const Route = createFileRoute("/api/scraper-logs/stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = await siteSessionGuard();
        if (unauthorized) return unauthorized;

        let lastStatus = 0;
        let lastPath = "";
        let lastMessage = "";
        for (const path of CANDIDATE_PATHS) {
          try {
            const { body, transport } = await backendStreamRequest({
              path,
              signal: request.signal,
            });
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                "X-Upstream-Path": path,
                "X-Backend-Transport": transport,
              },
            });
          } catch (e) {
            const err = e as { status?: number; message?: string };
            lastStatus = typeof err?.status === "number" ? err.status : 0;
            lastMessage = err?.message ?? "";
            lastPath = path;
            // Fail-closed transport / auth errors: stop, don't try more paths.
            if (lastStatus === 500 || lastStatus === 401 || lastStatus === 403) {
              return new Response(lastMessage || "Backend unavailable", {
                status: lastStatus,
              });
            }
            // 404 / 502 / 503 / timeouts: try the next candidate path.
          }
        }
        return new Response(
          `Upstream not found. Last tried: ${lastPath} → ${lastStatus}${
            lastMessage ? ` (${lastMessage})` : ""
          }`,
          { status: lastStatus || 502 },
        );
      },
    },
  },
});
