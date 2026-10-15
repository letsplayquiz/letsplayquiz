import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import {
  fetchGuide,
  postJson,
  decideOutcome,
  derivePublishExitCode,
  classifyPublishNetworkFailure,
  isDefiniteConnectFailure,
  truncateRaw,
  redactOwnerSecrets,
  userAgent,
  withRetryAfterField,
  httpFetch,
  type HttpResponse,
} from './api.js'

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
  it('letsplayquiz/<version> 형식이다', () => {
    expect(userAgent('0.1.0')).toBe('letsplayquiz/0.1.0')
  })
})

describe('fetchGuide / postJson', () => {
  it('User-Agent, Content-Type, lang 쿼리를 보낸다', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchSpy)

    await postJson('https://api.example', '/api/v1/tests/validate', { a: 1 }, { lang: 'ja' }, 'letsplayquiz/9.9.9')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://api.example/api/v1/tests/validate?lang=ja')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('letsplayquiz/9.9.9')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('guide는 GET이고 --json이면 format=json을 붙인다', async () => {
    const fetchSpy = vi.fn(async () => new Response('# guide', { status: 200, headers: { 'content-type': 'text/markdown' } }))
    vi.stubGlobal('fetch', fetchSpy)

    await fetchGuide('https://api.example', { kind: 'balance', lang: 'ko', asJson: true }, 'letsplayquiz/1.0.0')

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://api.example/api/v1/guide?kind=balance&lang=ko&format=json')
    expect(init.method).toBeUndefined()
  })

  it('fetch가 던지면(연결 실패) connect-failed를 돌려준다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const result = await postJson('https://api.example', '/api/v1/tests', {}, {}, 'letsplayquiz/1.0.0')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('connect-failed')
  })

  it('api에 경로가 있어도(https://host/sub/) 그 아래로 붙인다', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchSpy)

    await postJson('https://api.example/sub/', '/api/v1/tests', {}, {}, 'letsplayquiz/1.0.0')

    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://api.example/sub/api/v1/tests')
  })
})

describe('리다이렉트는 따라가지 않는다', () => {
  it('fetchGuide·postJson 모두 redirect: manual로 부른다(따라가면 https 검사를 피해 갈 수 있다)', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchSpy)
    await fetchGuide('https://api.example', { asJson: false }, 'letsplayquiz/1.0.0')
    await postJson('https://api.example', '/api/v1/tests', { a: 1 }, {}, 'letsplayquiz/1.0.0')
    for (const call of fetchSpy.mock.calls) {
      expect((call as unknown as [string, RequestInit])[1].redirect).toBe('manual')
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('httpFetch는 3xx 응답을 그대로 돌려준다(Location을 읽을 수 있게)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 307, headers: { location: 'https://other.example/api/v1/tests' } })))
    const result = await httpFetch('https://api.example/api/v1/tests', { method: 'POST', body: '{}' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.response.status).toBe(307)
      expect(result.response.headers.get('location')).toBe('https://other.example/api/v1/tests')
    }
  })

  it.each([301, 302, 303, 307, 308])('%i + Location → 4, error.code redirected, 안내 문구에 Location과 --api가 있다', (status) => {
    const location = 'https://www.example.test/api/v1/tests'
    for (const mode of ['guide', 'contract'] as const) {
      const outcome = decideOutcome(makeHttpResponse(status, '', { location }), mode)
      expect(outcome.exitCode).toBe(4)
      const error = (outcome.json as { ok: boolean; error: Record<string, unknown> }).error
      expect((outcome.json as { ok: boolean }).ok).toBe(false)
      expect(error.code).toBe('redirected')
      expect(error.location).toBe(location)
      expect(error.status).toBe(status)
      expect(String(error.message)).toContain(`서버가 요청을 다른 주소로 돌렸어요: ${location}`)
      expect(String(error.message)).toContain('--api')
    }
  })

  it('publish에서도 4다 — 요청을 다시 보내지 않으므로 5로 올리지 않는다', () => {
    const response = makeHttpResponse(308, '', { location: 'https://www.example.test/api/v1/tests' })
    const outcome = decideOutcome(response, 'contract')
    expect(derivePublishExitCode(outcome, response)).toEqual({ exitCode: 4 })
  })

  it('Location이 상대 경로여도 그대로 보여 준다', () => {
    const outcome = decideOutcome(makeHttpResponse(301, '', { location: '/sub/api/v1/tests' }), 'contract')
    expect((outcome.json as { error: { message: string } }).error.message).toContain('/sub/api/v1/tests')
  })

  it('Location의 제어 문자는 지우고 너무 길면 자른다(서버가 준 글자를 터미널·에이전트에 그대로 흘리지 않는다)', () => {
    const evil = `https://x.test/\u001b[31m\u0007IGNORE-ME${'a'.repeat(1000)}`
    const outcome = decideOutcome(makeHttpResponse(302, '', { location: evil }), 'contract')
    const error = (outcome.json as { error: { message: string; location: string } }).error
    expect(error.location).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(error.location.length).toBeLessThanOrEqual(301)
  })

  it('Location이 없는 3xx(304 포함)는 리다이렉트 안내가 아니라 기존대로 계약 위반 4다', () => {
    for (const status of [300, 304, 302]) {
      const outcome = decideOutcome(makeHttpResponse(status, ''), 'contract')
      expect(outcome.exitCode).toBe(4)
      expect((outcome.json as { error: { code: string } }).error.code).toBe('bad_response')
    }
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

  it('guide 성공(마크다운, ok 필드 없음) → 0 (guide 모드)', () => {
    expect(decideOutcome(makeHttpResponse(200, '# guide'), 'guide').exitCode).toBe(0)
  })

  it('guide 성공(json, ok 필드 없음) → 0 (guide 모드)', () => {
    expect(decideOutcome(makeHttpResponse(200, JSON.stringify({ version: 1, kinds: [] })), 'guide').exitCode).toBe(0)
  })

  it('contract 모드에서 ok 필드가 없으면(JSON이어도) 4 + bad_response', () => {
    const outcome = decideOutcome(makeHttpResponse(200, JSON.stringify({ hello: 'world' })), 'contract')
    expect(outcome.exitCode).toBe(4)
    expect((outcome.json as { error: { code: string } }).error.code).toBe('bad_response')
  })

  it('contract 모드에서 빈 본문은 4 + bad_response', () => {
    const outcome = decideOutcome(makeHttpResponse(200, ''), 'contract')
    expect(outcome.exitCode).toBe(4)
    expect((outcome.json as { error: { code: string } }).error.code).toBe('bad_response')
  })

  it('rate_limited·unavailable 모두 retryAfterSeconds를 싣는다(429/503)', () => {
    const body = { ok: false, error: { code: 'unavailable', message: 'm' } }
    const outcome = decideOutcome(makeHttpResponse(503, JSON.stringify(body), { 'retry-after': '30' }), 'contract')
    expect(outcome.exitCode).toBe(4)
    expect(outcome.retryAfterSeconds).toBe(30)
  })

  it('Retry-After가 날짜 형식이거나 0 이하이면 무시한다', () => {
    const body = { ok: false, error: { code: 'rate_limited', message: 'm' } }
    const dateHeader = decideOutcome(
      makeHttpResponse(429, JSON.stringify(body), { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
      'contract',
    )
    expect(dateHeader.retryAfterSeconds).toBeUndefined()
    const zero = decideOutcome(makeHttpResponse(429, JSON.stringify(body), { 'retry-after': '0' }), 'contract')
    expect(zero.retryAfterSeconds).toBeUndefined()
  })
})

// 원문에 owner 토큰이 섞여 오면 CI 로그로 새지 않게 가린다(SWE-46).
const OWNER_TOKEN = 'Zz9Zz9Zz9Zz9Zz9Zz9Zz9Zz9Zz9Zz9Qq'

describe('redactOwnerSecrets', () => {
  it('/owner/<token> 경로를 가린다(평문·JSON 이스케이프 슬래시 모두)', () => {
    const plain = `<a href="https://x.test/t/ab12cd34/owner/${OWNER_TOKEN}?a=1">x</a>`
    const escaped = `{"link":"https:\\/\\/x.test\\/t\\/ab12cd34\\/owner\\/${OWNER_TOKEN}"}`
    for (const text of [plain, escaped]) {
      const out = redactOwnerSecrets(text)
      expect(out).not.toContain(OWNER_TOKEN)
      expect(out).toContain('[redacted]')
    }
  })

  it('ownerUrl 필드 값은 형식과 상관없이 통째로 가린다', () => {
    const text = JSON.stringify({ ok: true, ownerUrl: `weird:${OWNER_TOKEN}`, slug: 'ab12cd34' })
    const out = redactOwnerSecrets(text)
    expect(out).not.toContain(OWNER_TOKEN)
    expect(JSON.parse(out)).toEqual({ ok: true, ownerUrl: '[redacted]', slug: 'ab12cd34' })
  })

  it('토큰이 없는 원문은 그대로 둔다', () => {
    const text = JSON.stringify({ ok: true, url: 'https://x.test/t/ab12cd34' })
    expect(redactOwnerSecrets(text)).toBe(text)
  })
})

describe('derivePublishExitCode', () => {
  it('bad_response + 2xx → 5 + raw', () => {
    const outcome = decideOutcome(makeHttpResponse(200, JSON.stringify({ hello: 'world' })), 'contract')
    const derived = derivePublishExitCode(outcome, makeHttpResponse(200, JSON.stringify({ hello: 'world' })))
    expect(derived.exitCode).toBe(5)
    expect(derived.raw).toBe(JSON.stringify({ hello: 'world' }))
  })

  it('bad_response + 5xx(비JSON) → 5 + raw(2KB로 자름)', () => {
    const hugeHtml = `<html>${'x'.repeat(3000)}</html>`
    const response = makeHttpResponse(502, hugeHtml)
    const outcome = decideOutcome(response, 'contract')
    const derived = derivePublishExitCode(outcome, response)
    expect(derived.exitCode).toBe(5)
    expect(derived.raw?.length).toBeLessThanOrEqual(2001) // 2000자 + 말줄임표
  })

  it('돌려주는 raw에는 owner 토큰이 없다(2xx 계약 위반·5xx 모르는 코드)', () => {
    const okish = makeHttpResponse(200, JSON.stringify({ ownerUrl: `https://x.test/t/ab12cd34/owner/${OWNER_TOKEN}` }))
    expect(derivePublishExitCode(decideOutcome(okish, 'contract'), okish).raw).not.toContain(OWNER_TOKEN)
    const body = { ok: false, error: { code: 'publish_unknown', message: 'm' }, ownerUrl: `https://x.test/t/ab12cd34/owner/${OWNER_TOKEN}` }
    const unknown = makeHttpResponse(502, JSON.stringify(body))
    const derived = derivePublishExitCode(decideOutcome(unknown, 'contract'), unknown)
    expect(derived.exitCode).toBe(5)
    expect(derived.raw).not.toContain(OWNER_TOKEN)
  })

  it('bad_response + 4xx → 그대로 4', () => {
    const response = makeHttpResponse(400, '<html>bad request</html>')
    const outcome = decideOutcome(response, 'contract')
    const derived = derivePublishExitCode(outcome, response)
    expect(derived.exitCode).toBe(4)
  })

  it('JSON 500 internal → 그대로 4', () => {
    const body = { ok: false, error: { code: 'internal', message: 'm' } }
    const response = makeHttpResponse(500, JSON.stringify(body))
    const outcome = decideOutcome(response, 'contract')
    expect(derivePublishExitCode(outcome, response).exitCode).toBe(4)
  })

  it('JSON 503 unavailable → 그대로 4', () => {
    const body = { ok: false, error: { code: 'unavailable', message: 'm' } }
    const response = makeHttpResponse(503, JSON.stringify(body))
    const outcome = decideOutcome(response, 'contract')
    expect(derivePublishExitCode(outcome, response).exitCode).toBe(4)
  })

  it('503 feature_unavailable(0011 미적용 — 서버가 입력을 거절) → 4 (모르는 5xx 코드가 아니다)', () => {
    const body = { ok: false, error: { code: 'feature_unavailable', feature: 'match', message: '이 필드를 빼면 발행할 수 있어요' } }
    const response = makeHttpResponse(503, JSON.stringify(body))
    const outcome = decideOutcome(response, 'contract')
    expect(derivePublishExitCode(outcome, response)).toEqual({ exitCode: 4 })
  })

  it('JSON 502 publish_unknown(서버가 스스로 결과 불명을 알림) → 5', () => {
    const body = { ok: false, error: { code: 'publish_unknown', message: '서버도 몰라요' } }
    const response = makeHttpResponse(502, JSON.stringify(body))
    const outcome = decideOutcome(response, 'contract')
    const derived = derivePublishExitCode(outcome, response)
    expect(derived.exitCode).toBe(5)
  })

  it('JSON 5xx의 모르는 코드도 5(안전한 쪽으로)', () => {
    const body = { ok: false, error: { code: 'some_brand_new_code', message: 'm' } }
    const response = makeHttpResponse(500, JSON.stringify(body))
    const outcome = decideOutcome(response, 'contract')
    const derived = derivePublishExitCode(outcome, response)
    expect(derived.exitCode).toBe(5)
  })

  describe('5xx의 error.saved === false (서버가 저장하지 않았음이 확실하다고 알림)', () => {
    function derive(status: number, error: Record<string, unknown>) {
      const response = makeHttpResponse(status, JSON.stringify({ ok: false, error }))
      return derivePublishExitCode(decideOutcome(response, 'contract'), response)
    }

    it('모르는 코드여도 4다', () => {
      expect(derive(500, { code: 'some_brand_new_code', message: 'm', saved: false })).toEqual({ exitCode: 4 })
      expect(derive(503, { code: 'cover_store_down', message: 'm', saved: false })).toEqual({ exitCode: 4 })
    })

    it('publish_unknown처럼 결과 불명을 뜻하는 코드여도 saved:false가 우선한다', () => {
      expect(derive(502, { code: 'publish_unknown', message: 'm', saved: false })).toEqual({ exitCode: 4 })
    })

    it('saved가 없거나 불리언 false가 아니면 지금 규칙 그대로다(허용 목록 밖은 5)', () => {
      for (const saved of [undefined, true, 'false', 0, null, 'no']) {
        const error: Record<string, unknown> = { code: 'some_brand_new_code', message: 'm' }
        if (saved !== undefined) error.saved = saved
        expect(derive(500, error).exitCode).toBe(5)
      }
    })

    it('saved:true는 허용 목록 안의 코드여도 목록 규칙을 따른다(여기서는 4)', () => {
      expect(derive(500, { code: 'internal', message: 'm', saved: true }).exitCode).toBe(4)
    })

    it('다른 위치(최상위)의 saved:false는 보지 않는다', () => {
      const response = makeHttpResponse(500, JSON.stringify({ ok: false, saved: false, error: { code: 'some_brand_new_code', message: 'm' } }))
      expect(derivePublishExitCode(decideOutcome(response, 'contract'), response).exitCode).toBe(5)
    })

    it('bad_response(계약과 다른 5xx)는 saved를 읽을 수 없으니 5 그대로다', () => {
      const response = makeHttpResponse(502, '<html>bad gateway</html>')
      expect(derivePublishExitCode(decideOutcome(response, 'contract'), response).exitCode).toBe(5)
    })
  })

  it('4xx JSON 오류는 코드와 상관없이 4다(서버가 거절 = 저장 안 됨)', () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [409, 'conflict'],
      [404, 'not_found'],
      [400, 'some_unknown_code'],
    ] as const) {
      const body = { ok: false, error: { code, message: 'm' } }
      const response = makeHttpResponse(status, JSON.stringify(body))
      const outcome = decideOutcome(response, 'contract')
      expect(derivePublishExitCode(outcome, response).exitCode).toBe(4)
    }
  })

  it('validation_failed(1)·rate_limited(3)는 건드리지 않는다', () => {
    const validationBody = { ok: false, error: { code: 'validation_failed', message: 'm' }, blockers: [] }
    const validationResponse = makeHttpResponse(400, JSON.stringify(validationBody))
    const validationOutcome = decideOutcome(validationResponse, 'contract')
    expect(derivePublishExitCode(validationOutcome, validationResponse).exitCode).toBe(1)

    const rateBody = { ok: false, error: { code: 'rate_limited', message: 'm' } }
    const rateResponse = makeHttpResponse(429, JSON.stringify(rateBody))
    const rateOutcome = decideOutcome(rateResponse, 'contract')
    expect(derivePublishExitCode(rateOutcome, rateResponse).exitCode).toBe(3)
  })

  it('성공(0)은 건드리지 않는다', () => {
    const response = makeHttpResponse(201, JSON.stringify({ ok: true, slug: 'a', url: 'u', ownerUrl: 'o' }))
    const outcome = decideOutcome(response, 'contract')
    expect(derivePublishExitCode(outcome, response).exitCode).toBe(0)
  })
})

describe('isDefiniteConnectFailure / classifyPublishNetworkFailure', () => {
  it('연결이 정말 안 된 코드들은 확실한 실패다', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(isDefiniteConnectFailure(code)).toBe(true)
    }
  })

  it('TLS 인증서 계열은 확실한 실패다', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
    ]) {
      expect(isDefiniteConnectFailure(code)).toBe(true)
    }
  })

  it('그 밖의 코드(연결은 됐을 수 있음)는 확실한 실패가 아니다', () => {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'HPE_INVALID_CONSTANT', undefined]) {
      expect(isDefiniteConnectFailure(code)).toBe(false)
    }
  })

  it('timeout·connected-then-failed는 코드와 무관하게 5', () => {
    expect(classifyPublishNetworkFailure({ kind: 'timeout' })).toBe(5)
    expect(classifyPublishNetworkFailure({ kind: 'connected-then-failed' })).toBe(5)
  })

  it('connect-failed는 코드로 가른다', () => {
    expect(classifyPublishNetworkFailure({ kind: 'connect-failed', code: 'ECONNREFUSED' })).toBe(4)
    expect(classifyPublishNetworkFailure({ kind: 'connect-failed', code: 'ECONNRESET' })).toBe(5)
    expect(classifyPublishNetworkFailure({ kind: 'connect-failed', code: undefined })).toBe(5)
  })

  it('TLS 핸드셰이크 첫 바이트에서 갈리는 오류·인증서 체인 오류도 확실한 실패다(네 번째 리뷰 보강)', () => {
    for (const code of [
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'ERR_SSL_PACKET_LENGTH_TOO_LONG',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'UNABLE_TO_GET_ISSUER_CERT',
    ]) {
      expect(isDefiniteConnectFailure(code)).toBe(true)
    }
  })

  it('ERR_SSL_ 접두 전체를 허용 목록에 넣지 않는다(핸드셰이크 도중 오류가 섞여 있어서)', () => {
    expect(isDefiniteConnectFailure('ERR_SSL_SOME_OTHER_UNLISTED_ERROR')).toBe(false)
  })

  it("cause.message가 'bad port'면 코드 없이도 확실한 실패다", () => {
    expect(isDefiniteConnectFailure(undefined, 'bad port')).toBe(true)
    expect(classifyPublishNetworkFailure({ kind: 'connect-failed', code: undefined, message: 'bad port' })).toBe(4)
  })
})

describe('truncateRaw', () => {
  it('짧으면 그대로', () => {
    expect(truncateRaw('hi')).toBe('hi')
  })

  it('길면 자르고 말줄임표를 붙인다', () => {
    const long = 'a'.repeat(5000)
    const truncated = truncateRaw(long, 100)
    expect(truncated.length).toBe(101)
    expect(truncated.endsWith('…')).toBe(true)
  })
})

describe('withRetryAfterField', () => {
  it('retryAfterSeconds가 있으면 덧붙인다', () => {
    expect(withRetryAfterField({ ok: false }, 30)).toEqual({ ok: false, retryAfterSeconds: 30 })
  })

  it('없으면 그대로 둔다', () => {
    expect(withRetryAfterField({ ok: false }, undefined)).toEqual({ ok: false })
  })
})

describe('httpFetch 타임아웃(가짜 fetch)', () => {
  it('30초 안에 응답이 없으면(헤더 대기 중) timeout으로 분류한다', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted', 'AbortError')),
              )
            }),
        ),
      )
      const promise = httpFetch('https://api.example/slow', {})
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await promise
      expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('헤더는 받았지만 본문 스트림이 멈추면(res.text()가 멈춤) timeout으로 분류한다', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: unknown, init?: RequestInit) => {
          // fetch()는 곧장 resolve(헤더는 받았다)하지만, 본문 스트림 읽기
          // (res.text())는 우리 signal이 abort될 때까지 멈춰 있다 — 서버가
          // 헤더만 보내고 본문을 흘려보내지 않는 상황을 흉내 낸다.
          const res = new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () => {
                  controller.error(new DOMException('The operation was aborted', 'AbortError'))
                })
              },
            }),
            { status: 200 },
          )
          return Promise.resolve(res)
        }),
      )
      const promise = httpFetch('https://api.example/stall-body', {})
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await promise
      expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('헤더는 받았지만 본문이 우리 타임아웃과 무관하게 끊기면 connected-then-failed로 분류한다', async () => {
    vi.stubGlobal('fetch', async () => {
      const res = new Response('irrelevant')
      vi.spyOn(res, 'text').mockRejectedValue(new Error('ECONNRESET'))
      return res
    })
    const result = await httpFetch('https://api.example/dropped', {})
    expect(result).toEqual({ ok: false, failure: { kind: 'connected-then-failed' } })
  })

  it('fetch() 자체가 거부되면 connect-failed + code를 담는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('fetch failed') as Error & { cause?: unknown }
        err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }
        throw err
      }),
    )
    const result = await httpFetch('https://api.example/refused', {})
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'connect-failed', code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' },
    })
  })

  it('publish 타임아웃은 60초다', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted', 'AbortError')),
              )
            }),
        ),
      )
      const promise = postJson('https://api.example', '/api/v1/tests', {}, {}, 'letsplayquiz/1.0.0', 60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await promise
      expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } })
    } finally {
      vi.useRealTimers()
    }
  })
})

// 실제 TCP/HTTP 서버로 재현한다 — 가짜 fetch만으로는 undici가 실제로 어떤
// `cause.code`를 붙이는지 알 수 없다(2026-09-26 세 번째 리뷰, code-reviewer가
// 실측으로 이 구분을 확정했다).
describe('httpFetch — 실제 net/http 서버', () => {
  function listen(server: net.Server | http.Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('포트를 못 받았어요')
        resolve(address.port)
      })
    })
  }

  function close(server: net.Server | http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()))
  }

  it('안 쓰는 포트(연결 거부) → connect-failed + ECONNREFUSED', async () => {
    // 실제로 열려 있지 않은 포트를 하나 얻는다: 잠깐 리슨했다가 바로 닫는다.
    const probe = net.createServer()
    const port = await listen(probe)
    await close(probe)

    const result = await httpFetch(`http://127.0.0.1:${port}/`, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.kind).toBe('connect-failed')
      expect(result.failure.kind === 'connect-failed' && result.failure.code).toBe('ECONNREFUSED')
      expect(classifyPublishNetworkFailure(result.failure)).toBe(4)
    }
  })

  it('https로 평문 http 서버에 접속하면(TLS 핸드셰이크 실패) connect-failed + 확실한 실패(4)', async () => {
    // 평문 HTTP 서버를 열어 두고 https://로 접속한다 — TLS 클라이언트가 서버
    // 인사(ServerHello)를 기대하다가 평문 HTTP 바이트를 받으면 보통
    // ERR_SSL_WRONG_VERSION_NUMBER류로 즉시 실패한다(2026-09-26 네 번째 리뷰,
    // 실측 요구 항목).
    const server = http.createServer((_req, res) => res.end('plain http'))
    const port = await listen(server)
    try {
      const result = await httpFetch(`https://127.0.0.1:${port}/`, {})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.kind).toBe('connect-failed')
        expect(classifyPublishNetworkFailure(result.failure)).toBe(4)
      }
    } finally {
      await close(server)
    }
  })

  it('요청 본문을 읽고 소켓을 destroy하면 connected-then-failed', async () => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.socket?.destroy()
      })
    })
    const port = await listen(server)
    try {
      const result = await httpFetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(classifyPublishNetworkFailure(result.failure)).toBe(5)
      }
    } finally {
      await close(server)
    }
  })

  it('헤더 도중 소켓을 끊으면(resetAndDestroy) connected-then-failed 또는 connect-failed(비확정 코드) → 5', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n')
        // \r\n\r\n을 보내지 않고 헤더 도중에 끊는다.
        socket.destroy()
      })
    })
    const port = await listen(server)
    try {
      const result = await httpFetch(`http://127.0.0.1:${port}/`, {})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(classifyPublishNetworkFailure(result.failure)).toBe(5)
      }
    } finally {
      await close(server)
    }
  })

  it('쓰레기 응답(HTTP도 아닌 바이트) → 5', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.end('이건 HTTP 응답이 아니에요 그냥 쓰레기입니다 asdkfjalksdjf')
      })
    })
    const port = await listen(server)
    try {
      const result = await httpFetch(`http://127.0.0.1:${port}/`, {})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(classifyPublishNetworkFailure(result.failure)).toBe(5)
      }
    } finally {
      await close(server)
    }
  })

  it('201 + 잘린 JSON → fetch는 성공하지만 publish 계약(ok 필드)이 깨져 있다 → derivePublishExitCode가 5', async () => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end('{"ok": true, "slug": "abc"') // 잘린 JSON
      })
    })
    const port = await listen(server)
    try {
      const result = await httpFetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const outcome = decideOutcome(result.response, 'contract')
        const derived = derivePublishExitCode(outcome, result.response)
        expect(derived.exitCode).toBe(5)
      }
    } finally {
      await close(server)
    }
  })

  it('504 text/plain(비JSON) → derivePublishExitCode가 5 + raw', async () => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(504, { 'content-type': 'text/plain' })
        res.end('Gateway Timeout')
      })
    })
    const port = await listen(server)
    try {
      const result = await httpFetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const outcome = decideOutcome(result.response, 'contract')
        const derived = derivePublishExitCode(outcome, result.response)
        expect(derived.exitCode).toBe(5)
        expect(derived.raw).toBe('Gateway Timeout')
      }
    } finally {
      await close(server)
    }
  })

  it('JSON 500 internal → derivePublishExitCode가 4', async () => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: '문제가 생겼어요' } }))
      })
    })
    const port = await listen(server)
    try {
      const result = await httpFetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const outcome = decideOutcome(result.response, 'contract')
        const derived = derivePublishExitCode(outcome, result.response)
        expect(derived.exitCode).toBe(4)
      }
    } finally {
      await close(server)
    }
  })

  it('다른 주소로 보내는 서버: 따라가지 않고 두 번째 서버는 요청을 받지 못한다(POST 본문 재전송 없음) → publish 4', async () => {
    let targetHits = 0
    const target = http.createServer((req, res) => {
      targetHits += 1
      req.resume()
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, slug: 'a', url: 'u', ownerUrl: 'o' }))
    })
    const targetPort = await listen(target)
    let sourceHits = 0
    const source = http.createServer((req, res) => {
      sourceHits += 1
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/api/v1/tests` })
        res.end('moved')
      })
    })
    const sourcePort = await listen(source)
    try {
      const result = await postJson(`http://127.0.0.1:${sourcePort}`, '/api/v1/tests', { kind: 'balance' }, {}, 'letsplayquiz/1.0.0')
      expect(result.ok).toBe(true)
      if (result.ok) {
        const outcome = decideOutcome(result.response, 'contract')
        expect(derivePublishExitCode(outcome, result.response).exitCode).toBe(4)
        expect((outcome.json as { error: { code: string; location: string } }).error).toMatchObject({
          code: 'redirected',
          location: `http://127.0.0.1:${targetPort}/api/v1/tests`,
        })
      }
      expect(sourceHits).toBe(1)
      expect(targetHits).toBe(0)
    } finally {
      await close(source)
      await close(target)
    }
  })
})
