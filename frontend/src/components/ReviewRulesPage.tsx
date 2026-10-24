import { createSignal, For, onCleanup } from "solid-js";

const examples = [
  {
    file: "rule_1.md",
    label: "Code quality",
    icon: "code",
    text: "# Code review rules\n\n- Keep functions focused on a single responsibility.\n- Handle errors explicitly; do not silently swallow failures.\n- Add tests for new behavior and regression fixes.\n- Explain non-obvious decisions, not what the code does.\n",
  },
  {
    file: "security.md",
    label: "Security",
    icon: "shield",
    text: "# Security review rules\n\n- Validate untrusted input at every API boundary.\n- Check authorization before accessing private resources.\n- Never log secrets, tokens, or sensitive user data.\n- Use parameterized queries for database access.\n",
  },
];

function RuleIcon(props: { kind: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.kind === "shield" ? (
        <>
          <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
          <path d="m8.5 12 2.5 2.5 4.5-5" />
        </>
      ) : props.kind === "folder" ? (
        <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Z" />
      ) : props.kind === "code" ? (
        <>
          <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 24" />
        </>
      ) : (
        <>
          <path d="M6 3h8l4 4v14H6V3Z" />
          <path d="M13 3v5h5M9 12h6m-6 4h4" />
        </>
      )}
    </svg>
  );
}

/** Original vector artwork, shared by light/dark themes without external image requests. */
function RulesIllustration() {
  return (
    <svg
      class="rules-illustration"
      viewBox="0 0 520 380"
      role="img"
      aria-labelledby="rules-art-title rules-art-description"
    >
      <title id="rules-art-title">
        Your review playbook, inside your repository
      </title>
      <desc id="rules-art-description">
        A .review folder holds two Markdown documents: rule_1.md and
        security.md, with a security shield and code symbols.
      </desc>
      <defs>
        <pattern
          id="rules-dots"
          width="22"
          height="22"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r="1" fill="var(--line)" />
        </pattern>
      </defs>
      <rect
        x="10"
        y="10"
        width="500"
        height="360"
        rx="20"
        fill="url(#rules-dots)"
      />
      <ellipse cx="260" cy="324" rx="170" ry="16" fill="var(--soft)" />
      <circle
        cx="268"
        cy="182"
        r="134"
        fill="none"
        stroke="var(--line)"
        stroke-dasharray="4 8"
      />
      <path
        d="M82 162V125a12 12 0 0 1 12-12h99l22 24h190a12 12 0 0 1 12 12v143H82Z"
        fill="var(--soft)"
        stroke="var(--line)"
        stroke-width="2"
      />
      <g transform="rotate(-9 210 170)">
        <rect
          x="131"
          y="47"
          width="148"
          height="213"
          rx="10"
          fill="var(--panel)"
          stroke="var(--line)"
          stroke-width="2"
        />
        <path
          d="m151 75 8 8-8 8m22-16-8 16"
          fill="none"
          stroke="var(--accent)"
          stroke-width="2"
        />
        <text
          x="151"
          y="119"
          fill="var(--text)"
          font-family="var(--mono)"
          font-size="13"
        >
          rule_1.md
        </text>
        <path
          d="M151 140h103m-103 13h75m-75 22h103m-103 13h84"
          stroke="var(--line)"
          stroke-width="5"
          stroke-linecap="round"
        />
      </g>
      <g transform="rotate(9 343 160)">
        <rect
          x="270"
          y="68"
          width="148"
          height="213"
          rx="10"
          fill="var(--panel)"
          stroke="var(--line)"
          stroke-width="2"
        />
        <path
          d="m300 88-12 5v9c0 7 12 13 12 13s12-6 12-13v-9l-12-5Z"
          fill="var(--tint)"
          stroke="var(--accent)"
          stroke-width="1.5"
        />
        <path
          d="m294 100 4 4 7-8"
          fill="none"
          stroke="var(--accent)"
          stroke-width="1.5"
        />
        <text
          x="290"
          y="143"
          fill="var(--text)"
          font-family="var(--mono)"
          font-size="13"
        >
          security.md
        </text>
        <path
          d="M290 165h103m-103 13h75m-75 22h103m-103 13h84"
          stroke="var(--line)"
          stroke-width="5"
          stroke-linecap="round"
        />
      </g>
      <path
        d="M66 183a12 12 0 0 1 12-12h110l21 20h218a12 12 0 0 1 12 14l-16 101a12 12 0 0 1-12 10H94a12 12 0 0 1-12-10Z"
        fill="var(--panel)"
        stroke="var(--accent)"
        stroke-width="2"
      />
      <path
        d="M111 230h26l7 9h34v34h-67Z"
        fill="var(--tint)"
        stroke="var(--accent)"
        stroke-width="1.5"
      />
      <text
        x="198"
        y="255"
        fill="var(--text)"
        font-family="var(--mono)"
        font-size="25"
      >
        .review/
      </text>
      <text
        x="198"
        y="279"
        fill="var(--muted)"
        font-family="var(--sans)"
        font-size="11"
      >
        A home for your team's standards
      </text>
      <g transform="translate(424 97)">
        <circle r="25" fill="var(--tint)" stroke="var(--line)" />
        <path
          d="m-10 0 7 7L11-8"
          stroke="var(--accent)"
          stroke-width="2"
          fill="none"
        />
      </g>
      <g fill="var(--accent)">
        <path d="m68 77 3 9 9 3-9 3-3 9-3-9-9-3 9-3Z" />
        <circle cx="452" cy="283" r="4" />
        <circle cx="105" cy="53" r="3" />
      </g>
    </svg>
  );
}

export default function ReviewRulesPage() {
  const [feedback, setFeedback] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  async function copy(text: string, label: string) {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(`${label} copied.`);
    } catch {
      setFeedback(
        "Clipboard unavailable. Select and copy the example text instead.",
      );
    }
    timer = setTimeout(() => setFeedback(""), 5000);
  }

  return (
    <div class="rules-page">
      <section class="rules-hero" aria-labelledby="rules-hero-heading">
        <div class="rules-hero-copy">
          <span class="rules-kicker">
            <span aria-hidden="true">✦</span> A playbook, not another settings
            form
          </span>
          <h2 id="rules-hero-heading">
            Great reviews start
            <br />
            with <em>your rules.</em>
          </h2>
          <p>
            Keep your team's code review standards next to your code. Create a{" "}
            <code>.review</code> folder in the root of your project, then
            describe your custom rules in Markdown files.
          </p>
          <a class="button" href="#rules-setup">
            Build your playbook <span aria-hidden="true">↘</span>
          </a>
          <span class="rules-hero-caption">
            Plain Markdown. Versioned with your project.
          </span>
        </div>
        <RulesIllustration />
      </section>

      <section
        id="rules-setup"
        class="rules-setup"
        aria-labelledby="rules-setup-heading"
      >
        <div class="rules-section-heading">
          <div>
            <p class="dashboard-eyebrow">From folder to playbook</p>
            <h2 id="rules-setup-heading">
              Three small steps. Your team's standards.
            </h2>
          </div>
          <span class="config-badge">No special syntax needed</span>
        </div>
        <div class="rules-steps">
          <article>
            <div class="rules-step-top">
              <span>01</span>
              <RuleIcon kind="folder" />
            </div>
            <h3>Create the folder</h3>
            <p>
              Add <code>.review/</code> at the{" "}
              <strong>root of your project</strong>—alongside your source folder
              and README.
            </p>
            <div class="rules-step-visual" aria-hidden="true">
              <span class="mini-root">your-project/</span>
              <span class="mini-folder">└─ .review/</span>
            </div>
          </article>
          <article>
            <div class="rules-step-top">
              <span>02</span>
              <RuleIcon kind="document" />
            </div>
            <h3>Add Markdown files</h3>
            <p>
              Create files such as <code>rule_1.md</code> and{" "}
              <code>security.md</code>. Use descriptive names to organize your
              rules.
            </p>
            <div class="rules-step-visual rules-file-pills" aria-hidden="true">
              <span>↓ rule_1.md</span>
              <span>↓ security.md</span>
            </div>
          </article>
          <article>
            <div class="rules-step-top">
              <span>03</span>
              <RuleIcon kind="shield" />
            </div>
            <h3>Write what matters</h3>
            <p>
              Describe what reviewers should check, avoid, or prioritize. Be
              specific, add examples, and commit the files to your repository.
            </p>
            <div class="rules-step-visual rules-checks" aria-hidden="true">
              <span>✓ Validate inputs</span>
              <span>✓ Test new behavior</span>
            </div>
          </article>
        </div>
      </section>

      <section class="rules-workbench" aria-labelledby="rules-examples-heading">
        <aside class="rules-file-tree">
          <p class="dashboard-eyebrow">Inside your repository</p>
          <h2>A place for every principle.</h2>
          <div class="rules-tree" aria-label="Example project file structure">
            <div>
              <RuleIcon kind="folder" />
              <strong>your-project/</strong>
            </div>
            <div class="tree-indent tree-muted">
              <span>├─</span> src/
            </div>
            <div class="tree-indent tree-muted">
              <span>├─</span> README.md
            </div>
            <div class="tree-indent tree-highlight">
              <span>└─</span>
              <RuleIcon kind="folder" />
              <strong>.review/</strong>
            </div>
            <div class="tree-file">
              <span>├─</span>
              <RuleIcon kind="document" />
              rule_1.md
            </div>
            <div class="tree-file">
              <span>└─</span>
              <RuleIcon kind="shield" />
              security.md
            </div>
          </div>
          <p>
            One file per topic, or one file for everything. The names are up to
            you; the rules go inside the <code>.md</code> files.
          </p>
        </aside>
        <div class="rules-examples">
          <div class="rules-section-heading">
            <h2 id="rules-examples-heading">Start with a few good rules.</h2>
            <span class="rules-example-label">Example files</span>
          </div>
          <For each={examples}>
            {(example) => (
              <article class="rules-code-card">
                <div class="rules-code-heading">
                  <span>
                    <RuleIcon kind={example.icon} />
                    .review/{example.file}
                  </span>
                  <button
                    type="button"
                    class="config-text-button"
                    aria-label={`Copy ${example.file} example`}
                    onClick={() => void copy(example.text, example.file)}
                  >
                    Copy <span aria-hidden="true">⧉</span>
                  </button>
                </div>
                <pre
                  tabIndex={0}
                  aria-label={`${example.label} Markdown example`}
                >
                  <code>{example.text}</code>
                </pre>
              </article>
            )}
          </For>
          <p class="rules-copy-feedback" role="status">
            {feedback()}
          </p>
        </div>
      </section>
      <div class="rules-bottom-note">
        <RuleIcon kind="document" />
        <div>
          <strong>Write the rules you'd give a teammate.</strong>
          <p>
            “Check authorization before reading private data” is more useful
            than “make it secure.” This page is a setup guide; it does not read
            your repository or verify that these files are being applied to
            reviews.
          </p>
        </div>
      </div>
    </div>
  );
}
