// letsplaytest 서버(스펙 §4)와의 HTTP 계약을 다루는 얇은 층. `fetch`는 전역
// 함수를 그대로 쓴다(런타임 의존성 0개, 스펙 §7.1) — 테스트는
// `vi.stubGlobal('fetch', …)`로 갈아끼운다.

export function userAgent(version: string): string {
  return `letsplaytest/${version}`
}

export interface HttpResponse {
  status: number
  headers: Headers
  text: string
}

export type HttpResult = { ok: true; response: HttpResponse } | { ok: false; timedOut?: boolean }

/** 서버가 30초 안에 응답하지 않으면(헤더든 본문이든) 포기한다 — 응답 없는 서버 때문에
 * 에이전트가 영영 멈춰 있게 두지 않는다. `AbortController`의 signal은 fetch의 헤더
 * 수신뿐 아니라 진행 중인 본문 스트림 읽기(`res.text()`)도 함께 중단시킨다(Fetch
 * 표준 동작) — 그래서 타이머 하나로 "본문 읽기까지 포함"이 된다. `setTimeout`을
 * 직접 쓰는 이유는 `AbortSignal.timeout()`이 테스트의 fake timer로 제어되지 않기
 * 때문이다.
 */
const DEFAULT_TIMEOUT_MS = 30_000

export async function httpFetch(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    return { ok: true, response: { status: res.status, headers: res.headers, text } }
  } catch {
    if (controller.signal.aborted) return { ok: false, timedOut: true }
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
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
): Promise<HttpResult> {
  const url = buildUrl(api, '/api/v1/guide', {
    kind: opts.kind,
    lang: opts.lang,
    format: opts.asJson ? 'json' : undefined,
  })
  return httpFetch(url, { headers: { 'User-Agent': ua } }, timeoutMs)
}

export async function postJson(
  api: string,
  path: string,
  body: unknown,
  opts: { lang?: string },
  ua: string,
  timeoutMs?: number,
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
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type ExitCode = 0 | 1 | 3 | 4

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
 * `bad_response` 오류 본문을 만든다.
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

/** `--json` 출력에 `retryAfterSeconds`를 덧붙인다(429/503일 때만 값이 있다).
 * 서버가 이미 그 필드를 실었으면 덮어쓰지 않는다. */
export function withRetryAfterField(json: unknown, retryAfterSeconds: number | undefined): unknown {
  if (retryAfterSeconds === undefined || !isRecord(json) || 'retryAfterSeconds' in json) return json
  return { ...json, retryAfterSeconds }
}
