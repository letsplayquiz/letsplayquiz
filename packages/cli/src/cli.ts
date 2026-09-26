// letsplaytest CLI 본체. `run(argv, io)`가 핵심이고, `main()`은 이걸 실제
// `process`에 연결한다(테스트는 `run`만 직접 부른다 — process를 건드리지 않고
// 종료 코드를 검사할 수 있다). 실행 파일 진입점은 `bin.ts`다 — npm/npx가 만드는
// `bin`은 심볼릭 링크인데, "이 모듈이 메인 모듈인가"를 `import.meta.url`과
// `argv[1]`을 비교해 판정하던 예전 방식은 심볼릭 링크를 통해 실행되면 두 URL이
// 달라져 거짓으로 판정되고 CLI가 아무 것도 안 하고 조용히 종료해 버렸다. 그래서
// 이 파일은 조건부 실행을 하지 않고, `bin.ts`가 무조건 `main()`을 부른다.
import { createRequire } from 'node:module'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'

import { parseArgs, HELP_TEXT, type ParsedArgs } from './args.js'
import {
  fetchGuide,
  postJson,
  decideOutcome,
  derivePublishExitCode,
  classifyPublishNetworkFailure,
  tryExtractLinks,
  isRecord,
  userAgent,
  withRetryAfterField,
  PUBLISH_TIMEOUT_MS,
  type Outcome,
} from './api.js'
import { formatIssues } from './format.js'
import { saveRecord, loadRecords, type StoreIo } from './store.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }
export const VERSION = pkg.version

export interface Io {
  stdout: (s: string) => void
  stderr: (s: string) => void
  readStdin: () => Promise<string>
  isStdinTTY: () => boolean
  env: NodeJS.ProcessEnv
  homedir: () => string
}

function storeIo(io: Io): StoreIo {
  return { env: io.env, homedir: io.homedir }
}

/** UTF-8 BOM(`﻿`)이 앞에 붙어 있으면 지운다 — Windows 메모장 등으로 저장한
 * JSON 파일에 흔히 붙는데, `JSON.parse`는 이걸 그대로 문법 오류로 본다. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function readInput(
  file: string,
  io: Io,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (file === '-') {
    if (io.isStdinTTY()) {
      return {
        ok: false,
        message: '표준 입력이 비어 있어요 — 터미널에 직접 입력하지 말고 파일을 쓰거나 파이프로 보내 주세요',
      }
    }
    try {
      const text = await io.readStdin()
      return { ok: true, text: stripBom(text) }
    } catch (e) {
      return { ok: false, message: `표준 입력을 읽을 수 없어요: ${(e as Error).message}` }
    }
  }
  try {
    const text = await fsPromises.readFile(file, 'utf8')
    return { ok: true, text: stripBom(text) }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return { ok: false, message: `파일을 찾을 수 없어요: ${file}` }
    return { ok: false, message: `파일을 읽을 수 없어요: ${file} (${err.message})` }
  }
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function retryMessage(seconds: number | undefined): string {
  return seconds !== undefined ? `${seconds}초 후 다시 시도해 주세요` : '잠시 후 다시 시도해 주세요'
}

const PUBLISH_UNKNOWN_MESSAGE = '발행됐을 수 있어요. 다시 publish하지 말고 사용자에게 확인하세요'

/**
 * publish에서만 쓰는 "발행 결과 불명"(종료 코드 5) 출력. 요청이 서버에 이미
 * 도달했을 가능성이 있는 상황(타임아웃, 연결은 됐는데 본문이 끊김, 애매한
 * 상태의 응답, ok:true인데 필수 필드 누락)에서 4(확실히 발행 안 됨)와 구분해
 * 에이전트가 무작정 재시도로 중복 발행을 만들지 않게 한다(스펙 §7.4,
 * 2026-09-26 조율자 결정).
 *
 * `raw`가 있으면 그 안에서 JSON으로 `slug`/`url`/`ownerUrl`을 뽑아 본다 —
 * 뽑히면 발행이 실제로는 성공했을 가능성이 있다는 뜻이라, 그 링크를
 * `unconfirmed: true`로 기록해 둔다(사람이 다시 확인할 수 있게). `list`로
 * 확인하라는 안내는 실제로 뭔가 기록됐을 때만 붙인다.
 */
async function handlePublishUnknown(io: Io, args: ParsedArgs, inputData: unknown, raw?: string): Promise<void> {
  const extracted = raw !== undefined ? tryExtractLinks(raw) : {}
  const canSave = extracted.slug !== undefined && extracted.url !== undefined && extracted.ownerUrl !== undefined

  if (args.json) {
    const body: Record<string, unknown> = {
      ok: false,
      error: { code: 'publish_unknown', message: PUBLISH_UNKNOWN_MESSAGE },
    }
    if (raw !== undefined) body.raw = raw
    io.stdout(`${JSON.stringify(body)}\n`)
  } else {
    io.stderr(`${PUBLISH_UNKNOWN_MESSAGE}\n`)
    if (canSave) {
      io.stderr(`뽑아낸 링크 — url: ${extracted.url}\nownerUrl: ${extracted.ownerUrl}\n`)
    }
    if (raw !== undefined) io.stderr(`원본 응답: ${raw}\n`)
  }

  if (canSave && !args.noSave) {
    const title = isRecord(inputData) && typeof inputData.title === 'string' ? inputData.title : ''
    const kind = isRecord(inputData) && typeof inputData.kind === 'string' ? inputData.kind : ''
    const saveResult = await saveRecord(storeIo(io), {
      slug: extracted.slug as string,
      title,
      kind,
      url: extracted.url as string,
      ownerUrl: extracted.ownerUrl as string,
      api: args.api,
      publishedAt: new Date().toISOString(),
      unconfirmed: true,
    })
    if (saveResult.warning) io.stderr(`${saveResult.warning}\n`)
    else io.stderr('`letsplaytest list`에 "(확인 필요)"로 남겨 뒀어요\n')
  }
}

/** validate(그리고 publish 실패 경로)의 사람용 출력. blocker가 없어도 warning은
 * 보여 준다 — AI가 발행 전에 고칠 여지를 놓치지 않게 한다. */
function printOutcomeHuman(outcome: Outcome, io: Io): void {
  if (outcome.exitCode === 3) {
    io.stderr(`요청이 많아요. ${retryMessage(outcome.retryAfterSeconds)}\n`)
    return
  }
  const body = outcome.json
  if (isRecord(body) && body.ok === false) {
    const blockers = Array.isArray(body.blockers) ? body.blockers : []
    if (blockers.length > 0) {
      io.stdout(`${formatIssues(blockers)}\n`)
      return
    }
    const message = isRecord(body.error) ? String(body.error.message ?? '') : ''
    io.stderr(`${message || '오류가 발생했어요'}\n`)
    return
  }
  if (isRecord(body) && body.ok === true) {
    io.stdout('통과했어요. 발행해도 좋아요\n')
    const warnings = Array.isArray(body.warnings) ? body.warnings : []
    if (warnings.length > 0) {
      io.stdout('경고:\n')
      io.stdout(`${formatIssues(warnings)}\n`)
    }
    return
  }
  io.stderr('서버 응답을 이해할 수 없어요\n')
}

function printJson(outcome: Outcome, io: Io): void {
  io.stdout(`${JSON.stringify(withRetryAfterField(outcome.json, outcome.retryAfterSeconds))}\n`)
}

async function runGuide(args: ParsedArgs, io: Io, ua: string): Promise<number> {
  const result = await fetchGuide(args.api, { kind: args.kind, lang: args.lang, asJson: args.json }, ua)
  if (!result.ok) {
    io.stderr(
      result.failure.kind === 'timeout' ? '서버가 30초 안에 응답하지 않았어요\n' : `서버에 연결할 수 없어요: ${args.api}\n`,
    )
    return 4
  }
  const outcome = decideOutcome(result.response, 'guide')
  if (outcome.exitCode === 0) {
    if (args.json) {
      // --json은 `?format=json`을 요청한 것이므로 응답이 실제로 JSON이어야
      // 한다. 서버가 이걸 무시하고 마크다운(또는 다른 무언가)을 주면 그대로
      // stdout에 흘려보내지 않고 bad_response로 알린다.
      if (outcome.json === undefined) {
        io.stdout(
          `${JSON.stringify({
            ok: false,
            error: {
              code: 'bad_response',
              message: '서버가 JSON 응답을 주지 않았어요(?format=json을 확인해 주세요)',
              status: result.response.status,
            },
          })}\n`,
        )
        return 4
      }
      io.stdout(`${JSON.stringify(outcome.json)}\n`)
      return 0
    }
    const text = result.response.text
    io.stdout(text.endsWith('\n') ? text : `${text}\n`)
    return 0
  }
  if (args.json) printJson(outcome, io)
  else printOutcomeHuman(outcome, io)
  return outcome.exitCode
}

async function runValidate(args: ParsedArgs, io: Io, ua: string): Promise<number> {
  const input = await readInput(args.file as string, io)
  if (!input.ok) {
    io.stderr(`${input.message}\n`)
    return 2
  }
  const data = parseJsonOrUndefined(input.text)
  if (data === undefined) {
    io.stderr('JSON 형식이 아니에요\n')
    return 2
  }
  const result = await postJson(args.api, '/api/v1/tests/validate', data, { lang: args.lang }, ua)
  if (!result.ok) {
    io.stderr(
      result.failure.kind === 'timeout' ? '서버가 30초 안에 응답하지 않았어요\n' : `서버에 연결할 수 없어요: ${args.api}\n`,
    )
    return 4
  }
  const outcome = decideOutcome(result.response, 'contract')
  if (args.json) printJson(outcome, io)
  else printOutcomeHuman(outcome, io)
  return outcome.exitCode
}

async function runPublish(args: ParsedArgs, io: Io, ua: string): Promise<number> {
  const input = await readInput(args.file as string, io)
  if (!input.ok) {
    io.stderr(`${input.message}\n`)
    return 2
  }
  const data = parseJsonOrUndefined(input.text)
  if (data === undefined) {
    io.stderr('JSON 형식이 아니에요\n')
    return 2
  }
  const result = await postJson(args.api, '/api/v1/tests', data, { lang: args.lang }, ua, PUBLISH_TIMEOUT_MS)
  if (!result.ok) {
    // 네트워크 실패는 하나로 뭉뚱그리지 않는다 — ECONNREFUSED류(요청이 정말
    // 안 나감)만 4, 그 밖(타임아웃, 연결은 됐는데 끊김, ECONNRESET류)은
    // "서버에 이미 도달했을 수 있다"는 뜻이라 5다(2026-09-26 조율자 결정,
    // 실제 net/http 서버로 재현해 확정).
    const code = classifyPublishNetworkFailure(result.failure)
    if (code === 4) {
      io.stderr(`서버에 연결할 수 없어요: ${args.api}\n`)
      return 4
    }
    await handlePublishUnknown(io, args, data)
    return 5
  }
  const outcome = decideOutcome(result.response, 'contract')

  if (outcome.exitCode === 0) {
    const body = outcome.json
    const hasRequiredFields =
      isRecord(body) &&
      typeof body.slug === 'string' &&
      typeof body.url === 'string' &&
      typeof body.ownerUrl === 'string'
    if (!hasRequiredFields) {
      // ok: true인데 계약이 요구하는 필드가 없다 — 저장은 됐을 수도 있다
      // (ownerUrl이 깨진 본문 안에 들어 있을 수 있다). "발행 안 됨"인 4가
      // 아니라 "결과 불명"인 5로 알리고, 뽑을 수 있으면 링크를 기록해 둔다.
      await handlePublishUnknown(io, args, data, result.response.text)
      return 5
    }

    if (args.json) printJson(outcome, io)
    else {
      io.stdout(`url: ${body.url}\n`)
      io.stdout(`ownerUrl: ${body.ownerUrl}\n`)
      io.stdout('이 링크는 창작자 전용이에요 — 남에게 보내지 마세요\n')
      const warnings = Array.isArray(body.warnings) ? body.warnings : []
      if (warnings.length > 0) {
        io.stdout('경고:\n')
        io.stdout(`${formatIssues(warnings)}\n`)
      }
    }

    if (!args.noSave) {
      const title = isRecord(data) && typeof data.title === 'string' ? data.title : ''
      const kind = isRecord(data) && typeof data.kind === 'string' ? data.kind : ''
      const saveResult = await saveRecord(storeIo(io), {
        slug: body.slug as string,
        title,
        kind,
        url: body.url as string,
        ownerUrl: body.ownerUrl as string,
        api: args.api,
        publishedAt: new Date().toISOString(),
      })
      if (saveResult.warning) io.stderr(`${saveResult.warning}\n`)
    }
    return 0
  }

  // bad_response(계약과 다른 응답)이면서 상태가 2xx/5xx면 "확실히 실패"가
  // 아니라 5다 — decideOutcome은 이 맥락을 모르므로 여기서 한 번 더 거른다.
  const derived = derivePublishExitCode(outcome, result.response)
  if (derived.exitCode === 5) {
    await handlePublishUnknown(io, args, data, derived.raw)
    return 5
  }

  if (args.json) printJson(outcome, io)
  else printOutcomeHuman(outcome, io)
  return outcome.exitCode
}

async function runList(args: ParsedArgs, io: Io): Promise<number> {
  const { records, warning } = await loadRecords(storeIo(io))
  if (warning) io.stderr(`${warning}\n`)
  const sorted = [...records].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  if (args.json) {
    io.stdout(`${JSON.stringify(sorted)}\n`)
    return 0
  }
  if (sorted.length === 0) {
    io.stdout('아직 발행한 테스트가 없어요. `letsplaytest publish`로 만들어 보세요\n')
    return 0
  }
  for (const record of sorted) {
    const mark = record.unconfirmed ? '  (확인 필요)' : ''
    io.stdout(`${record.publishedAt}  ${record.kind}  ${record.title}  ${record.url}${mark}\n`)
  }
  return 0
}

export async function run(argv: string[], io: Io): Promise<number> {
  const outcome = parseArgs(argv, io.env)

  if (outcome.kind === 'version') {
    io.stdout(`${VERSION}\n`)
    return 0
  }
  if (outcome.kind === 'help') {
    if (outcome.exitCode === 0) io.stdout(HELP_TEXT)
    else io.stderr(HELP_TEXT)
    return outcome.exitCode
  }
  if (outcome.kind === 'error') {
    io.stderr(`${outcome.message}\n`)
    return outcome.exitCode
  }

  const args = outcome.args
  const ua = userAgent(VERSION)

  switch (args.command) {
    case 'guide':
      return runGuide(args, io, ua)
    case 'validate':
      return runValidate(args, io, ua)
    case 'publish':
      return runPublish(args, io, ua)
    case 'list':
      return runList(args, io)
  }
}

function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

/**
 * 실제 `process`에 연결한다. `process.exit()`을 부르지 않는다 — `process.exit`은
 * 아직 flush되지 않은 stdout 버퍼(파이프로 큰 출력을 받을 때 특히)를 자를 수
 * 있다. `process.exitCode`만 설정하고 이벤트 루프가 자연스럽게 비도록 둔다.
 */
export async function main(): Promise<void> {
  const io: Io = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readStdin: () => readStreamToString(process.stdin),
    isStdinTTY: () => Boolean(process.stdin.isTTY),
    env: process.env,
    homedir: () => os.homedir(),
  }
  const code = await run(process.argv.slice(2), io)
  process.exitCode = code
}
