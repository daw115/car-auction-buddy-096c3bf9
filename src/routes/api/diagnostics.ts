import { createFileRoute } from "@tanstack/react-router";
import { siteSessionGuard } from "@/server/site-session.server";

type Check = {
  name: string;
  present: boolean;
  required: boolean;
  category: "auth" | "backend" | "ai" | "supabase" | "ubuntu";
  description: string;
  hint?: string;
  minLength?: number;
  lengthOk?: boolean;
  legacy?: boolean;
};

function check(
  name: string,
  category: Check["category"],
  description: string,
  required: boolean,
  opts: { minLength?: number; hint?: string; legacy?: boolean } = {},
): Check {
  const raw = process.env[name];
  const present = typeof raw === "string" && raw.length > 0;
  const lengthOk = opts.minLength ? present && raw!.length >= opts.minLength : true;
  return {
    name,
    category,
    description,
    required,
    present,
    hint: opts.hint,
    minLength: opts.minLength,
    lengthOk,
    legacy: opts.legacy ?? false,
  };
}

export const Route = createFileRoute("/api/diagnostics")({
  server: {
    handlers: {
      GET: async () => {
        const unauthorized = await siteSessionGuard();
        if (unauthorized) return unauthorized;

        const checks: Check[] = [
          check("SITE_SESSION_SECRET", "auth", "Sekret do podpisywania sesji PasswordGate", true, {
            minLength: 32,
            hint: "Wygeneruj losowy ciąg ≥32 znaków (np. openssl rand -hex 32) i zapisz w sekretach.",
          }),
          check("SITE_MASTER_PASSWORD", "auth", "Hasło nadrzędne do zarządzania profilami", true, {
            hint: "Wymagane do dodawania/usuwania kont w PasswordGate.",
          }),
          check(
            "API_BASE_URL",
            "backend",
            "URL produkcyjnego backendu FastAPI (legacy — do wygaszenia po migracji na Ubuntu API)",
            true,
            {
              hint: "np. https://moneybitches.organof.org",
              legacy: true,
            },
          ),
          check("SCRAPER_BASE_URL", "backend", "URL zewnętrznego scrapera (legacy proxy)", false, {
            legacy: true,
          }),
          check("SCRAPER_API_TOKEN", "backend", "Token do scrapera (legacy)", false, {
            legacy: true,
          }),
          check(
            "ANTHROPIC_API_KEY",
            "ai",
            "Klucz Anthropic (opcjonalny — backend ma własny)",
            false,
          ),
          check(
            "ANTHROPIC_AUTH_TOKEN",
            "ai",
            "Token OAuth konta Claude Code / subskrypcji — alternatywa dla ANTHROPIC_API_KEY",
            false,
            {
              hint: "Token jest krótkotrwały i nie odnawia się sam po stronie serwera — po wygaśnięciu wywołania AI zwrócą 401. Do stałego deploymentu użyj ANTHROPIC_API_KEY.",
            },
          ),
          check("GEMINI_API_KEY", "ai", "Klucz Gemini (opcjonalny)", false),
          check("VITE_SUPABASE_URL", "supabase", "URL projektu Supabase (klient)", true),
          check("VITE_SUPABASE_PUBLISHABLE_KEY", "supabase", "Publiczny klucz Supabase", true),
          check(
            "SUPABASE_URL",
            "supabase",
            "URL projektu Supabase (serwer) — wymagany dla supabaseAdmin",
            true,
            {
              hint: "Ustaw na Ubuntu w /etc/systemd/system/<serwis>.env lub w .env aplikacji. Ta sama wartość co VITE_SUPABASE_URL.",
            },
          ),
          check(
            "SUPABASE_SERVICE_ROLE_KEY",
            "supabase",
            "Service role key — dostęp serwera do DB z pominięciem RLS",
            true,
            {
              hint: "Skopiuj z Lovable Cloud → Backend → Settings → API. Nigdy nie eksponuj klientowi.",
            },
          ),
          check(
            "REPORTS_API_KEY",
            "backend",
            "Klucz do usługi services/reports-api (FastAPI)",
            false,
            {
              minLength: 32,
              hint: "Wygeneruj: openssl rand -hex 32. Ta sama wartość w kliencie i w reports-api.",
            },
          ),
          // Ubuntu API (additive, optional in this phase) — see docs/lovable-ubuntu-deployment.md.
          // Report presence only; never expose values, prefixes, or partial fragments.
          check(
            "UBUNTU_API_BASE_URL",
            "ubuntu",
            "Kanoniczny HTTPS URL FastAPI na Ubuntu (za Cloudflare Access)",
            false,
            {
              hint: "Wymaga https, bez trailing slash, bez credentials. Server-only.",
            },
          ),
          check("UBUNTU_API_BEARER_TOKEN", "ubuntu", "Bearer token dla FastAPI na Ubuntu", false, {
            hint: "Wystawiany przez backend Ubuntu. Server-only, nigdy nie loguj.",
          }),
          check(
            "CF_ACCESS_CLIENT_ID",
            "ubuntu",
            "Cloudflare Access service token — client id",
            false,
            {
              hint: "Z Cloudflare Zero Trust → Access → Service Tokens.",
            },
          ),
          check(
            "CF_ACCESS_CLIENT_SECRET",
            "ubuntu",
            "Cloudflare Access service token — client secret",
            false,
            {
              hint: "Z Cloudflare Zero Trust → Access → Service Tokens. Server-only.",
            },
          ),
        ];

        const missingRequired = checks.filter((c) => c.required && (!c.present || !c.lengthOk));

        return Response.json({
          ok: missingRequired.length === 0,
          checkedAt: new Date().toISOString(),
          runtime: {
            nodeEnv: process.env.NODE_ENV || "unknown",
          },
          checks,
          summary: {
            total: checks.length,
            ok: checks.filter((c) => c.present && c.lengthOk).length,
            missingRequired: missingRequired.length,
          },
        });
      },
    },
  },
});
