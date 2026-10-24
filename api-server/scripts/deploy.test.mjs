import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { deploymentConfig, deploymentSecrets } from "./deploy.mjs";

const source = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);
for (const environment of ["dev", "production"]) {
  test(`${environment} deploy uses isolated resources`, () => {
    const config = deploymentConfig(source, environment);
    assert.deepEqual(Object.keys(config.env), [environment]);
    const env = config.env[environment];
    assert.equal(env.vars.ENVIRONMENT, environment);
    assert.equal(env.hyperdrive, undefined);
    assert.equal(
      env.queues.producers[0].queue,
      `openreview-reviews-${environment}`,
    );
    assert.equal(
      env.queues.consumers[0].dead_letter_queue,
      `openreview-reviews-${environment}-dlq`,
    );
    assert.deepEqual(env.triggers.crons, ["* * * * *"]);
  });
}
test("rejects implicit environments", () => {
  for (const environment of [undefined, "local", "prod", "main"])
    assert.throws(() => deploymentConfig(source, environment));
});
test("validates secrets without exposing their values", () => {
  for (const value of [undefined, "not-json", "null", "[]", "{}"])
    assert.throws(() => deploymentSecrets(value));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const secrets = {
    BETTER_AUTH_SECRET: "a".repeat(32),
    GITHUB_CLIENT_ID: "test",
    GITHUB_CLIENT_SECRET: "test",
    GITHUB_WEBHOOK_SECRET: "test",
    GITHUB_APP_SLUG: "test-app",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: key,
    OPENAI_API_KEY: "test",
    DATABASE_URL: "postgresql://test:test@public.example.com:5432/dev",
    CLOUDFLARE_API_TOKEN: "must-not-be-uploaded",
  };
  const parsed = deploymentSecrets(JSON.stringify(secrets));
  assert.equal(parsed.DATABASE_URL, secrets.DATABASE_URL);
  assert.equal(parsed.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(parsed.GITHUB_APP_PRIVATE_KEY, key);
  const { DATABASE_URL: _url, ...withoutDatabase } = secrets;
  assert.equal(
    deploymentSecrets(
      JSON.stringify(withoutDatabase),
      undefined,
      secrets.DATABASE_URL,
    ).DATABASE_URL,
    secrets.DATABASE_URL,
  );
  assert.throws(() => deploymentSecrets(JSON.stringify(withoutDatabase)));
  assert.equal(
    deploymentSecrets(
      JSON.stringify({ ...secrets, DATABASE_URL: "stale" }),
      undefined,
      secrets.DATABASE_URL,
    ).DATABASE_URL,
    secrets.DATABASE_URL,
  );
  for (const url of [
    "invalid",
    "https://example.com",
    "postgresql://user:password@postgres.railway.internal/db",
  ])
    assert.throws(
      () => deploymentSecrets(JSON.stringify(secrets), undefined, url),
      { message: "DATABASE_URL must be a public PostgreSQL connection URL." },
    );
  assert.equal(
    deploymentSecrets(JSON.stringify(secrets), "").GITHUB_APP_PRIVATE_KEY,
    key,
  );
  const { GITHUB_APP_PRIVATE_KEY: _key, ...withoutKey } = secrets;
  assert.equal(
    deploymentSecrets(JSON.stringify(withoutKey), key).GITHUB_APP_PRIVATE_KEY,
    key,
  );
  assert.equal(
    deploymentSecrets(
      JSON.stringify({ ...secrets, GITHUB_APP_PRIVATE_KEY: "old" }),
      key,
    ).GITHUB_APP_PRIVATE_KEY,
    key,
  );
  assert.throws(() => deploymentSecrets(JSON.stringify(withoutKey)));
  assert.throws(() => deploymentSecrets(JSON.stringify(secrets), "invalid"));
  assert.throws(() =>
    deploymentSecrets(
      JSON.stringify({ ...secrets, GITHUB_APP_PRIVATE_KEY: "invalid" }),
    ),
  );
});
