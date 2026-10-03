import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveStoreFile } from 'letsplayquiz/lib'
import { getGuide, validateQuiz, publishQuiz, listMyQuizzes, MCP_PUBLISH_TIMEOUT_MS, type ToolContext } from './tools.js'

let home: string
let ctx: ToolContext

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'letsplayquiz-mcp-home-'))
  ctx = { api: 'https://example.test', ua: 'test-ua', store: { env: {} as NodeJS.ProcessEnv, homedir: () => home } }
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(home, { recursive: true, force: true })
})

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => impl(String(url), init))
  vi.stubGlobal('fetch', fn)
  return fn
}
const quiz = { kind: 'balance', title: '짜장 vs 짬뽕' }
const published = { ok: true, slug: 's1', url: 'https://example.test/t/s1', ownerUrl: 'https://example.test/owner/SECRETTOKEN' }

describe('get_guide', () => {
  it('format=json과 kind/lang을 붙여 요청하고 JSON을 돌려준다', async () => {
    const f = stubFetch(() => json(200, { kind: 'score', rules: [] }))
    const r = await getGuide(ctx, { kind: 'score', lang: 'en' })
    const url = new URL(f.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/v1/guide')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('kind')).toBe('score')
    expect(url.searchParams.get('lang')).toBe('en')
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toEqual({ kind: 'score', rules: [] })
  })
  it('JSON이 아닌 응답은 bad_response 오류', async () => {
    stubFetch(() => new Response('# markdown', { status: 200 }))
    const r = await getGuide(ctx, {})
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ error: { code: 'bad_response' } })
  })
  it('연결 실패는 오류', async () => {
    stubFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    })
    const r = await getGuide(ctx, {})
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('Could not reach')
  })
})

describe('validate_quiz', () => {
  it('통과하면 ok:true와 경고를 낸다', async () => {
    const f = stubFetch(() => json(200, { ok: true, warnings: [{ code: 'w', message: 'hmm', path: ['title'] }] }))
    const r = await validateQuiz(ctx, { quiz, lang: 'ko' })
    expect(new URL(f.mock.calls[0][0] as string).pathname).toBe('/api/v1/tests/validate')
    expect(JSON.parse(f.mock.calls[0][1]?.body as string)).toEqual(quiz)
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toMatchObject({ ok: true, blockers: [] })
    expect(r.content[0].text).toContain('title  w  hmm')
  })
  it('검증 실패는 오류가 아니라 정상 결과(blockers)', async () => {
    stubFetch(() =>
      json(200, { ok: false, error: { code: 'validation_failed' }, blockers: [{ code: 'x', message: 'bad', path: ['questions', 0] }], warnings: [] }),
    )
    const r = await validateQuiz(ctx, { quiz })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toMatchObject({ ok: false, blockers: [{ code: 'x' }] })
    expect(r.content[0].text).toContain('questions[0]  x  bad')
  })
  it('요청 한도는 retry-after를 담은 오류', async () => {
    stubFetch(() => json(429, { ok: false, error: { code: 'rate_limited', message: 'slow' } }, { 'retry-after': '12' }))
    const r = await validateQuiz(ctx, { quiz })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('12 seconds')
    expect(r.structuredContent).toMatchObject({ retryAfterSeconds: 12 })
  })
})

describe('publish_quiz', () => {
  async function stored(): Promise<unknown[]> {
    const raw = await fs.readFile(resolveStoreFile(ctx.store), 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }

  it('성공하면 url/ownerUrl과 경고를 내고 기록을 저장한다', async () => {
    const f = stubFetch(() => json(201, published))
    const r = await publishQuiz(ctx, { quiz })
    expect(new URL(f.mock.calls[0][0] as string).pathname).toBe('/api/v1/tests')
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toMatchObject({ ok: true, url: published.url, ownerUrl: published.ownerUrl, saved: true })
    expect(r.content[0].text).toContain('only proof of ownership')
    expect(await stored()).toMatchObject([{ slug: 's1', title: '짜장 vs 짬뽕', kind: 'balance', ownerUrl: published.ownerUrl, api: ctx.api }])
  })
  it('save=false면 기록하지 않는다', async () => {
    stubFetch(() => json(201, published))
    const r = await publishQuiz(ctx, { quiz, save: false })
    expect(r.structuredContent).toMatchObject({ ok: true, saved: false })
    await expect(fs.access(resolveStoreFile(ctx.store))).rejects.toThrow()
  })
  it('검증 실패는 blockers 결과, 저장 안 함', async () => {
    stubFetch(() => json(422, { ok: false, error: { code: 'validation_failed' }, blockers: [{ code: 'x', message: 'bad', path: ['a'] }] }))
    const r = await publishQuiz(ctx, { quiz })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toMatchObject({ ok: false, published: false })
    expect(r.content[0].text).toContain('Not published')
    await expect(fs.access(resolveStoreFile(ctx.store))).rejects.toThrow()
  })
  it('요청 한도는 retry-after와 함께 오류', async () => {
    stubFetch(() => json(429, { ok: false, error: { code: 'rate_limited', message: 'slow' } }, { 'retry-after': '30' }))
    const r = await publishQuiz(ctx, { quiz })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('Not published')
    expect(r.content[0].text).toContain('30 seconds')
  })
  it('확실한 실패(연결 거부, 4xx)는 not published 오류', async () => {
    stubFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    })
    const a = await publishQuiz(ctx, { quiz })
    expect(a.isError).toBe(true)
    expect(a.content[0].text).toContain('Not published')

    stubFetch(() => json(400, { ok: false, error: { code: 'invalid_json', message: 'broken' } }))
    const b = await publishQuiz(ctx, { quiz })
    expect(b.isError).toBe(true)
    expect(b.content[0].text).toContain('Not published')
    expect(b.content[0].text).toContain('broken')
  })
  it('결과 불명(소켓 끊김)은 MAY have been published, 재시도 금지', async () => {
    stubFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    })
    const r = await publishQuiz(ctx, { quiz })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('MAY have been published')
    expect(r.content[0].text).toContain('Do NOT retry')
    expect(r.structuredContent).toMatchObject({ error: { code: 'publish_unknown' } })
  })
  it('502 publish_unknown과 ok:true인데 필드 누락도 결과 불명이며 원문의 owner 토큰은 가린다', async () => {
    stubFetch(() => json(502, { ok: false, error: { code: 'publish_unknown', message: 'x' }, ownerUrl: 'https://example.test/owner/TOKEN123' }))
    const a = await publishQuiz(ctx, { quiz })
    expect(a.isError).toBe(true)
    expect(a.content[0].text).toContain('MAY have been published')
    expect(a.content[0].text).not.toContain('TOKEN123')
    expect(a.content[0].text).toContain('[redacted]')

    stubFetch(() => json(200, { ok: true, slug: 's', url: 'https://example.test/t/s', note: 'https://example.test/owner/TOKEN456' }))
    const b = await publishQuiz(ctx, { quiz })
    expect(b.isError).toBe(true)
    expect(b.content[0].text).toContain('MAY have been published')
    expect(b.content[0].text).not.toContain('TOKEN456')
    await expect(fs.access(resolveStoreFile(ctx.store))).rejects.toThrow()
  })
})

describe('list_my_quizzes', () => {
  it('기록이 없으면 빈 목록', async () => {
    const stub = stubFetch(() => json(500, {}))
    const r = await listMyQuizzes(ctx)
    expect(r.structuredContent).toMatchObject({ records: [] })
    expect(stub).not.toHaveBeenCalled()
  })
  it('발행한 기록을 최신순으로 ownerUrl과 함께 낸다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    stubFetch(() => json(201, published))
    await publishQuiz(ctx, { quiz })
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    stubFetch(() => json(201, { ...published, slug: 's2', url: 'https://example.test/t/s2' }))
    await publishQuiz(ctx, { quiz: { ...quiz, title: '둘째' } })
    vi.useRealTimers()
    const r = await listMyQuizzes(ctx)
    const records = (r.structuredContent as { records: { slug: string }[] }).records
    expect(records.map((x) => x.slug)).toEqual(['s2', 's1'])
    // 기본값은 ownerUrl을 숨긴다(CLI list와 같다).
    expect(JSON.stringify(r)).not.toContain('SECRETTOKEN')
    expect(records[0]).not.toHaveProperty('ownerUrl')

    const withOwner = await listMyQuizzes(ctx, { includeOwnerUrls: true })
    expect(withOwner.content[0].text).toContain(published.ownerUrl)
    expect((withOwner.structuredContent as { records: { ownerUrl: string }[] }).records[0].ownerUrl).toBe(published.ownerUrl)
  })
})

describe('오류 경로의 owner 토큰 가리기', () => {
  const leaky = {
    ok: false,
    error: { code: 'invalid_json', message: 'see https://example.test/owner/LEAKTOKEN now' },
    ownerUrl: 'https://example.test/owner/LEAKTOKEN',
    extra: { note: 'x /owner/LEAKTOKEN' },
  }
  it('publish/validate/guide의 4xx 본문에서 토큰을 지운다', async () => {
    stubFetch(() => json(400, leaky))
    for (const r of [
      await publishQuiz(ctx, { quiz }),
      await validateQuiz(ctx, { quiz }),
      await getGuide(ctx, {}),
    ]) {
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r)).not.toContain('LEAKTOKEN')
    }
  })
  it('blockers 안의 토큰도 지운다', async () => {
    stubFetch(() =>
      json(200, { ok: false, error: { code: 'validation_failed' }, blockers: [{ code: 'x', message: '/owner/LEAKTOKEN', path: ['a'] }] }),
    )
    const r = await validateQuiz(ctx, { quiz })
    expect(JSON.stringify(r)).not.toContain('LEAKTOKEN')
  })
})

describe('잘못된 API 설정', () => {
  it('네트워크 도구는 오류를 돌려주고 fetch를 부르지 않으며 list는 동작한다', async () => {
    const f = stubFetch(() => json(200, {}))
    const bad: ToolContext = { ...ctx, api: '', apiError: 'invalid LETSPLAYQUIZ_API: nope' }
    for (const r of [await getGuide(bad, {}), await validateQuiz(bad, { quiz }), await publishQuiz(bad, { quiz })]) {
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain('invalid LETSPLAYQUIZ_API')
    }
    expect(f).not.toHaveBeenCalled()
    expect((await listMyQuizzes(bad)).isError).toBeUndefined()
  })
})

describe('publish 타임아웃·취소·진행 알림', () => {
  /** signal을 지키는 fetch: abort되면 거부하고, 아니면 delay 뒤에 응답한다. */
  function slowFetch(delayMs: number, res: () => Response) {
    return stubFetch(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(res()), delayMs)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
  }

  it('MCP 발행 타임아웃은 클라이언트 기본 60초보다 확실히 짧다', () => {
    expect(MCP_PUBLISH_TIMEOUT_MS).toBeLessThanOrEqual(50_000)
  })
  it('타임아웃은 결과 불명으로 알린다', async () => {
    slowFetch(5_000, () => json(201, published))
    const r = await publishQuiz(ctx, { quiz }, { publishTimeoutMs: 20 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('MAY have been published')
  })
  it('취소(signal)는 결과 불명으로 알린다', async () => {
    slowFetch(5_000, () => json(201, published))
    const ac = new AbortController()
    const p = publishQuiz(ctx, { quiz }, { signal: ac.signal })
    setTimeout(() => ac.abort(), 10)
    const r = await p
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('MAY have been published')
    await expect(fs.access(resolveStoreFile(ctx.store))).rejects.toThrow()
  })
  it('onProgress가 있으면 대기 중 주기적으로 부르고 끝나면 멈춘다', async () => {
    slowFetch(80, () => json(201, published))
    const ticks: number[] = []
    const r = await publishQuiz(ctx, { quiz, save: false }, { onProgress: (n) => ticks.push(n), progressIntervalMs: 10 })
    expect(r.isError).toBeUndefined()
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    const after = ticks.length
    await new Promise((res) => setTimeout(res, 40))
    expect(ticks.length).toBe(after)
  })
})
