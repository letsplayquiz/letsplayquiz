// letsplayquiz 서버(스펙 §4)와의 HTTP 계약을 다루는 얇은 층. `fetch`는 전역
// 함수를 그대로 쓴다(런타임 의존성 0개, 스펙 §7.1) — 테스트는
// `vi.stubGlobal('fetch', …)`로 갈아끼운다.

export function userAgent(version: string): string {
  return `letsplayquiz/${version}`
}

export interface HttpResponse {
  status: number
  headers: Headers
  text: string
}

/**
 * `fetch()`가 실패하는 세 가지 모양(2026-09-26 세 번째 리뷰 라운드 — 실제 net/http
 * 서버로 재현해 확정):
 * - `timeout`: 우리 타이머가 먼저 끊었다(헤더를 기다리던 중이든, 본문을 읽던
 *   중이든). POST는 이 시점에 요청 바이트가 이미 다 나가 있는 경우가 많다 —
 *   publish라면 서버가 이미 처리했을 수 있다는 뜻이라 "확실히 실패"로 볼 수 없다.
 * - `connected-then-failed`: `fetch()`는 성공해 응답(헤더)까지 받았지만 본문을
 *   읽는 도중 연결이 끊겼다(우리 타임아웃 때문이 아니다). 헤더를 받았다는 건
 *   TCP 연결이 서버까지 열려 요청이 도달했다는 뜻이므로, 이것도 "확실히 실패"가
 *   아니다.
 * - `connect-failed`: `fetch()` 자체가 거부됐다. 이 경우조차 하나로 뭉뚱그릴 수
 *   없다 — `ECONNREFUSED`처럼 TCP 핸드셰이크 전에 끝나는 오류는 요청이 정말
 *   안 나간 것이지만, `ECONNRESET`처럼 연결은 됐다가 끊긴 오류는 요청이 이미
 *   갔을 수 있다. 그래서 `code`(Node fetch/undici가 `error.cause.code`에 싣는
 *   저수준 errno/오류명)를 함께 돌려준다 — 호출자가(주로 publish) 그 값으로
 *   "확실히 안 감"과 "확실하지 않음"을 가른다.
 */
export type HttpFailure =
  | { kind: 'timeout' }
  | { kind: 'connected-then-failed' }
  | { kind: 'connect-failed'; code?: string; message?: string }

export type HttpResult = { ok: true; response: HttpResponse } | { ok: false; failure: HttpFailure }

/** 서버가 정해진 시간 안에 응답하지 않으면(헤더든 본문이든) 포기한다 — 응답
 * 없는 서버 때문에 에이전트가 영영 멈춰 있게 두지 않는다. `AbortController`의
 * signal은 fetch의 헤더 수신뿐 아니라 진행 중인 본문 스트림 읽기(`res.text()`)도
 * 함께 중단시킨다(Fetch 표준 동작) — 그래서 타이머 하나로 "본문 읽기까지 포함"이
 * 된다. `setTimeout`을 직접 쓰는 이유는 `AbortSignal.timeout()`이 테스트의 fake
 * timer로 제어되지 않기 때문이다.
 */
export const DEFAULT_TIMEOUT_MS = 30_000
/** publish만 60초 — 타임아웃 자체가 "발행됐을 수도 있다"는 뜻이 되므로(스펙
 * §7.4), 너무 짧게 끊어 애매한 상태를 자주 만들지 않는다(2026-09-26 조율자 결정). */
export const PUBLISH_TIMEOUT_MS = 60_000

function extractCode(e: unknown): string | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | undefined
  if (typeof err?.cause?.code === 'string') return err.cause.code
  if (typeof err?.code === 'string') return err.code
  return undefined
}

function extractMessage(e: unknown): string | undefined {
  const err = e as { cause?: { message?: unknown }; message?: unknown } | undefined
  if (typeof err?.cause?.message === 'string') return err.cause.message
  if (typeof err?.message === 'string') return err.message
  return undefined
}

export async function httpFetch(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<HttpResult> {
  const controller = new AbortController()
  // 호출자가 취소하면(예: MCP 클라이언트의 취소) 타임아웃과 똑같이 다룬다 — 요청이
  // 이미 서버에 닿았을 수 있어 publish는 "결과 불명"으로 분류된다.
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    clearTimeout(timer)
    if (controller.signal.aborted) return { ok: false, failure: { kind: 'timeout' } }
    return { ok: false, failure: { kind: 'connect-failed', code: extractCode(e), message: extractMessage(e) } }
  }
  try {
    const text = await res.text()
    clearTimeout(timer)
    return { ok: true, response: { status: res.status, headers: res.headers, text } }
  } catch {
    clearTimeout(timer)
    if (controller.signal.aborted) return { ok: false, failure: { kind: 'timeout' } }
    return { ok: false, failure: { kind: 'connected-then-failed' } }
  }
}

/**
 * 요청이 **확실히** 서버에 닿지 못했다고 볼 수 있는 저수준 오류 코드만 여기
 * 둔다(2026-09-26 조율자 결정, 네 번째 리뷰에서 TLS·"bad port" 계열 보강) —
 * 그 밖의 모든 `connect-failed`는 "확실하지 않음"으로 다룬다. DNS·라우팅·
 * TLS 핸드셰이크·로컬 URL 검증 오류는 TCP로 실제 바이트가 오가기 전에
 * 끝나므로 여기 들어간다. `ECONNRESET`·`UND_ERR_SOCKET`·`HPE_*`처럼 연결
 * 자체는 있었을 수 있는 오류는 일부러 뺐다. `ERR_SSL_` 접두 전체를 넣지
 * 않는 이유: 그 아래엔 핸드셰이크 **도중**(즉 어느 정도 바이트가 오간 뒤)
 * 발생하는 오류도 섞여 있어, 확인된 두 개(버전 불일치·패킷 길이 초과 — 둘 다
 * 첫 바이트에서 갈리는 오류)만 콕 집어 넣는다.
 */
const DEFINITE_CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_INVALID_URL',
  'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
])

export function isDefiniteConnectFailure(code: string | undefined, message?: string): boolean {
  // "bad port"는 undici가 안전하지 않다고 보는 포트(스모크·메일 포트 등)로
  // 요청을 보내기 전에 로컬에서 거절하는 경우다 — code 없이 message로만
  // 온다.
  if (message === 'bad port') return true
  if (code === undefined) return false
  if (DEFINITE_CONNECT_FAILURE_CODES.has(code)) return true
  return code.startsWith('CERT_')
}

/**
 * publish 전용 판정: 네트워크 실패를 4(확실히 발행 안 됨)와 5(발행됐을 수
 * 있음)로 가른다. `timeout`·`connected-then-failed`는 언제나 5다(2026-09-26
 * 조율자 결정) — `connect-failed`만 코드/메시지를 본다.
 */
export function classifyPublishNetworkFailure(failure: HttpFailure): 4 | 5 {
  if (failure.kind !== 'connect-failed') return 5
  return isDefiniteConnectFailure(failure.code, failure.message) ? 4 : 5
}

/**
 * `api`의 경로(있다면)를 보존하며 상대 경로를 붙인다. `https://host/sub/`처럼
 * 베이스에 경로가 있어도 `api/v1/...`가 그 아래로 들어가야 한다 — `new URL(path,
 * base)`에 절대 경로(`/api/v1/...`)를 그대로 넘기면 베이스의 경로가 통째로
 * 사라지기 때문에 직접 이어 붙인다.
 */
function buildUrl(api: string, requestPath: string, query: Record<string, string | undefined>): string {
  const base = new URL(api)
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  const relative = requestPath.startsWith('/') ? requestPath.slice(1) : requestPath
  const url = new URL(basePath + relative, base.origin)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

export async function fetchGuide(
  api: string,
  opts: { kind?: string; lang?: string; asJson: boolean },
  ua: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<HttpResult> {
  const url = buildUrl(api, '/api/v1/guide', {
    kind: opts.kind,
    lang: opts.lang,
    format: opts.asJson ? 'json' : undefined,
  })
  return httpFetch(url, { headers: { 'User-Agent': ua } }, timeoutMs, signal)
}

export async function postJson(
  api: string,
  path: string,
  body: unknown,
  opts: { lang?: string },
  ua: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<HttpResult> {
  const url = buildUrl(api, path, { lang: opts.lang })
  return httpFetch(
    url,
    {
      method: 'POST',
      headers: { 'User-Agent': ua, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
    signal,
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type ExitCode = 0 | 1 | 3 | 4 | 5

export interface Outcome {
  exitCode: ExitCode
  json?: unknown
  retryAfterSeconds?: number
}

/** `Retry-After`는 스펙상 항상 초 단위 정수다. 날짜 형식(HTTP-date)이나 빈 값,
 * 음수·NaN은 신뢰하지 않고 "잠시 후"로 뭉뚱그린다. */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined
  const n = Number(header)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export type ResponseMode = 'guide' | 'contract'

/**
 * 서버 응답을 종료 코드로 바꾼다(스펙 §7.4). **상태 코드가 아니라 본문 `ok`로
 * 0/1을 가른다** — validate는 실패해도 200을 낸다. 3/4는 `error.code`로 가른다.
 *
 * `mode: 'contract'`(validate/publish)는 서버가 **항상** `{ ok: boolean, ... }`를
 * 낸다고 계약돼 있다(스펙 §4.1). 그래서 JSON이 아니거나 `ok`가 boolean이 아니면
 * — 프록시 오류 페이지, 빈 본문, 스키마가 다른 응답 — 성공(`exitCode: 0`)으로
 * 잘못 읽지 않도록 무조건 4로 떨어뜨리고, 에이전트가 원인을 알 수 있게 합성한
 * `bad_response` 오류 본문을 만든다. **publish**는 이 4를 그대로 쓰지 않고
 * `derivePublishExitCode`로 한 번 더 거른다(상태가 2xx/5xx면 5로 올린다) —
 * validate는 저장을 안 하니 애매할 게 없어 그대로 4를 쓴다.
 *
 * `mode: 'guide'`는 성공 응답에 `ok` 필드가 없다(마크다운 텍스트 또는 설명서
 * JSON 그 자체이기 때문) — 그래서 상태 코드로 성공을 판단한다.
 */
export function decideOutcome(response: HttpResponse, mode: ResponseMode = 'contract'): Outcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text)
  } catch {
    parsed = undefined
  }

  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'))

  const classifyError = (body: Record<string, unknown>): Outcome => {
    const code = isRecord(body.error) ? body.error.code : undefined
    if (code === 'rate_limited') return { exitCode: 3, json: body, retryAfterSeconds }
    if (code === 'validation_failed') return { exitCode: 1, json: body, retryAfterSeconds }
    return { exitCode: 4, json: body, retryAfterSeconds }
  }

  if (mode === 'guide') {
    if (isRecord(parsed) && parsed.ok === false) return classifyError(parsed)
    const success = response.status >= 200 && response.status < 300
    return { exitCode: success ? 0 : 4, json: parsed, retryAfterSeconds }
  }

  // mode === 'contract': ok가 boolean이 아니면 계약 위반 — 무조건 4.
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    return {
      exitCode: 4,
      json: {
        ok: false,
        error: {
          code: 'bad_response',
          message: '서버 응답을 이해할 수 없어요(JSON도, 계약된 모양도 아니에요)',
          status: response.status,
        },
      },
      retryAfterSeconds,
    }
  }

  if (parsed.ok === false) return classifyError(parsed)
  return { exitCode: 0, json: parsed, retryAfterSeconds }
}

function outcomeErrorCode(outcome: Outcome): string | undefined {
  return isRecord(outcome.json) && isRecord(outcome.json.error) && typeof outcome.json.error.code === 'string'
    ? outcome.json.error.code
    : undefined
}

function isBadResponseOutcome(outcome: Outcome): boolean {
  return outcome.exitCode === 4 && outcomeErrorCode(outcome) === 'bad_response'
}

export function truncateRaw(text: string, maxChars = 2000): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

// `/owner/<token>`(JSON이 슬래시를 `\/`로 이스케이프한 꼴 포함)의 토큰 자리.
const OWNER_PATH_RE = /(\\?\/owner\\?\/)[^\s"'<>\\/?#&]+/g
// `"ownerUrl": "…"`(그리고 `owner`로 시작하는 다른 키)의 값 전체.
const OWNER_FIELD_RE = /("owner[A-Za-z]*"\s*:\s*)"(?:[^"\\]|\\.)*"/g

/**
 * 받은 원문을 사람·로그에 보여 주기 전에 owner 토큰을 가린다(SWE-46). 결과 불명(5)
 * 출력은 원문을 그대로 싣는데, 에이전트가 CI에서 돌리면 그 출력이 로그로 남는다 —
 * 대시보드 주소가 섞여 있으면 토큰이 샌다. 사람이 원문에서 확인할 것은 "발행됐는지"
 * (slug·url)이지 토큰이 아니고, 토큰이 필요하면 사이트의 내 테스트 목록이나 서버
 * 기록으로 찾는다.
 */
export function redactOwnerSecrets(text: string): string {
  return text.replace(OWNER_FIELD_RE, '$1"[redacted]"').replace(OWNER_PATH_RE, '$1[redacted]')
}

/** publish에서 "확실히 실패"로 봐도 되는 유일한 4 오류 코드들. 이 목록에 없는
 * 코드(서버가 새 코드를 추가했거나, `publish_unknown`처럼 서버 스스로도
 * 결과를 모른다고 알리는 경우)는 안전한 쪽(5)으로 본다(2026-09-26 조율자
 * 결정 — T6 서버가 "결과 불명"을 502 `publish_unknown`으로 알리기 시작했다). */
const DEFINITE_4_ERROR_CODES = new Set(['internal', 'unavailable', 'invalid_json', 'payload_too_large', 'unsupported_media_type'])

/**
 * publish 전용: `decideOutcome`이 4를 냈어도 그 4가 정말 "확실한 실패"인지
 * 한 번 더 거른다.
 * - `bad_response`(계약과 다른 응답)인데 상태가 2xx(서버는 성공했다고 믿는
 *   듯한데 본문이 계약과 다름)나 5xx(게이트웨이가 원본 서버 뒤에서 끊겼을
 *   수 있음)면 5로 올린다. 원문(5xx는 2KB로 자름)을 함께 돌려준다.
 * - 계약대로 온 `{ ok: false, error: { code } }`이고 상태가 **4xx**면
 *   `code`가 무엇이든(모르는 코드라도) 그대로 4다(2026-09-26 네 번째 리뷰,
 *   codex 지적) — 4xx는 서버가 요청 자체를 거절했다는 뜻이라 저장까지 갔을
 *   여지가 없다. (`validation_failed`·`rate_limited`는 이 분기에 오지 않는다
 *   — `decideOutcome`이 이미 1/3로 따로 뺐다.)
 * - 상태가 **5xx**이고 `code`가 `DEFINITE_4_ERROR_CODES`에 없으면(서버가
 *   결과 불명을 스스로 알리는 `publish_unknown` 포함, 모르는 새 코드도
 *   포함) 5로 올린다 — 게이트웨이 뒤에서 무슨 일이 있었는지 알 수 없다.
 * - 그 밖의 4(`internal`·`unavailable`·`invalid_json`·`payload_too_large`·
 *   `unsupported_media_type`, 4xx 전부)는 그대로 4다.
 */
export function derivePublishExitCode(outcome: Outcome, response: HttpResponse): { exitCode: ExitCode; raw?: string } {
  if (outcome.exitCode !== 4) return { exitCode: outcome.exitCode }

  if (isBadResponseOutcome(outcome)) {
    const ambiguousStatus = (response.status >= 200 && response.status < 300) || response.status >= 500
    if (!ambiguousStatus) return { exitCode: 4 }
    const redacted = redactOwnerSecrets(response.text)
    const raw = response.status >= 500 ? truncateRaw(redacted, 2000) : redacted
    return { exitCode: 5, raw }
  }

  const code = outcomeErrorCode(outcome)
  if (code !== undefined && response.status >= 500 && !DEFINITE_4_ERROR_CODES.has(code)) {
    return { exitCode: 5, raw: redactOwnerSecrets(response.text) }
  }

  return { exitCode: 4 }
}

/** `--json` 출력에 `retryAfterSeconds`를 덧붙인다(429/503일 때만 값이 있다).
 * 서버가 이미 그 필드를 실었으면 덮어쓰지 않는다. */
export function withRetryAfterField(json: unknown, retryAfterSeconds: number | undefined): unknown {
  if (retryAfterSeconds === undefined || !isRecord(json) || 'retryAfterSeconds' in json) return json
  return { ...json, retryAfterSeconds }
}
