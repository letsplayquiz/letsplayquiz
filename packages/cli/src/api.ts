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

export type HttpResult = { ok: true; response: HttpResponse } | { ok: false }

export async function httpFetch(url: string, init: RequestInit): Promise<HttpResult> {
  try {
    const res = await fetch(url, init)
    const text = await res.text()
    return { ok: true, response: { status: res.status, headers: res.headers, text } }
  } catch {
    return { ok: false }
  }
}

function buildUrl(api: string, path: string, query: Record<string, string | undefined>): string {
  const url = new URL(path, api)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

export async function fetchGuide(
  api: string,
  opts: { kind?: string; lang?: string; asJson: boolean },
  ua: string,
): Promise<HttpResult> {
  const url = buildUrl(api, '/api/v1/guide', {
    kind: opts.kind,
    lang: opts.lang,
    format: opts.asJson ? 'json' : undefined,
  })
  return httpFetch(url, { headers: { 'User-Agent': ua } })
}

export async function postJson(
  api: string,
  path: string,
  body: unknown,
  opts: { lang?: string },
  ua: string,
): Promise<HttpResult> {
  const url = buildUrl(api, path, { lang: opts.lang })
  return httpFetch(url, {
    method: 'POST',
    headers: { 'User-Agent': ua, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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

/**
 * 서버 응답을 종료 코드로 바꾼다(스펙 §7.4). **상태 코드가 아니라 본문 `ok`로
 * 0/1을 가른다** — validate는 실패해도 200을 낸다. 3/4는 `error.code`로 가른다.
 * JSON으로 파싱되지 않는 응답(HTML 오류 페이지 등)은 4다. guide의 성공 응답은
 * `ok` 필드가 없는 문서(마크다운 텍스트 또는 설명서 JSON)라 상태 코드로 판단한다.
 */
export function decideOutcome(response: HttpResponse): Outcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text)
  } catch {
    parsed = undefined
  }

  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : undefined

  if (isRecord(parsed) && parsed.ok === false) {
    const code = isRecord(parsed.error) ? parsed.error.code : undefined
    if (code === 'rate_limited') return { exitCode: 3, json: parsed, retryAfterSeconds }
    if (code === 'validation_failed') return { exitCode: 1, json: parsed }
    return { exitCode: 4, json: parsed }
  }
  if (isRecord(parsed) && parsed.ok === true) {
    return { exitCode: 0, json: parsed }
  }

  const success = response.status >= 200 && response.status < 300
  return { exitCode: success ? 0 : 4, json: parsed }
}
