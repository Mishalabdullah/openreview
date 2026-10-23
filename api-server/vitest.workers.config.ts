import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { builtinModules } from 'node:module'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/workers/**/*.spec.ts'],
    deps: { optimizer: { ssr: {
      enabled: true,
      include: ['pg'],
      rolldownOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'cloudflare:sockets', 'pg-native'] },
    } } },
  },
})
