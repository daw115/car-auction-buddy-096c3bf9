// Shared error helpers — server-safe (no browser deps). Use from server
// functions, API routes, and lib code. For client-side toasts see
// `src/lib/ui-errors.ts`.
import { ZodError } from "zod";

/** Application-level error with a user-friendly PL message and optional HTTP status. */
export class AppError extends Error {
  readonly status: number;
  readonly userMessage: string;
  readonly cause?: unknown;
  constructor(userMessage: string, opts?: { status?: number; cause?: unknown; technical?: string }) {
    super(opts?.technical ?? userMessage);
    this.name = "AppError";
    this.status = opts?.status ?? 500;
    this.userMessage = userMessage;
    this.cause = opts?.cause;
  }
}

/** Format Zod issues into a single readable PL message. */
export function formatZodError(err: ZodError): string {
  const lines = err.issues.slice(0, 5).map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(pole)";
    return `• ${path}: ${i.message}`;
  });
  const extra = err.issues.length > 5 ? `\n(+${err.issues.length - 5} więcej)` : "";
  return `Nieprawidłowe dane wejściowe:\n${lines.join("\n")}${extra}`;
}

/** Best-effort extraction of a user-facing PL message from any thrown value. */
export function toUserMessage(err: unknown, fallback = "Wystąpił nieoczekiwany błąd."): string {
  if (err instanceof AppError) return err.userMessage;
  if (err instanceof ZodError) return formatZodError(err);
  if (err instanceof Error) {
    const msg = err.message?.trim();
    if (!msg) return fallback;
    // Sanitize noisy prefixes.
    return msg.replace(/^Error:\s*/i, "");
  }
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return fallback;
}

/** Map a Supabase PostgREST error into an AppError with a friendly PL message. */
export function fromSupabaseError(
  err: { message: string; code?: string; details?: string | null; hint?: string | null } | null,
  ctx: string,
): AppError | null {
  if (!err) return null;
  const code = err.code ?? "";
  let msg = `${ctx}: ${err.message}`;
  if (code === "23505") msg = `${ctx}: rekord już istnieje (duplikat).`;
  else if (code === "23503") msg = `${ctx}: powiązany rekord nie istnieje.`;
  else if (code === "23502") msg = `${ctx}: brakuje wymaganego pola.`;
  else if (code === "42501" || code === "PGRST301") msg = `${ctx}: brak uprawnień do wykonania operacji.`;
  else if (code === "PGRST116") msg = `${ctx}: nie znaleziono rekordu.`;
  return new AppError(msg, { status: 400, cause: err, technical: `${ctx} [${code}] ${err.message}` });
}

/** Throw an AppError if the Supabase error is present. */
export function assertNoDbError(
  err: { message: string; code?: string } | null,
  ctx: string,
): void {
  const app = fromSupabaseError(err, ctx);
  if (app) throw app;
}

/** Run a handler with unified error mapping — server-side use. */
export async function safeHandler<T>(ctx: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof ZodError) {
      throw new AppError(formatZodError(err), { status: 400, cause: err });
    }
    throw new AppError(`${ctx}: ${toUserMessage(err)}`, { status: 500, cause: err });
  }
}

/** Build a JSON error response body for API routes. */
export function toJsonError(err: unknown, ctx = "Błąd"): { status: number; body: { error: string; code?: string } } {
  if (err instanceof AppError) return { status: err.status, body: { error: err.userMessage } };
  if (err instanceof ZodError) return { status: 400, body: { error: formatZodError(err), code: "validation" } };
  return { status: 500, body: { error: `${ctx}: ${toUserMessage(err)}` } };
}
