// 도구 본체. MCP SDK와 무관한 순수 함수로 두어 fetch만 갈아끼워 테스트한다.
// 판정은 CLI(letsplayquiz/lib)의 것을 그대로 쓴다 — 종료 코드 의미:
// 0 성공, 1 검증 실패, 3 요청 한도, 4 확실히 실패, 5 결과 불명.
import {
  fetchGuide,
  postJson,
  decideOutcome,
  derivePublishExitCode,
  classifyPublishNetworkFailure,
  isRecord,
  redactOwnerSecrets,
  withRetryAfterField,
  formatIssues,
  saveRecord,
  loadRecords,
  PUBLISH_TIMEOUT_MS,
  type StoreIo,
  type HttpFailure,
} from 'letsplayquiz/lib'

export interface ToolContext {
  api: string
  ua: string
  store: StoreIo
}

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function text(t: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content: [{ type: 'text', text: t }], ...extra }
}

function errorText(t: string, structured?: Record<string, unknown>): ToolResult {
  return text(t, { isError: true, ...(structured ? { structuredContent: structured } : {}) })
}

function retryMessage(seconds: number | undefined): string {
  return seconds !== undefined ? `Please retry in ${seconds} seconds.` : 'Please retry in a little while.'
}

function connectError(ctx: ToolContext, failure: HttpFailure): ToolResult {
  const message =
    failure.kind === 'timeout'
      ? 'The server did not respond within the time limit.'
      : `Could not reach the server: ${ctx.api}`
  return errorText(message, { ok: false, error: { code: 'unreachable', message } })
}

function arrayOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export async function getGuide(ctx: ToolContext, args: { kind?: string; lang?: string }): Promise<ToolResult> {
  const result = await fetchGuide(ctx.api, { kind: args.kind, lang: args.lang, asJson: true }, ctx.ua)
  if (!result.ok) return connectError(ctx, result.failure)
  const outcome = decideOutcome(result.response, 'guide')
  if (outcome.exitCode === 0) {
    if (!isRecord(outcome.json)) {
      const message = 'The server did not return JSON for the guide (format=json).'
      return errorText(message, { ok: false, error: { code: 'bad_response', message, status: result.response.status } })
    }
    return text(JSON.stringify(outcome.json), { structuredContent: outcome.json as Record<string, unknown> })
  }
  return failureResult(outcome, result.response.status)
}

/** 가이드/검증의 비성공 결과를 공통으로 그린다(검증 실패 1은 호출 쪽에서 먼저 거른다). */
function failureResult(outcome: ReturnType<typeof decideOutcome>, status: number): ToolResult {
  const json = withRetryAfterField(outcome.json, outcome.retryAfterSeconds)
  const structured = isRecord(json) ? (json as Record<string, unknown>) : undefined
  if (outcome.exitCode === 3) {
    return errorText(`Rate limited. ${retryMessage(outcome.retryAfterSeconds)}`, structured)
  }
  const message =
    isRecord(outcome.json) && isRecord(outcome.json.error) && typeof outcome.json.error.message === 'string'
      ? outcome.json.error.message
      : `The server returned an unexpected response (HTTP ${status}).`
  return errorText(message, structured)
}

export async function validateQuiz(
  ctx: ToolContext,
  args: { quiz: Record<string, unknown>; lang?: string },
): Promise<ToolResult> {
  const result = await postJson(ctx.api, '/api/v1/tests/validate', args.quiz, { lang: args.lang }, ctx.ua)
  if (!result.ok) return connectError(ctx, result.failure)
  const outcome = decideOutcome(result.response, 'contract')
  const body = outcome.json
  if (outcome.exitCode === 0 && isRecord(body)) {
    const warnings = arrayOf(body.warnings)
    const lines = ['Validation passed. Safe to publish.']
    if (warnings.length > 0) lines.push('Warnings:', formatIssues(warnings))
    return text(lines.join('\n'), { structuredContent: { ok: true, blockers: [], warnings } })
  }
  // 검증 실패는 정상 결과다(MCP 오류가 아니다) — 에이전트가 고쳐서 다시 부른다.
  if (outcome.exitCode === 1 && isRecord(body)) {
    const blockers = arrayOf(body.blockers)
    const warnings = arrayOf(body.warnings)
    const lines = ['Validation failed. Fix the blockers and validate again.', 'Blockers:', formatIssues(blockers)]
    if (warnings.length > 0) lines.push('Warnings:', formatIssues(warnings))
    return text(lines.join('\n'), { structuredContent: { ok: false, blockers, warnings } })
  }
  return failureResult(outcome, result.response.status)
}

const PUBLISH_UNKNOWN =
  'The quiz MAY have been published (the outcome is unknown). Do NOT retry publish automatically — ask the user to check first.'

function publishUnknown(raw?: string): ToolResult {
  const redacted = raw === undefined ? undefined : redactOwnerSecrets(raw)
  const lines = [PUBLISH_UNKNOWN]
  if (redacted !== undefined) lines.push(`Raw server response (owner links redacted): ${redacted}`)
  return errorText(lines.join('\n'), {
    ok: false,
    error: { code: 'publish_unknown', message: PUBLISH_UNKNOWN },
    ...(redacted !== undefined ? { raw: redacted } : {}),
  })
}

export async function publishQuiz(
  ctx: ToolContext,
  args: { quiz: Record<string, unknown>; lang?: string; save?: boolean },
): Promise<ToolResult> {
  const save = args.save ?? true
  const result = await postJson(ctx.api, '/api/v1/tests', args.quiz, { lang: args.lang }, ctx.ua, PUBLISH_TIMEOUT_MS)
  if (!result.ok) {
    if (classifyPublishNetworkFailure(result.failure) === 4) {
      const message = `Not published: could not connect to the server (${ctx.api}).`
      return errorText(message, { ok: false, error: { code: 'unreachable', message } })
    }
    return publishUnknown()
  }
  const outcome = decideOutcome(result.response, 'contract')

  if (outcome.exitCode === 0) {
    const body = outcome.json
    if (
      !isRecord(body) ||
      typeof body.slug !== 'string' ||
      typeof body.url !== 'string' ||
      typeof body.ownerUrl !== 'string'
    ) {
      return publishUnknown(result.response.text)
    }
    const warnings = arrayOf(body.warnings)
    const lines = [
      'Published.',
      `url: ${body.url}`,
      `ownerUrl: ${body.ownerUrl}`,
      'WARNING: ownerUrl is the only proof of ownership and cannot be reissued. Keep it private and give it only to the creator.',
    ]
    if (warnings.length > 0) lines.push('Warnings:', formatIssues(warnings))
    let saved = false
    if (save) {
      const title = typeof args.quiz.title === 'string' ? args.quiz.title : ''
      const kind = typeof args.quiz.kind === 'string' ? args.quiz.kind : ''
      const saveResult = await saveRecord(ctx.store, {
        slug: body.slug,
        title,
        kind,
        url: body.url,
        ownerUrl: body.ownerUrl,
        api: ctx.api,
        publishedAt: new Date().toISOString(),
      })
      saved = !saveResult.warning
      lines.push(saveResult.warning ? `Local history not saved: ${saveResult.warning}` : 'Saved to local history.')
    }
    return text(lines.join('\n'), {
      structuredContent: { ok: true, slug: body.slug, url: body.url, ownerUrl: body.ownerUrl, warnings, saved },
    })
  }

  const derived = derivePublishExitCode(outcome, result.response)
  if (derived.exitCode === 5) return publishUnknown(derived.raw)

  const body = outcome.json
  if (outcome.exitCode === 1 && isRecord(body)) {
    const blockers = arrayOf(body.blockers)
    const warnings = arrayOf(body.warnings)
    const lines = ['Not published: validation failed.', 'Blockers:', formatIssues(blockers)]
    if (warnings.length > 0) lines.push('Warnings:', formatIssues(warnings))
    return text(lines.join('\n'), { structuredContent: { ok: false, published: false, blockers, warnings } })
  }
  const r = failureResult(outcome, result.response.status)
  r.content[0].text = `Not published. ${r.content[0].text}`
  return r
}

export async function listMyQuizzes(ctx: ToolContext): Promise<ToolResult> {
  const { records, warning } = await loadRecords(ctx.store)
  const sorted = [...records].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  const lines =
    sorted.length === 0
      ? ['No quizzes published from this machine yet.']
      : sorted.map((r) => `${r.publishedAt}  ${r.kind}  ${r.title}\n  url: ${r.url}\n  ownerUrl: ${r.ownerUrl}`)
  if (warning) lines.push(`Note: ${warning}`)
  return text(lines.join('\n'), { structuredContent: { records: sorted, ...(warning ? { warning } : {}) } })
}
