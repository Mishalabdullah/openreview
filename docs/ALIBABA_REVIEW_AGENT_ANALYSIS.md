# Alibaba OpenCodeReview: implementation analysis and adoption plan

## 1. Executive recommendation

Adopt the **deterministic review pipeline surrounding a bounded context-retrieval agent**, not the entire Go CLI or its defaults. Keep our GitHub App, authenticated dashboard, PostgreSQL job state, Cloudflare Queue, stale-SHA checks, and publication reconciliation.

Our largest quality opportunity is to replace one PR-wide model snapshot with small related-file review units that can request narrowly scoped source context. Our largest reliability opportunity is to record exactly what each unit reviewed, skipped, or failed. Build these together: a more capable agent without coverage accounting and aggregate spending controls would be a regression.

Recommended order:

1. Establish quality fixtures and token/cost measurements.
2. Add deterministic file selection, coverage records, and real backend review configuration.
3. Add related-file grouping and resumable unit execution.
4. Add read-only, commit-pinned context tools and evidence-based anchors.
5. Add selective finding verification and cross-push finding tracking.
6. Add optional deeper review, more providers, and scan/export integrations after evaluation.

This document is research and a proposed design. None of the proposed features has been implemented by this analysis.

## 2. Snapshot, method, and limits

- Upstream: <https://github.com/alibaba/open-code-review>.
- Analyzed revision: [`375f64cd6f67a48a135da83cfcf59c52669a09cb`](https://github.com/alibaba/open-code-review/tree/375f64cd6f67a48a135da83cfcf59c52669a09cb), shallow-cloned from `main` on 2026-10-24.
- Inventory: **1,125 tracked files; 191 non-test Go files; 315 Go test files; 57 embedded rule documents**. These counts include the independent ACP module.
- Method: repository-wide structural inventory, direct inspection of review orchestration, grouping, selection, rule resolution, prompts, tools, anchoring, loop/compression, manifests/resume, scan, provider contracts, telemetry, GitHub publication/checkpoint logic, representative tests, and integration entry points. Compared against our current execution, schema, webhook, authorization routes, and frontend configuration code.
- Depth is greatest in the review engine and GitHub integration. IDE/platform packaging, translations, and site assets were inventoried and sampled, not audited line by line. This is not a claim that every line of all 1,125 files has been verified.
- Upstream tests and benchmarks were **not executed**. No paid model calls, live reviews, deployments, or upstream modifications were made. A test's existence is evidence of intended behavior, not proof of a passing run here.
- The README's Alibaba-scale deployment history and benchmark improvements are upstream claims, not measurements reproduced for our product or model.
- Source takes precedence over documentation. For example, current grouping uses integer file indices and skips an LLM grouping call for small changesets; the architecture page still describes an older path-based, always-grouping flow. Current selection also includes a secret-path gate absent from that page's five-gate description.

## 3. Repository map

| Area                                                           | Implementation responsibility                                                                           | Relevance to us                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `cmd/opencodereview/`                                          | CLI configuration, review/scan/delegate commands, output, SARIF, sessions                               | Reuse behavior/contracts, not CLI hosting                            |
| `internal/agent/`                                              | Review orchestration, selection, grouping, planning, rounds, coverage identity                          | Highest                                                              |
| `internal/llmloop/`                                            | Tool-use loop, completion/stop classification, compression, comment workers                             | Highest, but use much smaller bounds                                 |
| `internal/config/`                                             | Embedded prompts, rules, file filters, effort presets, extension sniffing                               | High; curate rule content                                            |
| `internal/diff/`, `internal/gitcmd/`                           | Git snapshots, patch parsing, hunk coordinates, snippet resolution                                      | High concepts; Git subprocess implementation does not fit our Worker |
| `internal/tool/`                                               | File read/find, search, diff read, finding collection, task completion                                  | High; adapt to authenticated snapshot access                         |
| `internal/llm/`                                                | Provider protocols, native conversation replay, retries and usage                                       | Medium-high                                                          |
| `internal/session/`                                            | JSONL persistence, immutable coverage manifests, resume identity, comparison                            | High concepts; use PostgreSQL instead of local files                 |
| `internal/scan/`                                               | Full-file audit pipeline, batching, deduplication, project summary                                      | Later, opt-in product capability                                     |
| `scripts/github-actions/post-review-comments.js`, `action.yml` | Posting, reconciliation, routing, sticky summaries, incremental comments, checkpoints, outdated threads | High                                                                 |
| `internal/viewer/`                                             | Session browser, trace inspection, comparisons, HTML export, local marks                                | Useful dashboard ideas, not a hosted multi-user access model         |
| `internal/telemetry/`                                          | Optional OpenTelemetry traces and metrics                                                               | High concepts; private-code retention needs separate design          |
| `internal/mcp/`                                                | External MCP tool client/registry integration                                                           | Later; not unrestricted customer-supplied tools                      |
| `extensions/`                                                  | VS Code/JetBrains hosts and shared webview; local CLI execution                                         | Separate future distribution channel                                 |
| `plugins/`, `skills/`, `internal/delegate/`                    | Host-agent integrations and deterministic review specifications                                         | Later local/developer integrations                                   |
| `acp/`                                                         | Independent experimental ACP stdio adapter and process lifecycle                                        | Not needed for our hosted PR-review MVP                              |
| `npm/`, `bin/`, install/release scripts, `pages/`              | Distribution, platform binaries, documentation/site                                                     | Operational reference, not review intelligence                       |

## 4. How their review actually works

```text
resolve config/provider/prompts/rules
  → freeze Git input and load diffs
  → populate read-only diff lookup
  → deterministic per-file selection
  → seal the selected-file coverage denominator
  → validate/reuse eligible checkpoints
  → partition remaining files into groups
  → bounded concurrent group execution
      → optional planning request
      → tool-use review loop
      → snippet/location processing
      → narrow contradiction filter
      → optional additional review round
  → finalize coverage and persist session
  → render / publish / export
```

### 4.1 Selection is code, not model judgment

`internal/agent/selection.go` applies binary and secret-path rejection before user excludes/includes, extension eligibility, default noise filtering, deletion classification, and per-file prompt-size rejection. Explicit excludes win over includes; includes can override ordinary noise filters but not the secret gate. Deleted files are retained as change context but are not dispatched as new-code review items.

Preview and actual execution share the same selection function. This prevents a UI claiming it will review files that execution silently filters differently.

**Adaptation:** one pure selector shared by preview, dispatch, and coverage reporting. Preserve deletions and renames as context for regressions. Do not blanket-exclude tests: removed assertions, security-test changes, broken fixtures, and implementation/test mismatches can matter. Filter generated output and vendor directories aggressively; summarize lockfile/dependency changes through a separate bounded path rather than treating every generated line as source.

### 4.2 Grouping preserves coverage even when the model misbehaves

`internal/agent/grouping.go` uses metadata only: indexed path, change status, and addition/deletion counts. The response refers to integer indices rather than repeating long paths, reducing output size. Invalid indices are ignored; duplicates are assigned once; omitted files receive singleton groups. Groups larger than ten files are split. Combined diffs that exceed the group budget fall back to singleton units. Grouping failure also falls back to single-file execution.

Current embedded thresholds: fewer than four files bypass LLM grouping; those changes are bundled when total churn is under 200 lines, otherwise reviewed per file. Zero/one-file paths short-circuit separately.

**Adaptation:** begin with deterministic affinity grouping: source/test pairs, handler/service/schema changes, translation variants, and same-module files. Allow optional metadata-only model grouping for difficult large changesets. Validate the result as an exact partition. Grouping improves attention and cross-file reasoning; it is not a dependency graph or semantic proof. Keep a cross-unit context mechanism for contracts spanning groups.

### 4.3 Planning and repeated review are separate decisions

Planning is one no-tool LLM request, enabled for a file with at least 50 changed lines or a multi-file group with at least 100 total changed lines. Its output guides the first review round. Plan failure does not stop the main review.

Review effort maps to one, two, or three rounds. Later rounds receive confirmed findings and omit the earlier plan, avoiding a fixed checklist becoming the limit of exploration. Execution stops early when no new findings appear or a cap/budget is reached.

**Adaptation:** one review round by default. Make an additional pass opt-in or risk-triggered, and measure its incremental true findings per additional token. Do not confuse review rounds with the model's reasoning-effort parameter; they are distinct spending controls. Do not route solely on a user-controlled `fix:`/`security:` commit prefix.

### 4.4 The useful agent capability is targeted context retrieval

Built-in tools cover `file_read`, `file_find`, `file_read_diff`, `code_search`, `code_comment`, and `task_done`. File reading returns numbered windows capped at 500 lines. Search uses Git-backed fixed-string matching by default, supports optional regex, limits rendered matches, and reports truncation. File discovery and reads use the reviewed ref in commit/range mode rather than whatever happens to be checked out.

This lets the reviewer inspect a changed function's callers, authorization helpers, types, schema, or tests before making a claim. It is not an AST call graph, embedding search engine, compiler, or test executor.

**Adaptation:** expose a much smaller read-only contract backed by a pinned repository/commit snapshot. Initial tools: `read_file(path, range)`, `read_diff(path)`, and `find_files(query)`. Add search over bounded fetched files first. Repository-wide search needs a snapshot/index; do not assume GitHub's ordinary code-search endpoint is an exact, installation-token-compatible search over an arbitrary PR head.

### 4.5 Tool-loop termination is engineered, but not a hard cost guarantee

The loop handles explicit completion/failure, cancellation, tool-request limits, repeated empty results, context pressure, and aggregate usage. It records tool failures and escalates repeated failures so a broken finding call does not repeatedly consume tokens. A final restricted grace request can submit findings when a budget is exhausted.

The template allows 100 tool-request iterations, an approximately 200,000-token input ceiling, and a 16,384-token output ceiling per request. Default group concurrency is eight. These are not sensible defaults for our low-cost hosted service.

**Adaptation:** reserve input/output allowances atomically before each request, including planning, grouping, validation, compression, and retries. Persist reservations so duplicate queue delivery cannot allocate spending twice. Initially use low concurrency and a small explicit tool-turn count. No unreserved grace request. A reported partial result must never be promoted into a claim of full coverage.

### 4.6 Comment anchoring is separate from bug discovery

Findings carry an `existing_code` excerpt. The resolver matches normalized lines against new-side hunks, then old-side hunks, then available new-file content. A cross-file fallback can refile a finding when exactly one other diff matches. An optional LLM relocation task tries to recover an unmatched excerpt. Unanchored findings retain zero line coordinates for downstream handling.

**Adaptation:** add exact evidence snippets to our finding schema, but use stricter publication rules. Require a unique match in the pinned file and a valid diff-side/range. Prefer exact matching before carefully constrained normalization; do not strip actual leading `+`/`-` operators or significant whitespace blindly. An LLM-suggested relocation must pass the same deterministic check. Never guess the nearest line. Keep an unanchored finding in the summary instead of losing it or creating a misleading inline comment.

### 4.7 The reflection/filter pass has a narrow purpose

The filter is instructed to remove only comments the supplied diff proves factually wrong. It is intentionally not an all-purpose usefulness or confidence judge: the first reviewer may have read context that this filter cannot see. Failures leave candidates intact. The removal tool asks for analysis before the IDs to remove; code comments explain this ordering was chosen to reduce contradictory decisions.

The user prompt goes further: memory safety, concurrency, linkage, behavioral/compatibility changes, and unused parameters are protected subjects that the filter must retain even when it thinks they are wrong. This recall-preserving policy is important: simply adding their filter is not equivalent to a comprehensive false-positive detector.

**Adaptation:** deterministic validation first, then selective fact-checking of ambiguous/high-impact findings using their actual evidence. Store accept/reject reasons for evaluation. Keep concise evidence summaries, not private model reasoning traces. Do not market another model's agreement as proof, and do not let a diff-only filter erase valid context-dependent findings.

### 4.8 Language rules are ordered prompt resolution

The system maps path globs to Markdown checklists, including languages, manifests, infrastructure, workflows, database schemas, and template formats. Resolution is ordered and first-match-wins. User rule layers are custom → project → global → embedded system. A user rule replaces the system rule unless `merge_system_rule` is enabled. The highest-priority layer with include/exclude filters supplies the filter set; it is not a union of every layer. `.m` content sniffing distinguishes Objective-C from MATLAB at the system layer.

**Adaptation:** small versioned correctness/security packs with explicit framework detection. Our frontend is Solid, so the bundled generic TS/JS checklist's React assumptions would be inappropriate. Its style rules (no nested ternaries, comments, spelling, `var`, etc.) also conflict with our actionable-bugs-only policy. Keep platform safety rules non-overridable; use administrator-controlled project rules from a trusted base revision or approved configuration, not instructions newly added by the PR being reviewed.

### 4.9 Sessions and manifests distinguish progress from success

Local JSONL stores execution events. A versioned immutable manifest records repository/input identity, model/config hashes, and selected/completed/reused/failed/waived sets. The selected set is frozen before dispatch; terminal state is derived from coverage rather than the number of findings. This records a valid no-findings review differently from an unreviewed file.

Coverage is an execution-accounting contract, not proof that the model inspected every line. A successful group completion marks its files complete, and some early-stop paths can mark files with collected findings complete. We should define our completion criteria explicitly rather than equating a finding's presence with exhaustive review.

Resume admission checks repository identity, input mode/content, rule identity, and explicit intent for provider/model changes. A moved ref cannot silently change the admitted input: sealed commit endpoints are reused. Only checkpoints backed by a completed/reused manifest item are eligible for reuse. This is stronger than simply loading whichever JSONL line looks successful.

**Adaptation:** PostgreSQL run/unit records and immutable input/config identities. Our existing run-level result persistence already prevents model re-execution on publication retry; add unit-level completion so one failed unit does not require rerunning all completed work. Do not reuse an unchanged diff across new commits without accounting for changed dependencies and context.

### 4.10 GitHub publication is a second substantial subsystem

The Action implementation goes beyond rendering findings:

- Sticky summary updates and category/severity routing to summary versus inline.
- Deterministic batches, comment IDs, and reconciliation after ambiguous writes.
- Incremental suppression using path/range overlap; configurable multi-line overlap threshold.
- Rate-limit-aware pacing using retry/reset headers and backoff.
- Optional outdated-thread reporting/resolution that checks own markers, bot identity, all visible participants, original location, and overlap with current findings. Human replies and uncertain views veto resolution.
- Cross-push checkpoints: review previous covered head → new head only when base/config/ancestry are compatible; otherwise fall back to full scope. Reopened/ready-for-review events force full scope. Same-head reruns avoid overwriting prior findings with an empty result.
- Checkpoint advancement depends on adequate coverage and successful publication, not just a successful process exit.

**Adaptation:** retain our existing run-marker reconciliation and `COMMENT` reviews. Add persistent finding identities across heads before more aggressive delta review. Do not suppress every new issue at an occupied line: two unrelated bugs can share a location. Prefer rule/category plus evidence identity and mapped anchors. Use database checkpoints rather than treating editable PR comments as our authoritative state. Outdated-thread mutation should be opt-in after report-only validation; GitHub calling a thread outdated does not establish that the bug is fixed.

## 5. Our current baseline: verified in code

| Concern         | Current implementation                     | Meaning                                                                                                                                   |
| --------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Triggering      | `api-server/src/routes/review-webhook.ts`  | Signed, bounded webhook; selected non-draft PR actions; durable delivery/run deduplication                                                |
| Execution       | `api-server/src/lib/reviews/jobs.ts`       | Queue hints + DB authority, lease fencing, retries/recovery, disabled-repository checks                                                   |
| GitHub input    | `api-server/src/lib/reviews/github.ts:156` | First 100 changed files; 90,000-character shared diff/source budget; up to five source files, each at most 20,000 bytes by metadata check |
| Source identity | Same file                                  | Fetches source at the requested head SHA and rejects superseded jobs                                                                      |
| Model           | `api-server/src/lib/reviews/model.ts:55`   | One OpenAI Responses request, 90-second timeout, 6,000 output tokens, low reasoning for default `gpt-5-mini`                              |
| Findings        | Same file                                  | Structured result; at most 12 findings; path/line/severity/text/single-line suggestion                                                    |
| Publication     | `api-server/src/lib/reviews/github.ts:286` | Bot/run/SHA marker reconciliation; live SHA check; added-line anchors; summary fallback; informational review only                        |
| Visibility      | `api-server/src/routes/reviews.ts`         | Repository access checks for settings/history/manual requests; admin settings changes; write access for manual review                     |
| Storage         | `api-server/src/db/schema.ts`              | Run-level lifecycle/result/publication persistence; no review-unit or finding-lifecycle tables                                            |
| Rules/models UI | `frontend/src/lib/agent-config.ts`         | User-scoped local draft and commit-type preview, explicitly not browser execution; not backend rule/model routing                         |

Our current limits are defensible safety bounds, but file-order selection and fixed first-five context retrieval can spend the budget on low-value content while omitting the caller/schema needed to confirm a bug. Adding more input to the same prompt is not the best fix.

## 6. Feature adoption matrix

Priority: **P0** foundation/measurement; **P1** review quality; **P2** efficiency/workflow; **P3** expansion. Effort is relative: S, M, L, XL; not a calendar estimate. All rows marked proposed require implementation and evaluation.

| Feature/logic                        | Our state                                        | Recommendation                                                | Priority / effort | Cost implication                           |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------- | ----------------- | ------------------------------------------ |
| Shared selection/preview logic       | Basic input filter, no preview contract          | Adopt; deterministic reason per file                          | P0 / M            | Usually lowers waste                       |
| Expanded secret-path policy          | Partial regex exclusion                          | Adopt across selection AND every context tool                 | P0 / M            | Minimal runtime cost                       |
| Immutable input/config manifest      | Head SHA/model only                              | Add base, policy/prompt hashes, scope identity                | P0 / M            | Small DB overhead                          |
| Per-file/unit coverage               | Run partial flag + prose limits                  | Adopt explicit selected/reviewed/skipped/failed accounting    | P0 / L            | Small DB overhead                          |
| Usage and cost accounting            | Safe error diagnostics only                      | Record all request usage, retries, cache usage                | P0 / M            | Small telemetry overhead                   |
| Backend review rules/settings        | UI drafts only, enabled flag is live             | Implement admin-authorized versioned policies                 | P0 / L            | No inherent model increase                 |
| Precision/recall regression fixtures | Pipeline tests, no measured model benchmark here | Add offline labeled cases and separately approved model evals | P0 / M–L          | Evaluation calls need a budget             |
| Related-file grouping                | Single PR snapshot                               | Adopt deterministic first, optional LLM partition             | P1 / M–L          | Can reduce waste; more units may cost more |
| Resumable review units               | Run-level persistence only                       | Add unit lease/result persistence                             | P1 / L            | Avoids repeat analysis on unit retries     |
| Targeted file reads/discovery        | Up to five eager source files                    | Adopt commit-pinned read-only tools                           | P1 / L            | More API calls, better relevance           |
| Bounded code search                  | None                                             | Start within cached snapshot; index only if needed            | P1–P2 / L         | Repository indexing adds storage/work      |
| Evidence-based anchors               | Validate model-supplied added line               | Add excerpt + unique deterministic match                      | P1 / M            | No extra LLM required initially            |
| Multi-line suggestions               | Single-line suggestions only                     | Later, exact validated ranges only                            | P2 / M            | Small output increase                      |
| Language/framework rule packs        | Single generic instruction                       | Curate small bug/security packs                               | P1 / M            | Modest input increase                      |
| Selective contradiction checking     | No second review stage                           | Pilot for high-impact/ambiguous candidates                    | P1–P2 / M         | Extra request when triggered               |
| Within-run finding dedup             | No dedicated identity layer                      | Add stable evidence/rule fingerprints                         | P1 / M            | Low deterministic cost                     |
| Cross-push duplicate suppression     | Same-run reconciliation only                     | Add finding lifecycle and anchor mapping                      | P2 / L            | Reduces repeated comments                  |
| Sticky status/summary                | New review per new SHA                           | Optional compact current-status summary                       | P2 / M            | Additional GitHub writes                   |
| Delta-range reviews                  | Full supplied PR diff per head                   | Opt-in after coverage/identity tracking                       | P2 / L–XL         | Potentially large savings, recall risk     |
| Finding comparison                   | Run history only                                 | New/persisting/not-rechecked/no-longer-observed buckets       | P2 / M            | Mostly deterministic                       |
| Outdated thread handling             | None                                             | Report-only first; opt-in guarded mutations                   | P2 / L            | GraphQL calls and permission review        |
| Header-aware retry scheduling        | Typed retryable failures + queue recovery        | Persist next eligible attempt; honor provider hints           | P1 / M            | Avoids hot retries                         |
| Aggregate spend reservation          | Per-call/input/request bounds                    | Add atomic reservations before fan-out                        | P0–P1 / L         | Prevents multi-call runaway spend          |
| Effort modes                         | Fixed single call                                | Fast default; explicit deeper mode                            | P2 / M            | Deep mode explicitly costs more            |
| Planning stage                       | None                                             | Conditional pilot, not always-on                              | P2 / M            | Extra request                              |
| Memory compression                   | No growing conversation                          | Defer; enforce short loops first                              | P3 / L            | Extra requests and evidence-loss risk      |
| Multiple model protocols             | OpenAI Responses only                            | Add adapter interface, then one provider at a time            | P2 / L            | Model/provider dependent                   |
| Per-phase model routing              | No backend routing                               | Our own experiment; upstream uses one model per run           | P3 / L            | Needs quality/cost evaluation              |
| Findings feedback/triage             | No durable feedback layer                        | Persist scoped accept/dismiss reasons, audit actor            | P2 / M            | Cheap; learning is separate work           |
| Full-repository scan                 | None                                             | Separate explicit audit job with independent limits           | P3 / XL           | Potentially expensive                      |
| JSON/SARIF export                    | API result JSON only                             | Add versioned export; SARIF upload is separate                | P3 / M            | Low export cost                            |
| Session inspection                   | Run status/result only                           | Safe phase timeline, coverage, usage, retry reasons           | P1–P2 / M         | Bounded metadata retention                 |
| MCP context sources                  | None                                             | Approved read-only connectors only, later                     | P3 / XL           | Security and tenant-isolation overhead     |
| CLI / IDE / host-agent delegation    | Hosted app only                                  | Separate distribution roadmap                                 | P3 / XL           | Product/support scope expansion            |

## 7. Architecture proposed for our service

```text
existing verified webhook + durable run/outbox
  → freeze base/head + approved configuration revision
  → enumerate bounded file inventory and record omissions
  → select files + build coverage manifest
  → partition into review units and persist them
  → reserve unit request budget
  → dispatch unit messages through existing queue infrastructure
      → validate lease/input/config/supersession
      → load initial unit diff + applicable rule pack
      → short bounded read-only context loop
      → validate and persist complete unit result
  → idempotent aggregation when units reach terminal states
  → deterministic finding/evidence/location checks
  → optional budgeted verification
  → existing final live-permission/SHA checks
  → existing reconciled GitHub COMMENT publication
```

### Suggested storage additions

- `review_policy`: installation/repository scope, revision, approved rules, file policy, model/provider reference, limits, changed-by audit fields.
- Extend `review_run`: base SHA, policy/prompt/schema versions, immutable scope hash, explicit coverage outcome, reserved/actual usage, next-attempt timestamp, parent/checkpoint identity where applicable.
- `review_unit`: run, deterministic unit key, member files/content hashes, execution status, attempt, lease, validated result, completion reason. Unique run/unit identity makes repeated queue messages harmless.
- `review_request`: unit/phase/request identity, reservation, provider request ID when safe, usage, timing, typed outcome. Do not persist API keys or raw error payloads.
- `review_finding`: durable evidence/rule identity, category, current anchor, first/last observed head, publication identifiers, triage state. Keep identity distinct from mutable prose and display coordinates.
- `review_event`: bounded metadata-only phase/status events for the dashboard; private source artifacts require a separate retention/access decision.

Schema names are proposals, not existing tables. Keep `publicationStatus` independent of analysis/coverage: a complete analysis can fail publication, and a successfully published result can still be explicitly partial.

### Context-tool security boundary

The model never supplies an installation ID, repository identity, arbitrary host, or arbitrary ref. Those come from trusted run state. Tool arguments can only narrow a path/query/range within that snapshot.

1. Canonicalize and validate paths; reject traversal, absolute paths, arbitrary URLs, and unsafe encodings.
2. Apply credential-path and content-size policy to file reads, search results, diffs, and cached context—not just the initial selected files.
3. Pin base/head snapshots; do not read a mutable branch or a fork's unrelated ref as equivalent context.
4. Treat repository text, PR descriptions, issue text, and tool responses as untrusted data; rules from a reviewed PR cannot override platform policy.
5. Bound bytes, lines, matches, calls, loop turns, duration, and all model usage, including failed attempts.
6. Cache only with installation/repository/commit/policy identity and verify access before serving private data. Do not reuse a shared global repository cache without scope isolation.
7. No repository-code execution, shell, package installation, arbitrary fetch, or write tools in the review agent.

The inspected upstream file-read/search/diff providers do not apply the selection secret-path gate themselves, and the diff lookup is populated before selection. Therefore initial file exclusion alone must not be mistaken for an end-to-end data-exfiltration boundary. This is an adoption warning from inspected paths, not a complete upstream security audit.

### Cloudflare fit

Do not spawn the Go CLI or `git grep` inside our existing Worker. Reimplement orchestration and validation in TypeScript around our existing API access. Start with GitHub-backed file/diff retrieval and a bounded in-memory/context cache per unit. If repository-wide indexing eventually needs a separate snapshot worker/service, treat it as a separately scoped architecture decision with measured cost.

Longer multi-unit reviews need per-unit leases and renewal/deadline handling; simply inserting a long tool loop under the current ten-minute run lease is insufficient. Finalization must be idempotent under simultaneous unit completion and queue redelivery. Bound concurrency per installation as well as globally so one large repository cannot consume everyone's quota.

## 8. What not to copy unchanged

1. **CLI/process-local assumptions:** local filesystem sessions and goroutine coordination are not durable multi-tenant orchestration.
2. **Large/unlimited defaults:** 100 turns, eight concurrent groups, repeated review rounds, and unlimited aggregate usage are inappropriate for our baseline cost target.
3. **Soft aggregate caps:** upstream checks observed usage and estimates; in-flight requests and grace calls can spend beyond the configured aggregate threshold. Use reservations and explicit worst-case allowances.
4. **Blanket test exclusions:** retain useful test changes and test context; avoid blind spots caused by adopting its noise defaults wholesale.
5. **Broad style rules:** our contract remains actionable bugs, security vulnerabilities, and regressions, using very short English comments.
6. **Rule trust from the reviewed branch:** a PR author must not be able to weaken the checks reviewing that PR.
7. **Fuzzy location as correctness:** a plausible location is not an evidence-backed GitHub anchor. Old/new sides must remain explicit.
8. **Overlap-only duplicate suppression:** equal lines do not imply equal bugs; line drift does not imply a new bug.
9. **Missing finding means fixed:** nondeterministic model silence is not proof. Use “not observed” or “not rechecked” unless stronger evidence supports resolution.
10. **Raw session/reasoning retention:** upstream's local debugging affordances must not become default private-code exposure in a hosted dashboard or logs.
11. **Arbitrary endpoint/MCP configuration:** a local trusted user's options become SSRF, credential-routing, and cross-tenant risks in a hosted product.
12. **Assuming roadmap equals shipped code:** ACP is explicitly experimental; long-term domain memory is planned. Delegate/IDE code already exists despite older roadmap wording.

## 9. Delivery plan and acceptance gates

### Phase A — measurable, truthful baseline

Deliver coverage schema, stable snapshot/config identity, usage recording, pure selection/preview, expanded credential exclusions, and administrator-authorized backend policies. Keep the single-pass analyzer during this phase to isolate behavior changes.

Acceptance: a 101+ file PR, missing patch, generated file, secret rename, and oversized diff all produce specific coverage/omission reasons; a valid empty review differs from an unreviewed scope; policy edits cannot come from an untrusted PR; dashboards cannot read another inaccessible repository's records.

### Phase B — focused analysis with resumable units

Deliver exact-partition grouping, unit persistence/leases, bounded read-only context tools, aggregate request reservations, and evidence anchors. Start with one round and low concurrency. Preserve publication reconciliation.

Acceptance: every selected file belongs to one unit; malformed grouping cannot drop files; duplicate queue messages cannot duplicate unit work/budget; one failed unit preserves completed ones; source retrieval remains pinned during force-push; a stale/superseded run cannot publish as current; ambiguous snippets stay unanchored; no tool can retrieve excluded credentials.

### Phase C — less noise across revisions

Deliver candidate validation, finding identity/history, optional sticky status, new/persisting/not-rechecked comparisons, and header-aware scheduled retries. Pilot delta reviews only after full-scope checkpoint eligibility is trustworthy.

Acceptance: an unrelated second bug on the same line is retained; moving a finding does not repost it unnecessarily; skipped/failed files never make old findings appear fixed; base/config/ancestry uncertainty falls back to full review; ambiguous publication failures reconcile before another write. Reopened and ready-for-review retain full-review semantics.

### Phase D — optional expansion

Evaluate deeper mode, another provider, multi-line fixes, full scans, SARIF, approved external context, and CLI/IDE integrations individually. Do not bundle them into a single engine rewrite. Keep automatic fixes, blocking reviews, and repository execution out of scope unless requirements change explicitly.

## 10. Evaluation and tests worth adopting

Upstream grouping tests cover missing/duplicate/invalid file assignments and truncated JSON. Budget tests exercise controlled partial coverage. Sealed-input tests move a branch after admission and verify pinned execution still reads the admitted commits. Resume/manifest tests exercise identity and terminal-state invariants. The publication test file covers checkpoint preservation, range decisions, reconciliation, location uncertainty, and guarded thread resolution.

Add analogous tests to our existing Vitest/Workers suite rather than copying their Go fixtures verbatim:

- Selection parity between preview and execution; hard secret exclusions survive include overrides and renames.
- Exact partition of selected files; deterministic local fallback; oversized group splitting; tokenization/Unicode bounds.
- Snapshot consistency across fork PRs, ref changes, rename/deletion, changed schemas, and changed dependencies.
- Lease expiry, duplicate delivery, cancellation, concurrent finalization, result reuse, and publication-only retries.
- Reservations across concurrent units, retries, verifier requests, missing provider usage, and interrupted calls.
- Tool denial for traversal, credential paths, arbitrary destinations, missing permissions, and oversized/binary responses.
- Valid empty results, truncated/refused outputs, malformed tool arguments, failed tool loops, and partial units.
- Anchor ambiguity, repeated snippets, wrong files, CRLF, old/new sides, operator prefixes, multi-hunk changes, and malicious suggestions.
- Cross-head finding identity, two bugs on one line, not-rechecked files, human thread replies, and incomplete pagination.
- Prompt-injection fixtures in source, PR text, filenames, and proposed rule files; no policy override or credential access.

For model quality, create labeled cases for auth bypass, tenant leakage, nullability, async races, transaction behavior, schema compatibility, frontend lifecycle, API contracts, and CI injection. Include clean controls and negative cases where surrounding code disproves an apparent bug. Pin inputs, prompts, rule packs, models, and budgets.

Measure precision, recall, anchor correctness, duplicate rate, reviewed-scope coverage, median/p95 latency, input/output/cache tokens, cost per PR, and cost per accepted true finding. Compare staged ablations: current baseline → grouping → context tools → verification → deeper mode. Splitting into many groups repeats prompt/context and can cost more than our current single request; “Alibaba uses fewer tokens than a general-purpose agent” does not establish savings versus our baseline.

The README points to [AACR-Bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench). Inspect dataset licensing, evaluation instructions, contamination risk, and fit before adopting it. Do not send private customer repositories into a benchmark or promote a new default without an explicitly budgeted evaluation.

## 11. Source index (pinned revision)

Primary upstream references:

- [Review orchestration, rounds, filtering, provenance](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/agent/agent.go)
- [Grouping, metadata indices, coverage fallback](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/agent/grouping.go)
- [Deterministic file selection](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/agent/selection.go)
- [Template limits and grouping/planning thresholds](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/config/template/task_template.json)
- [Rule resolution and trust layers](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/config/rules/system_rules.go)
- [Embedded language/config rule routing](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/config/rules/system_rules.json)
- [Read-only tool implementations](https://github.com/alibaba/open-code-review/tree/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/tool)
- [Loop, tool processing, stop conditions](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/llmloop/loop.go)
- [Three-zone compression](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/llmloop/compression.go)
- [Deterministic line resolution](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/diff/resolver.go)
- [Coverage manifest](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/session/manifest.go)
- [Resume admission](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/session/resume_identity.go)
- [Finding comparison](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/session/compare.go)
- [GitHub posting, checkpoints, routing, thread resolution](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/scripts/github-actions/post-review-comments.js)
- [Action feature/input contract](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/action.yml)
- [Full-file scan engine](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/scan/agent.go)
- [Provider protocol contract](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/llm/protocol.go)
- [SARIF exporter](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/cmd/opencodereview/sarif.go)
- [Experimental ACP status](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/acp/README.md)
- [Roadmap and explicit non-goals](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/ROADMAP.md)

## 12. Reuse and license

Upstream is Apache-2.0. Architectural ideas can be implemented in our TypeScript service without transplanting the Go runtime. If copying or adapting source or embedded rule/prompt text, preserve the required license/copyright notices, identify modifications, and check whether upstream provides a NOTICE that must accompany distribution. Keep attribution for reused material; do not copy branding or claim affiliation. Verify our distribution/license obligations before shipping copied code or rule packs. Dataset licensing is a separate question.

**Bottom line:** improve evidence, context, coverage truthfulness, and cross-push noise before adding more models or longer autonomous loops. Those are the transferable engineering advantages most relevant to our existing GitHub review agent.
