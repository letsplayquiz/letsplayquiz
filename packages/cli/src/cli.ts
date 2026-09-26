#!/usr/bin/env node
// letsplaytest CLI 본체. `run(argv, io)`가 핵심이고, 파일 맨 아래의 `main()`은
// 이걸 실제 `process`에 연결하는 얇은 wrapper다(테스트는 `run`만 직접 부른다 —
// process를 건드리지 않고 종료 코드를 검사할 수 있다).
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'

import { parseArgs, HELP_TEXT, type ParsedArgs } from './args.js'
import { fetchGuide, postJson, decideOutcome, isRecord, userAgent, type Outcome } from './api.js'
import { formatIssues, type Issue } from './format.js'
import { saveRecord, loadRecords, type StoreIo } from './store.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }
export const VERSION = pkg.version

export interface Io {
  stdout: (s: string) => void
  stderr: (s: string) => void
  readStdin: () => Promise<string>
  env: NodeJS.ProcessEnv
  homedir: () => string
}

function storeIo(io: Io): StoreIo {
  return { env: io.env, homedir: io.homedir }
}

async function readInput(
  file: string,
  io: Io,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (file === '-') {
    try {
      const text = await io.readStdin()
      return { ok: true, text }
    } catch (e) {
      return { ok: false, message: `표준 입력을 읽을 수 없어요: ${(e as Error).message}` }
    }
  }
  try {
    const text = await fsPromises.readFile(file, 'utf8')
    return { ok: true, text }
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

function printOutcomeHuman(outcome: Outcome, io: Io): void {
  if (outcome.exitCode === 3) {
    const seconds = outcome.retryAfterSeconds ?? '잠시'
    io.stderr(`요청이 많아요. ${seconds}초 후 다시 시도해 주세요\n`)
    return
  }
  const body = outcome.json
  if (isRecord(body) && Array.isArray(body.blockers) && body.blockers.length > 0) {
    io.stdout(formatIssues(body.blockers as Issue[]) + '\n')
    return
  }
  if (isRecord(body) && body.ok === false) {
    const message = isRecord(body.error) ? String(body.error.message ?? '') : '오류가 발생했어요'
    io.stderr((message || '오류가 발생했어요') + '\n')
    return
  }
  if (isRecord(body) && body.ok === true) {
    io.stdout('통과했어요. 발행해도 좋아요\n')
    return
  }
  io.stderr('서버 응답을 이해할 수 없어요\n')
}

async function runGuide(args: ParsedArgs, io: Io, ua: string): Promise<number> {
  const result = await fetchGuide(args.api, { kind: args.kind, lang: args.lang, asJson: args.json }, ua)
  if (!result.ok) {
    io.stderr(`서버에 연결할 수 없어요: ${args.api}\n`)
    return 4
  }
  const outcome = decideOutcome(result.response)
  if (outcome.exitCode === 0) {
    const text = result.response.text
    io.stdout(text.endsWith('\n') ? text : `${text}\n`)
    return 0
  }
  if (args.json) io.stdout(`${JSON.stringify(outcome.json)}\n`)
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
    io.stderr(`서버에 연결할 수 없어요: ${args.api}\n`)
    return 4
  }
  const outcome = decideOutcome(result.response)
  if (args.json) io.stdout(`${JSON.stringify(outcome.json)}\n`)
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
  const result = await postJson(args.api, '/api/v1/tests', data, { lang: args.lang }, ua)
  if (!result.ok) {
    io.stderr(`서버에 연결할 수 없어요: ${args.api}\n`)
    return 4
  }
  const outcome = decideOutcome(result.response)

  if (args.json) io.stdout(`${JSON.stringify(outcome.json)}\n`)

  if (outcome.exitCode === 0 && isRecord(outcome.json)) {
    const body = outcome.json as {
      slug?: string
      url?: string
      ownerUrl?: string
      warnings?: Issue[]
    }
    if (!args.json) {
      io.stdout(`url: ${body.url}\n`)
      io.stdout(`ownerUrl: ${body.ownerUrl}\n`)
      io.stdout('이 링크는 창작자 전용이에요 — 남에게 보내지 마세요\n')
      if (Array.isArray(body.warnings) && body.warnings.length > 0) {
        io.stdout(`${formatIssues(body.warnings)}\n`)
      }
    }
    if (!args.noSave && body.slug && body.url && body.ownerUrl) {
      const title = isRecord(data) && typeof data.title === 'string' ? data.title : ''
      const kind = isRecord(data) && typeof data.kind === 'string' ? data.kind : ''
      const saveResult = await saveRecord(storeIo(io), {
        slug: body.slug,
        title,
        kind,
        url: body.url,
        ownerUrl: body.ownerUrl,
        api: args.api,
        publishedAt: new Date().toISOString(),
      })
      if (saveResult.warning) io.stderr(`${saveResult.warning}\n`)
    }
    return 0
  }

  if (!args.json) printOutcomeHuman(outcome, io)
  return outcome.exitCode
}

async function runList(args: ParsedArgs, io: Io): Promise<number> {
  const records = await loadRecords(storeIo(io))
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
    io.stdout(`${record.publishedAt}  ${record.kind}  ${record.title}  ${record.url}\n`)
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

async function main(): Promise<void> {
  const io: Io = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readStdin: () => readStreamToString(process.stdin),
    env: process.env,
    homedir: () => os.homedir(),
  }
  const code = await run(process.argv.slice(2), io)
  process.exit(code)
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  main().catch((e) => {
    console.error(e)
    process.exit(4)
  })
}
