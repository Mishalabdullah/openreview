import type { AuthUser } from "../lib/auth-client";
import type { DashboardData } from "../lib/dashboard-data";
import { ConnectionPanel } from "./GitHubDashboard";

export default function SettingsPage(props: {
  user: AuthUser;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onSignOut: () => Promise<void>;
  signingOut: boolean;
  model: DashboardData;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  return (
    <div class="configuration-page settings-page">
      <section class="settings-section" aria-labelledby="profile-title">
        <div class="settings-section-intro">
          <p class="dashboard-eyebrow">01 / Account</p>
          <h2 id="profile-title">Your profile</h2>
          <p>Your identity is managed through your sign-in account.</p>
        </div>
        <div class="settings-panel">
          <div class="settings-identity">
            <span class="settings-avatar" aria-hidden="true">
              {props.user.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{props.user.name}</strong>
              <p>{props.user.email}</p>
            </div>
            <span class="config-badge">Signed in</span>
          </div>
          <dl class="settings-details">
            <div>
              <dt>Name</dt>
              <dd>{props.user.name}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{props.user.email}</dd>
            </div>
          </dl>
          <p class="config-footnote">
            Profile editing is not available here. No account changes are made
            from this page.
          </p>
        </div>
      </section>
      <section class="settings-section" aria-labelledby="appearance-title">
        <div class="settings-section-intro">
          <p class="dashboard-eyebrow">02 / Appearance</p>
          <h2 id="appearance-title">Make it your space</h2>
          <p>
            A little light. Or a little less. Your choice stays on this device.
          </p>
        </div>
        <div class="settings-panel">
          <div class="theme-choices" aria-label="Color theme">
            <button
              type="button"
              aria-pressed={props.theme === "light"}
              classList={{ selected: props.theme === "light" }}
              onClick={() => {
                if (props.theme !== "light") props.onToggleTheme();
              }}
            >
              <span class="theme-swatch swatch-light" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>
                Light{" "}
                <span aria-hidden="true">
                  {props.theme === "light" ? "✓" : ""}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-pressed={props.theme === "dark"}
              classList={{ selected: props.theme === "dark" }}
              onClick={() => {
                if (props.theme !== "dark") props.onToggleTheme();
              }}
            >
              <span class="theme-swatch swatch-dark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>
                Dark{" "}
                <span aria-hidden="true">
                  {props.theme === "dark" ? "✓" : ""}
                </span>
              </span>
            </button>
          </div>
        </div>
      </section>
      <section class="settings-section" aria-labelledby="access-title">
        <div class="settings-section-intro">
          <p class="dashboard-eyebrow">03 / Repository access</p>
          <h2 id="access-title">Connected to your code</h2>
          <p>GitHub sign-in and repository access are separate permissions.</p>
        </div>
        <div class="settings-panel settings-connection">
          <ConnectionPanel
            model={props.model}
            onReconnect={props.onReconnect}
            reconnecting={props.reconnecting}
          />
        </div>
      </section>
      <section class="settings-section" aria-labelledby="session-title">
        <div class="settings-section-intro">
          <p class="dashboard-eyebrow">04 / Session</p>
          <h2 id="session-title">All done for now?</h2>
          <p>Sign out of OpenReview in this browser.</p>
        </div>
        <div class="settings-panel settings-session">
          <div>
            <h3>Sign out</h3>
            <p>
              This does not uninstall the GitHub App or revoke its repository
              access.
            </p>
          </div>
          <button
            type="button"
            class="dashboard-control"
            disabled={props.signingOut}
            onClick={() => void props.onSignOut()}
          >
            {props.signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </section>
    </div>
  );
}
