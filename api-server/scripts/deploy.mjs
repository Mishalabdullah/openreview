import { createPrivateKey, randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "jsonc-parser";

const root = fileURLToPath(new URL("../", import.meta.url));
const secretNames = [
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "DATABASE_URL",
];

export function deploymentConfig(source, environment) {
  if (!["dev", "production"].includes(environment))
    throw new Error("Select dev or production explicitly.");
  const errors = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid Wrangler configuration.");
  const selected = config.env[environment];
  // Do not allow accidental use of another environment's config or local queues.
  config.env = { [environment]: selected };
  return config;
}

export function deploymentSecrets(source, privateKey, databaseUrl) {
  let secrets;
  try {
    secrets = JSON.parse(source);
  } catch {
    throw new Error("API_SECRETS_JSON must be a JSON object.");
  }
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets))
    throw new Error("API_SECRETS_JSON must be a JSON object.");
  // GitHub supplies an empty string when the separate secret is unset.
  // Prefer a separate raw PEM secret, while supporting existing JSON-only setup.
  if (privateKey !== undefined && privateKey !== "")
    secrets.GITHUB_APP_PRIVATE_KEY = privateKey;
  // Keep the existing standalone GitHub DATABASE_URL secret out of JSON edits.
  if (databaseUrl !== undefined && databaseUrl !== "")
    secrets.DATABASE_URL = databaseUrl;
  for (const name of secretNames) {
    if (typeof secrets[name] !== "string" || !secrets[name].trim())
      throw new Error(
        ["GITHUB_APP_PRIVATE_KEY", "DATABASE_URL"].includes(name)
          ? `Set ${name} as a separate secret or inside API_SECRETS_JSON.`
          : `API_SECRETS_JSON is missing ${name}.`,
      );
  }
  if (
    secrets.BETTER_AUTH_SECRET.length < 32 ||
    !/^\d+$/.test(secrets.GITHUB_APP_ID) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(secrets.GITHUB_APP_SLUG)
  )
    throw new Error("Invalid auth secret, GitHub App ID, or slug.");
  try {
    const url = new URL(secrets.DATABASE_URL);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.hostname.endsWith(".railway.internal")
    )
      throw new Error();
  } catch {
    throw new Error("DATABASE_URL must be a public PostgreSQL connection URL.");
  }
  try {
    if (
      createPrivateKey(secrets.GITHUB_APP_PRIVATE_KEY).asymmetricKeyType !==
      "rsa"
    )
      throw new Error();
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY must contain a valid RSA PEM key.");
  }
  // Allowlist only backend secrets, including the direct runtime database URL.
  // Never upload Cloudflare CI credentials.
  return Object.fromEntries(secretNames.map((name) => [name, secrets[name]]));
}

async function main() {
  const [environment, ...flags] = process.argv.slice(2);
  if (flags.some((flag) => !["--check", "--dry-run"].includes(flag)))
    throw new Error("Supported flags: --check, --dry-run.");
  const dryRun = flags.includes("--dry-run");
  const config = deploymentConfig(
    await readFile(path.join(root, "wrangler.jsonc"), "utf8"),
    environment,
  );
  let secrets;
  if (!dryRun) {
    if (
      !/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
      !process.env.CLOUDFLARE_API_TOKEN?.trim()
    )
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
    secrets = deploymentSecrets(
      process.env.API_SECRETS_JSON,
      process.env.GITHUB_APP_PRIVATE_KEY,
      process.env.DATABASE_URL,
    );
  }
  if (flags.includes("--check")) return;
  const suffix = randomUUID();
  const configPath = path.join(root, `.deploy.config-${suffix}.json`);
  const secretPath = path.join(root, `.deploy.secrets-${suffix}.json`);
  try {
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    if (secrets)
      await writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        configPath,
        "--env",
        environment,
        "--minify",
        ...(dryRun ? ["--dry-run"] : ["--secrets-file", secretPath]),
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
      },
    );
    if (result.error || result.status !== 0)
      throw new Error("Worker deployment failed.");
  } finally {
    await rm(configPath, { force: true });
    await rm(secretPath, { force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
