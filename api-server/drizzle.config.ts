import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Tooling only: never bundled into the Worker. Explicit process env takes precedence.
config({ path: process.env.DB_ENV_FILE ?? '.dev.vars', quiet: true })

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/auth-schema.ts', './src/db/schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
})
