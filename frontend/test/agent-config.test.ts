import { describe, expect, it } from "vitest";
import {
  agentStorageKey,
  defaultAgentConfig,
  parseAgentConfig,
  resolveAgent,
  validateAgentConfig,
} from "../src/lib/agent-config";
import { dashboardView } from "../src/lib/dashboard-data";

describe("agent configuration drafts", () => {
  it("routes feature and explicit security commits to their configured models", () => {
    const config = defaultAgentConfig();
    expect(resolveAgent("feat: add sign-in", config).model?.name).toBe(
      "GPT Sol",
    );
    expect(
      resolveAgent("security(api)!: validate signatures", config).model?.name,
    ).toBe("GLM");
    expect(
      resolveAgent("feat(auth): security settings", config).model?.name,
    ).toBe("GPT Sol");
  });
  it("supports each configured conventional type and custom prefixes", () => {
    const config = defaultAgentConfig();
    config.rules.push({
      id: "custom",
      name: "Dependency reviewer",
      commitType: "deps",
      modelId: "glm",
      enabled: true,
    });
    expect(resolveAgent("deps: update libraries", config).rule?.name).toBe(
      "Dependency reviewer",
    );
    expect(resolveAgent("FEAT!: new API", config).model?.name).toBe("GPT Sol");
  });
  it("supports fallback models and ignores disabled agents", () => {
    const config = defaultAgentConfig();
    config.rules[0].enabled = false;
    expect(resolveAgent("feat: add sign-in", config).model).toBeNull();
    config.fallbackModelId = "glm";
    expect(resolveAgent("feat: add sign-in", config).model?.name).toBe("GLM");
    expect(resolveAgent("fix: correct redirect", config).model?.name).toBe(
      "GLM",
    );
    expect(resolveAgent("no conventional prefix", config).model).toBeNull();
    expect(resolveAgent("feat:", config).model).toBeNull();
  });
  it("rejects duplicate enabled commit types but permits disabled drafts", () => {
    const config = defaultAgentConfig();
    config.rules.push({ ...config.rules[0], id: "duplicate" });
    expect(validateAgentConfig(config)).toContain("Only one enabled");
    config.rules[2].enabled = false;
    expect(validateAgentConfig(config)).toBeNull();
  });
  it("rejects missing models, invalid prefixes, and empty names", () => {
    const config = defaultAgentConfig();
    config.rules[0].modelId = "missing";
    expect(validateAgentConfig(config)).toContain("Choose a model");
    config.rules[0].modelId = "gpt-sol";
    config.rules[0].commitType = "feat:";
    expect(validateAgentConfig(config)).toContain("Commit types");
    config.rules[0].commitType = "feat";
    config.models[0].name = " ";
    expect(validateAgentConfig(config)).toContain("name and provider");
  });
  it("round-trips valid drafts and rejects corrupted storage", () => {
    const config = defaultAgentConfig();
    expect(parseAgentConfig(JSON.stringify(config))).toEqual(config);
    for (const value of [
      "null",
      "{",
      '{"version":2}',
      JSON.stringify({ ...config, models: [null] }),
      JSON.stringify({ ...config, rules: [{}] }),
    ])
      expect(parseAgentConfig(value)).toBeNull();
    expect(agentStorageKey("user-a")).not.toBe(agentStorageKey("user-b"));
  });
});

describe("dashboard configuration routes", () => {
  it("recognizes direct page loads and history destinations", () => {
    expect(dashboardView("/dashboard/models")).toBe("models");
    expect(dashboardView("/dashboard/settings")).toBe("settings");
    expect(dashboardView("/dashboard/review-rules")).toBe("review-rules");
    expect(dashboardView("/dashboard/pull-requests")).toBe("pull-requests");
    expect(dashboardView("/dashboard/unknown")).toBe("overview");
  });
});
