/**
 * Single source of truth for detecting which AI credential a deployment runs on.
 *
 * The Anthropic SDKs resolve credentials in a fixed order: ANTHROPIC_API_KEY first,
 * then ANTHROPIC_AUTH_TOKEN — a Bearer token, which is how a Claude Code /
 * subscription account authenticates. Reporting only on ANTHROPIC_API_KEY made a
 * deployment running on a Claude Code account look unconfigured.
 *
 * Env is read inside each function, never at module top-level, because the Workers
 * runtime populates process.env per request rather than at module evaluation.
 */

export type AiAuthMode = "api_key" | "oauth" | "none";
export type AiProvider = "anthropic" | "gemini" | "gemini_enterprise";

const AI_PROVIDERS: readonly string[] = ["anthropic", "gemini", "gemini_enterprise"];

/** Treats whitespace-only values as absent — a blank secret is a misconfiguration, not a credential. */
export function hasEnvValue(name: string): boolean {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim().length > 0;
}

export type AnthropicCredential = {
  configured: boolean;
  /** `oauth` means the deployment authenticates as a Claude Code / subscription account. */
  authMode: AiAuthMode;
};

export function readAnthropicCredential(): AnthropicCredential {
  if (hasEnvValue("ANTHROPIC_API_KEY")) return { configured: true, authMode: "api_key" };
  if (hasEnvValue("ANTHROPIC_AUTH_TOKEN")) return { configured: true, authMode: "oauth" };
  return { configured: false, authMode: "none" };
}

export function hasGeminiCredential(): boolean {
  return hasEnvValue("GEMINI_API_KEY");
}

export function hasGeminiEnterpriseCredential(): boolean {
  return hasEnvValue("GEMINI_ENTERPRISE_SA_JSON");
}

/**
 * Env-level resolution only. `app_config.ai_analysis_mode` and the backend's own
 * per-task overrides (`/api/settings/ai-providers`) win at analysis time.
 * An unrecognized AI_PROVIDER falls through to credential detection rather than
 * being echoed back as if it were valid.
 */
export function resolveAiProviderFromEnv(): AiProvider {
  const explicit = process.env.AI_PROVIDER?.trim();
  if (explicit && AI_PROVIDERS.includes(explicit)) return explicit as AiProvider;
  if (readAnthropicCredential().configured) return "anthropic";
  if (hasGeminiCredential()) return "gemini";
  if (hasGeminiEnterpriseCredential()) return "gemini_enterprise";
  return "anthropic";
}

export function isAiConfigured(): boolean {
  return (
    readAnthropicCredential().configured ||
    hasGeminiCredential() ||
    hasGeminiEnterpriseCredential()
  );
}
