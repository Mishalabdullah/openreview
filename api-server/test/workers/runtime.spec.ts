import { describe, expect, it } from 'vitest'
import app from '../../src'
import type { Bindings } from '../../src/types/env'

const bindings: Bindings = {
  ENVIRONMENT: 'local',
  BETTER_AUTH_URL: 'http://localhost:1337',
  FRONTEND_URL: 'http://localhost:5173',
  BETTER_AUTH_SECRET: 'workers-runtime-test-secret-12345678901234567890',
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  GITHUB_WEBHOOK_SECRET: 'test-webhook',
  DATABASE_URL: 'postgresql://test:test@localhost:1/test',
}

describe('actual Workers runtime', () => {
  it('runs the Worker fetch handler', async () => {
    const response = await app.request('http://localhost:1337/health', {}, bindings)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('constructs pg and Better Auth inside a request and rejects missing sessions without DB I/O', async () => {
    const response = await app.request('http://localhost:1337/api/v1/me', {}, bindings)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
  })

  it('supports the browser session endpoint with credentialed CORS', async () => {
    const response = await app.request('http://localhost:1337/api/auth/get-session', {
      headers: { Origin: bindings.FRONTEND_URL },
    }, bindings)
    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(bindings.FRONTEND_URL)
  })

  it('rejects untrusted origins before creating resources', async () => {
    const response = await app.request('http://localhost:1337/api/auth/sign-out', {
      method: 'POST', headers: { Origin: 'https://evil.example' },
    }, bindings)
    expect(response.status).toBe(403)
  })
})
