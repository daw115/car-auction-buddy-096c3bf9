import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  hasEnvValue,
  isAiConfigured,
  readAnthropicCredential,
  resolveAiProviderFromEnv,
} from "./ai-credentials.server";

const AI_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_ENTERPRISE_SA_JSON",
  "AI_PROVIDER",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of AI_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AI_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("hasEnvValue", () => {
  it("treats missing, empty and whitespace-only values as absent", () => {
    expect(hasEnvValue("ANTHROPIC_API_KEY")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "";
    expect(hasEnvValue("ANTHROPIC_API_KEY")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(hasEnvValue("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("detects a non-blank value", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(hasEnvValue("ANTHROPIC_API_KEY")).toBe(true);
  });
});

describe("readAnthropicCredential", () => {
  it("reports no credential when neither variable is set", () => {
    expect(readAnthropicCredential()).toEqual({ configured: false, authMode: "none" });
  });

  it("reports api_key mode for ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(readAnthropicCredential()).toEqual({ configured: true, authMode: "api_key" });
  });

  it("reports oauth mode for a Claude Code account token", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
    expect(readAnthropicCredential()).toEqual({ configured: true, authMode: "oauth" });
  });

  it("prefers ANTHROPIC_API_KEY when both are set, matching SDK resolution order", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
    expect(readAnthropicCredential().authMode).toBe("api_key");
  });

  it("ignores a blank token", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "   ";
    expect(readAnthropicCredential().configured).toBe(false);
  });
});

describe("isAiConfigured", () => {
  it("is false with no credentials at all", () => {
    expect(isAiConfigured()).toBe(false);
  });

  it("is true for a Claude Code account token alone", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
    expect(isAiConfigured()).toBe(true);
  });

  it("is true for Gemini alone", () => {
    process.env.GEMINI_API_KEY = "gem-test";
    expect(isAiConfigured()).toBe(true);
  });

  it("is true for Gemini Enterprise alone", () => {
    process.env.GEMINI_ENTERPRISE_SA_JSON = "{}";
    expect(isAiConfigured()).toBe(true);
  });
});

describe("resolveAiProviderFromEnv", () => {
  it("falls back to anthropic when nothing is configured", () => {
    expect(resolveAiProviderFromEnv()).toBe("anthropic");
  });

  it("detects anthropic from an OAuth token", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
    expect(resolveAiProviderFromEnv()).toBe("anthropic");
  });

  it("detects gemini when only a Gemini key is present", () => {
    process.env.GEMINI_API_KEY = "gem-test";
    expect(resolveAiProviderFromEnv()).toBe("gemini");
  });

  it("detects gemini_enterprise when only a service account is present", () => {
    process.env.GEMINI_ENTERPRISE_SA_JSON = "{}";
    expect(resolveAiProviderFromEnv()).toBe("gemini_enterprise");
  });

  it("lets an explicit AI_PROVIDER override credential detection", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.AI_PROVIDER = "gemini";
    expect(resolveAiProviderFromEnv()).toBe("gemini");
  });

  it("ignores an unrecognized AI_PROVIDER and falls back to detection", () => {
    process.env.AI_PROVIDER = "not-a-provider";
    process.env.GEMINI_API_KEY = "gem-test";
    expect(resolveAiProviderFromEnv()).toBe("gemini");
  });
});
