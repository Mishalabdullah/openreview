export type ModelDefinition = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
};
export type AgentRule = {
  id: string;
  commitType: string;
  name: string;
  modelId: string;
  enabled: boolean;
};
export type AgentConfig = {
  version: 1;
  models: ModelDefinition[];
  rules: AgentRule[];
  fallbackModelId: string;
};

export const commitTypes = [
  ["feat", "Features", "New capabilities and product improvements"],
  ["fix", "Bug fixes", "Corrections and regression fixes"],
  ["security", "Security", "Security-focused changes and hardening"],
  ["refactor", "Refactoring", "Structural changes without new behavior"],
  ["perf", "Performance", "Speed, memory, and efficiency improvements"],
  ["docs", "Documentation", "Guides, references, and written content"],
  ["test", "Tests", "Test coverage and test infrastructure"],
  ["chore", "Maintenance", "Routine upkeep and dependencies"],
  ["build", "Build", "Build system and dependency changes"],
  ["ci", "CI", "Continuous integration workflows"],
  ["style", "Style", "Formatting and code style"],
  ["revert", "Reverts", "Reversals of previous changes"],
] as const;

export function defaultAgentConfig(): AgentConfig {
  return {
    version: 1,
    models: [
      { id: "gpt-sol", name: "GPT Sol", provider: "OpenAI", modelId: "" },
      { id: "glm", name: "GLM", provider: "Z.ai", modelId: "" },
    ],
    rules: [
      {
        id: "features",
        commitType: "feat",
        name: "Feature reviewer",
        modelId: "gpt-sol",
        enabled: true,
      },
      {
        id: "security",
        commitType: "security",
        name: "Security reviewer",
        modelId: "glm",
        enabled: true,
      },
    ],
    fallbackModelId: "",
  };
}

export function validateAgentConfig(config: AgentConfig): string | null {
  const ids = new Set(config.models.map((model) => model.id));
  if (
    new Set(config.rules.map((rule) => rule.id)).size !== config.rules.length ||
    config.rules.some((rule) => !rule.id)
  )
    return "Each agent must have a unique identifier.";
  if (config.models.length > 50 || config.rules.length > 100)
    return "Keep the draft to 50 models and 100 agents or fewer.";
  if (
    ids.size !== config.models.length ||
    config.models.some(
      (model) => !model.id || !model.name.trim() || !model.provider.trim(),
    )
  )
    return "Give each model a name and provider.";
  if (config.fallbackModelId && !ids.has(config.fallbackModelId))
    return "Choose an existing fallback model.";
  const types = new Set<string>();
  for (const rule of config.rules) {
    if (!rule.name.trim()) return "Give each agent a name.";
    if (!/^[a-z][a-z0-9-]*$/.test(rule.commitType))
      return "Commit types must start with a letter and contain only lowercase letters, numbers, or hyphens.";
    if (!ids.has(rule.modelId)) return "Choose a model for every agent.";
    if (rule.enabled && types.has(rule.commitType))
      return `Only one enabled agent can handle ${rule.commitType}: commits.`;
    if (rule.enabled) types.add(rule.commitType);
  }
  return null;
}

/** Preview only. No review execution is performed in the browser. */
export function resolveAgent(message: string, config: AgentConfig) {
  const match = /^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?!?:\s+\S/i.exec(
    message.trim(),
  );
  if (!match) return { type: null, rule: null, model: null };
  const type = match[1].toLowerCase();
  const rule =
    config.rules.find((entry) => entry.enabled && entry.commitType === type) ??
    null;
  const model =
    config.models.find(
      (entry) => entry.id === (rule?.modelId ?? config.fallbackModelId),
    ) ?? null;
  return { type, rule, model };
}

export const agentStorageKey = (userId: string) =>
  `openreview:agent-draft:v1:${encodeURIComponent(userId)}`;

export function parseAgentConfig(raw: string): AgentConfig | null {
  try {
    const config = JSON.parse(raw);
    if (
      config?.version !== 1 ||
      !Array.isArray(config.models) ||
      !Array.isArray(config.rules) ||
      typeof config.fallbackModelId !== "string"
    )
      return null;
    if (
      !config.models.every(
        (model: ModelDefinition) =>
          model &&
          [model.id, model.name, model.provider, model.modelId].every(
            (value) => typeof value === "string",
          ),
      )
    )
      return null;
    if (
      !config.rules.every(
        (rule: AgentRule) =>
          rule &&
          [rule.id, rule.name, rule.commitType, rule.modelId].every(
            (value) => typeof value === "string",
          ) &&
          typeof rule.enabled === "boolean",
      )
    )
      return null;
    return validateAgentConfig(config) ? null : config;
  } catch {
    return null;
  }
}
