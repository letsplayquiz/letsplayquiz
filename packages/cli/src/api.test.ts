import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchGuide, postJson, decideOutcome, userAgent, type HttpResponse } from './api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function makeHttpResponse(status: number, text: string, headers: Record<string, string> = {}): HttpResponse {
  return { status, text, headers: new Headers(headers) }
}

describe('userAgent', () => {
  it('letsplaytest/<version> 형식이다', () => {
    expect(userAgent('0.1.0')).toBe('letsplaytest/0.1.0')
  })
})

describe('fetchGuide / postJson', () => {
  it('User-Agent, Content-Type, lang 쿼리를 보낸다', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchSpy)

    await postJson('https://api.example', '/api/v1/tests/validate', { a: 1 }, { lang: 'ja' }, 'letsplaytest/9.9.9')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://api.example/api/v1/tests/validate?lang=ja')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('letsplaytest/9.9.9')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('guide는 GET이고 --json이면 format=json을 붙인다', async () => {
    const fetchSpy = vi.fn(async () => new Response('# guide', { status: 200, headers: { 'content-type': 'text/markdown' } }))
    vi.stubGlobal('fetch', fetchSpy)

    await fetchGuide('https://api.example', { kind: 'balance', lang: 'ko', asJson: true }, 'letsplaytest/1.0.0')

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://api.example/api/v1/guide?kind=balance&lang=ko&format=json')
    expect(init.method).toBeUndefined()
  })

  it('fetch가 던지면 ok: false를 돌려준다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const result = await postJson('https://api.example', '/api/v1/tests', {}, {}, 'letsplaytest/1.0.0')
    expect(result).toEqual({ ok: false })
  })
})

describe('decideOutcome', () => {
  it('validate 200 ok:true → 0', () => {
    expect(decideOutcome(makeHttpResponse(200, JSON.stringify({ ok: true, blockers: [], warnings: [] }))).exitCode).toBe(0)
  })

  it('validate 200 ok:false(validation_failed) → 1', () => {
    const body = { ok: false, error: { code: 'validation_failed', message: '고칠 곳 있음' }, blockers: [{ code: 'x', message: 'm', path: [] }] }
    expect(decideOutcome(makeHttpResponse(200, JSON.stringify(body))).exitCode).toBe(1)
  })

  it('publish 201 ok:true → 0', () => {
    expect(decideOutcome(makeHttpResponse(201, JSON.stringify({ ok: true, slug: 'a', url: 'u', ownerUrl: 'o', warnings: [] }))).exitCode).toBe(0)
  })

  it('publish 400 validation_failed → 1', () => {
    const body = { ok: false, error: { code: 'validation_failed', message: 'm' }, blockers: [] }
    expect(decideOutcome(makeHttpResponse(400, JSON.stringify(body))).exitCode).toBe(1)
  })

  it('429 rate_limited → 3, retryAfterSeconds를 읽는다', () => {
    const body = { ok: false, error: { code: 'rate_limited', message: 'm' } }
    const outcome = decideOutcome(makeHttpResponse(429, JSON.stringify(body), { 'retry-after': '42' }))
    expect(outcome.exitCode).toBe(3)
    expect(outcome.retryAfterSeconds).toBe(42)
  })

  it('500 internal → 4', () => {
    const body = { ok: false, error: { code: 'internal', message: 'm' } }
    expect(decideOutcome(makeHttpResponse(500, JSON.stringify(body))).exitCode).toBe(4)
  })

  it('503 unavailable → 4', () => {
    const body = { ok: false, error: { code: 'unavailable', message: 'm' } }
    expect(decideOutcome(makeHttpResponse(503, JSON.stringify(body))).exitCode).toBe(4)
  })

  it('JSON이 아닌 502 HTML → 4', () => {
    expect(decideOutcome(makeHttpResponse(502, '<html>bad gateway</html>')).exitCode).toBe(4)
  })

  it('guide 성공(마크다운, ok 필드 없음) → 0', () => {
    expect(decideOutcome(makeHttpResponse(200, '# guide')).exitCode).toBe(0)
  })

  it('guide 성공(json, ok 필드 없음) → 0', () => {
    expect(decideOutcome(makeHttpResponse(200, JSON.stringify({ version: 1, kinds: [] }))).exitCode).toBe(0)
  })
})
