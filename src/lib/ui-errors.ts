// Client-side helper — pokazuje toast błędu i zwraca user-message.
import { toast } from "sonner";
import { toUserMessage } from "@/lib/errors";

/**
 * Wyświetl toast błędu w spójnym stylu.
 * - `fallback` — czytelny PL komunikat gdy nie da się nic wydobyć z err
 * - `technical` — jeśli true, w opisie toastu pokaż `err.message` (dla debugu)
 */
export function toastError(err: unknown, fallback = "Coś poszło nie tak.", opts?: { technical?: boolean }): string {
  const msg = toUserMessage(err, fallback);
  const description =
    opts?.technical && err instanceof Error && err.message && err.message !== msg
      ? err.message
      : undefined;
  toast.error(msg, description ? { description } : undefined);
  return msg;
}

/** Wrap async action — toastuje błąd i zwraca null zamiast rzucać. */
export async function tryAction<T>(
  fn: () => Promise<T>,
  fallback = "Nie udało się wykonać operacji.",
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    toastError(err, fallback, { technical: true });
    return null;
  }
}
