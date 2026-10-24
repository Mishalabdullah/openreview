import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  on,
} from "solid-js";
import {
  agentStorageKey,
  commitTypes,
  defaultAgentConfig,
  parseAgentConfig,
  resolveAgent,
  validateAgentConfig,
} from "../lib/agent-config";
import type {
  AgentConfig,
  AgentRule,
  ModelDefinition,
} from "../lib/agent-config";
import { Plus, X, ArrowRight } from "lucide-solid";

export default function ModelsPage(props: { userId: string }) {
  const [tab, setTab] = createSignal<"agents" | "models">("agents");
  const [config, setConfig] = createSignal<AgentConfig>(defaultAgentConfig());
  const [saved, setSaved] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [error, setError] = createSignal("");
  const [preview, setPreview] = createSignal("feat(auth): add GitHub sign-in");
  const serialized = createMemo(() => JSON.stringify(config()));
  const dirty = createMemo(() => serialized() !== saved());
  const route = createMemo(() => resolveAgent(preview(), config()));
  const modelsById = createMemo(
    () => new Map(config().models.map((entry) => [entry.id, entry])),
  );
  const rulesById = createMemo(
    () => new Map(config().rules.map((entry) => [entry.id, entry])),
  );
  const model = (id: string) => modelsById().get(id)!;
  const rule = (id: string) => rulesById().get(id)!;
  const updateModel = (id: string, update: Partial<ModelDefinition>) => {
    setConfig((current) => ({
      ...current,
      models: current.models.map((entry) =>
        entry.id === id ? { ...entry, ...update } : entry,
      ),
    }));
    setNotice("");
    setError("");
  };
  const updateRule = (id: string, update: Partial<AgentRule>) => {
    setConfig((current) => ({
      ...current,
      rules: current.rules.map((entry) =>
        entry.id === id ? { ...entry, ...update } : entry,
      ),
    }));
    setNotice("");
    setError("");
  };
  createEffect(
    on(
      () => props.userId,
      (userId) => {
        let next = defaultAgentConfig();
        setError("");
        setNotice("");
        try {
          const raw = localStorage.getItem(agentStorageKey(userId));
          if (raw) {
            const parsed = parseAgentConfig(raw);
            if (parsed) next = parsed;
            else
              setError(
                "The saved draft could not be read. Starter rules are shown; save to replace the invalid draft.",
              );
          }
        } catch {
          setError(
            "Browser storage is unavailable. You can edit and preview, but saving may not work.",
          );
        }
        setConfig(next);
        setSaved(JSON.stringify(next));
      },
    ),
  );

  function save() {
    const problem = validateAgentConfig(config());
    if (problem) {
      setError(problem);
      return;
    }
    try {
      const value = serialized();
      localStorage.setItem(agentStorageKey(props.userId), value);
      setSaved(value);
      setError("");
      setNotice(
        "Draft saved in this browser. No live review settings were changed.",
      );
    } catch {
      setError(
        "Could not save the draft. Allow browser storage and try again.",
      );
    }
  }

  function addAgent() {
    if (!config().models.length) {
      setError("Add a model before creating an agent.");
      setTab("models");
      return;
    }
    const nextType = commitTypes.find(
      ([type]) => !config().rules.some((entry) => entry.commitType === type),
    );
    setConfig((current) => ({
      ...current,
      rules: [
        ...current.rules,
        {
          id: crypto.randomUUID(),
          name: nextType ? `${nextType[1]} reviewer` : "Custom reviewer",
          commitType: nextType?.[0] ?? "custom",
          modelId: current.models[0].id,
          enabled: true,
        },
      ],
    }));
    setNotice("");
  }

  const ModelOptions = () => (
    <For each={config().models}>
      {(entry) => (
        <option value={entry.id}>{entry.name || "Unnamed model"}</option>
      )}
    </For>
  );

  return (
    <div class="configuration-page">
      <div class="config-draft-banner">
        <span class="config-status-dot" aria-hidden="true" />
        <div>
          <strong>Design your review team</strong>
          <p>
            Local draft only. Model credentials, validation, and automated PR
            reviews are not connected yet.
          </p>
        </div>
        <span class="config-badge">Preview</span>
      </div>
      <div class="config-toolbar">
        <div class="config-tabs" aria-label="Models and agents views">
          <button
            type="button"
            aria-pressed={tab() === "agents"}
            classList={{ selected: tab() === "agents" }}
            onClick={() => setTab("agents")}
          >
            Agent configuration <span>{config().rules.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab() === "models"}
            classList={{ selected: tab() === "models" }}
            onClick={() => setTab("models")}
          >
            Models <span>{config().models.length}</span>
          </button>
        </div>
        <button type="button" class="button config-save" onClick={save}>
          Save local draft{dirty() ? " •" : ""}
        </button>
      </div>
      <Show when={error()}>
        <p class="api-notice" role="alert">
          {error()}
        </p>
      </Show>
      <p class="config-save-status" role="status">
        {notice() ||
          (dirty()
            ? "Unsaved draft changes"
            : "Draft stays on this device, for your account only.")}
      </p>

      <Show when={tab() === "agents"}>
        <section class="config-section" aria-labelledby="agents-title">
          <div class="config-section-heading">
            <div>
              <p class="dashboard-eyebrow">01 / Commit routing</p>
              <h2 id="agents-title">The right agent for every change.</h2>
              <p>Map a commit prefix to a dedicated reviewer and model.</p>
            </div>
            <button
              type="button"
              class="dashboard-control"
              disabled={config().rules.length >= 100}
              onClick={addAgent}
            >
              <Plus size={15} aria-hidden="true" /> Add agent
            </button>
          </div>
          <div class="agent-rules">
            <For
              each={config().rules.map((entry) => entry.id)}
              fallback={
                <div class="dashboard-empty-state">
                  <h3>Your team starts here</h3>
                  <p>Add an agent to route a commit type to a model.</p>
                </div>
              }
            >
              {(id) => (
                <article
                  class="agent-rule"
                  classList={{ "agent-disabled": !rule(id).enabled }}
                >
                  <div class="agent-rule-top">
                    <span class="commit-type-chip">
                      {rule(id).commitType || "type"}:
                    </span>
                    <label class="config-check">
                      <input
                        type="checkbox"
                        checked={rule(id).enabled}
                        onChange={(event) =>
                          updateRule(id, {
                            enabled: event.currentTarget.checked,
                          })
                        }
                      />
                      Enabled<span class="sr-only"> for {rule(id).name}</span>
                    </label>
                  </div>
                  <div class="agent-rule-fields">
                    <label>
                      Agent name
                      <input
                        maxLength={80}
                        value={rule(id).name}
                        onInput={(event) =>
                          updateRule(id, { name: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label>
                      Commit type
                      <input
                        list="commit-type-options"
                        maxLength={40}
                        value={rule(id).commitType}
                        onInput={(event) =>
                          updateRule(id, {
                            commitType: event.currentTarget.value
                              .toLowerCase()
                              .trim(),
                          })
                        }
                      />
                    </label>
                    <span class="routing-arrow" aria-hidden="true">
                      <ArrowRight size={16} class="inline-icon" />
                    </span>
                    <label>
                      Review model
                      <select
                        value={rule(id).modelId}
                        onChange={(event) =>
                          updateRule(id, { modelId: event.currentTarget.value })
                        }
                      >
                        <ModelOptions />
                      </select>
                    </label>
                    <button
                      type="button"
                      class="config-remove"
                      aria-label={`Remove ${rule(id).name || "agent"}`}
                      onClick={() => {
                        setConfig((current) => ({
                          ...current,
                          rules: current.rules.filter(
                            (entry) => entry.id !== id,
                          ),
                        }));
                        setNotice("");
                      }}
                    >
                      <X size={18} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              )}
            </For>
          </div>
          <datalist id="commit-type-options">
            <For each={commitTypes}>
              {([type, label]) => <option value={type}>{label}</option>}
            </For>
          </datalist>
          <div class="config-fallback">
            <div>
              <h3>Unmatched commit types</h3>
              <p>
                Choose a fallback for valid prefixes without an enabled agent.
              </p>
            </div>
            <label>
              <span class="sr-only">Fallback model</span>
              <select
                value={config().fallbackModelId}
                onChange={(event) => {
                  setConfig((current) => ({
                    ...current,
                    fallbackModelId: event.currentTarget.value,
                  }));
                  setNotice("");
                }}
              >
                <option value="">No agent — skip review</option>
                <ModelOptions />
              </select>
            </label>
          </div>
        </section>
        <section class="config-preview" aria-labelledby="preview-title">
          <div>
            <p class="dashboard-eyebrow">02 / Test the match</p>
            <h2 id="preview-title">Try a commit message</h2>
            <p>
              Preview one commit at a time. Scoped types and breaking-change
              markers are supported.
            </p>
          </div>
          <label>
            Commit message
            <input
              value={preview()}
              maxLength={500}
              placeholder="security(api): validate webhook signatures"
              onInput={(event) => setPreview(event.currentTarget.value)}
            />
          </label>
          <div class="routing-result" role="status">
            <span class="commit-type-chip">
              {route().type ? `${route().type}:` : "No prefix"}
            </span>
            <ArrowRight size={16} aria-hidden="true" />
            <div>
              <strong>
                {route().model
                  ? `${route().rule?.name ?? "Fallback"} · ${route().model!.name}`
                  : "No agent matched"}
              </strong>
              <p>
                {route().model
                  ? "Preview only — no model request is sent."
                  : "Use type(scope): description or add a matching rule / fallback."}
              </p>
            </div>
          </div>
          <p class="config-footnote">
            Security routing matches the explicit <code>security:</code> prefix.
            It does not scan commit text, PR labels, or detect vulnerabilities.
            Multi-commit PR aggregation needs a backend policy.
          </p>
        </section>
      </Show>

      <Show when={tab() === "models"}>
        <section class="config-section" aria-labelledby="models-title">
          <div class="config-section-heading">
            <div>
              <p class="dashboard-eyebrow">01 / Model library</p>
              <h2 id="models-title">Different strengths. One review team.</h2>
              <p>
                Name your models, then assign them to agents. These entries are
                not a verified model catalog.
              </p>
            </div>
            <button
              type="button"
              class="dashboard-control"
              disabled={config().models.length >= 50}
              onClick={() => {
                setConfig((current) => ({
                  ...current,
                  models: [
                    ...current.models,
                    {
                      id: crypto.randomUUID(),
                      name: "New model",
                      provider: "Custom",
                      modelId: "",
                    },
                  ],
                }));
                setNotice("");
              }}
            >
              <Plus size={15} aria-hidden="true" /> Add model
            </button>
          </div>
          <div class="model-library">
            <For
              each={config().models.map((entry) => entry.id)}
              fallback={
                <div class="dashboard-empty-state">
                  <h3>No models configured</h3>
                  <p>Add a model to start building agents.</p>
                </div>
              }
            >
              {(id, index) => (
                <article class="model-definition">
                  <div class="model-definition-heading">
                    <span class="model-monogram" aria-hidden="true">
                      {String(index() + 1).padStart(2, "0")}
                    </span>
                    <span class="config-badge">Not connected</span>
                  </div>
                  <label>
                    Display name
                    <input
                      maxLength={80}
                      value={model(id).name}
                      onInput={(event) =>
                        updateModel(id, { name: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label>
                    Provider
                    <input
                      maxLength={80}
                      value={model(id).provider}
                      onInput={(event) =>
                        updateModel(id, { provider: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label>
                    Provider model ID
                    <input
                      maxLength={160}
                      placeholder="Exact model ID from your provider"
                      value={model(id).modelId}
                      onInput={(event) =>
                        updateModel(id, { modelId: event.currentTarget.value })
                      }
                    />
                  </label>
                  <p class="config-footnote">
                    Public model identifier only. Never enter API keys or
                    tokens.
                  </p>
                  <div class="model-definition-footer">
                    <span>
                      {
                        config().rules.filter((entry) => entry.modelId === id)
                          .length
                      }{" "}
                      assigned agents
                    </span>
                    <button
                      type="button"
                      class="config-text-button"
                      disabled={
                        config().rules.some((entry) => entry.modelId === id) ||
                        config().fallbackModelId === id
                      }
                      onClick={() => {
                        setConfig((current) => ({
                          ...current,
                          models: current.models.filter(
                            (entry) => entry.id !== id,
                          ),
                        }));
                        setNotice("");
                      }}
                      title="Unassign agents and fallback before removing a model"
                    >
                      Remove model
                    </button>
                  </div>
                </article>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}
