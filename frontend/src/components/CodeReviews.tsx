import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { ApiError, apiFetch, createApiClient } from "../lib/api";
import type { PullRequest, ReviewRun } from "../lib/github-types";

async function mutation(path: `/api/${string}`, body?: unknown) {
  const response = await apiFetch(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, value.error?.code ?? "UNKNOWN_ERROR");
  return value;
}

export function RepositoryReviewSettings(props: { repositoryId: string }) {
  const [settings, setSettings] = createSignal<{
    available: boolean;
    enabled: boolean;
    canAdmin: boolean;
  }>();
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const request = createApiClient();
  createEffect(() => {
    const id = props.repositoryId;
    const controller = new AbortController();
    setSettings(undefined);
    setError("");
    void request<{
      data: { available: boolean; enabled: boolean; canAdmin: boolean };
    }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/reviews/settings`,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setSettings(result.data);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    onCleanup(() => controller.abort());
  });
  async function toggle() {
    const id = props.repositoryId;
    setSaving(true);
    setError("");
    try {
      const result = await mutation(
        `/api/v1/repositories/${encodeURIComponent(id)}/reviews/settings`,
        { enabled: !settings()?.enabled },
      );
      if (id === props.repositoryId) setSettings(result.data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to change review settings.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      class="code-review-settings"
      aria-label="Automatic code review settings"
    >
      <div>
        <strong>Automatic code reviews</strong>
        <p>
          When enabled, non-draft PR changes are sent to OpenAI. Informational
          reviews are saved here and posted by the GitHub App.
        </p>
      </div>
      <Show when={settings()}>
        {(value) => (
          <>
            <span>
              {!value().available
                ? "Backend setup required"
                : value().enabled
                  ? "Enabled"
                  : "Disabled"}
            </span>
            <Show when={value().canAdmin && value().available}>
              <button
                class="dashboard-control"
                disabled={saving()}
                onClick={() => void toggle()}
              >
                {saving()
                  ? "Saving…"
                  : value().enabled
                    ? "Disable reviews"
                    : "Enable reviews"}
              </button>
            </Show>
            <Show when={!value().canAdmin}>
              <small>A repository administrator must enable reviews.</small>
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}

export function CodeReview(props: { pull: PullRequest }) {
  const [open, setOpen] = createSignal(false);
  const [run, setRun] = createSignal<ReviewRun | null>(
    props.pull.appReview ?? null,
  );
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const [settings, setSettings] = createSignal<{
    available: boolean;
    enabled: boolean;
    canAdmin: boolean;
  } | null>(null);
  const [settingsLoading, setSettingsLoading] = createSignal(false);
  const request = createApiClient();
  createEffect(() => setRun(props.pull.appReview ?? null));
  createEffect(() => {
    if (!open()) return;
    revision();
    const repositoryId = props.pull.repository.id;
    const controller = new AbortController();
    setSettingsLoading(true);
    void request<{
      data: { available: boolean; enabled: boolean; canAdmin: boolean };
    }>(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/reviews/settings`,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setSettings(result.data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSettings(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSettingsLoading(false);
      });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    if (!open()) return;
    revision();
    const repositoryId = props.pull.repository.id;
    const number = props.pull.number;
    const sha = props.pull.head.sha;
    const controller = new AbortController();
    let timer: number | undefined;
    let polls = 0;
    async function load() {
      try {
        const result = await request<{ data: ReviewRun[] }>(
          `/api/v1/repositories/${repositoryId}/pull-requests/${number}/reviews`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const value =
          result.data.find((item) => item.headSha === sha) ??
          result.data[0] ??
          null;
        setRun(value);
        setError("");
        if (
          value &&
          (value.status === "queued" ||
            value.status === "reviewing" ||
            (value.status === "completed" &&
              value.publicationStatus === "pending")) &&
          polls++ < 60
        )
          timer = window.setTimeout(() => void load(), 5000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load review.",
          );
        }
      }
    }
    void load();
    onCleanup(() => {
      controller.abort();
      window.clearTimeout(timer);
    });
  });
  async function start() {
    setBusy(true);
    setError("");
    try {
      await mutation(
        `/api/v1/repositories/${props.pull.repository.id}/pull-requests/${props.pull.number}/reviews`,
      );
      setOpen(true);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to request review.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      class="code-review"
      aria-label={`OpenReview for PR ${props.pull.number}`}
    >
      <div class="code-review-heading">
        <button
          class="dashboard-control"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          OpenReview · {run()?.status ?? "Not reviewed"} {open() ? "−" : "+"}
        </button>
        <Show when={run()?.githubReviewUrl}>
          {(url) => (
            <a href={url()} target="_blank" rel="noopener noreferrer">
              View on GitHub ↗
            </a>
          )}
        </Show>
      </div>
      <Show when={open()}>
        <Show
          when={run()}
          fallback={
            <p>
              No saved review for this PR yet. Enable reviews for its repository
              before requesting one.
            </p>
          }
        >
          {(value) => (
            <>
              <p class="section-message">
                Commit <code>{value().headSha.slice(0, 12)}</code> · GitHub:{" "}
                {value().publicationStatus}
              </p>
              <Show when={value().headSha !== props.pull.head.sha}>
                <p role="status">This review is for an older commit.</p>
              </Show>
              <Show when={value().errorCode}>
                <p role="alert">
                  Review needs attention: {value().errorCode}. You can retry
                  after resolving configuration or access issues.
                </p>
              </Show>
              <Show when={value().result}>
                {(result) => (
                  <>
                    <p class="code-review-summary">{result().summary}</p>
                    <Show when={result().partial}>
                      <p class="section-message">
                        Partial coverage—see limitations below.
                      </p>
                    </Show>
                    <ol class="code-review-findings">
                      <For each={result().findings}>
                        {(finding) => (
                          <li>
                            <strong>
                              {finding.severity.toUpperCase()} · {finding.title}
                            </strong>
                            <code>
                              {finding.path}:{finding.line}
                            </code>
                            <p>{finding.description}</p>
                          </li>
                        )}
                      </For>
                    </ol>
                    <Show when={!result().findings.length}>
                      <p>No actionable findings in the reviewed scope.</p>
                    </Show>
                    <ul class="section-message">
                      <For each={result().limitations}>
                        {(limitation) => <li>{limitation}</li>}
                      </For>
                    </ul>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
        <div class="code-review-actions">
          <button
            class="dashboard-control"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh status
          </button>
          <Show when={props.pull.state === "open" && !props.pull.draft}>
            <button
              class="dashboard-control"
              disabled={
                busy() ||
                run()?.status === "queued" ||
                run()?.status === "reviewing"
              }
              onClick={() => void start()}
            >
              {busy() ? "Requesting…" : "Request / retry review"}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}
