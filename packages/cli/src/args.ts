// argv 파싱. node:util의 parseArgs만 쓰고 의존성을 더하지 않는다(스펙 §7.1).
// 명령별 필수값(validate/publish의 파일 인자)과 옵션값(--kind, --lang)의 허용
// 범위는 여기서 확정한다 — 서버까지 보내지 않고 로컬에서 걸러 종료 코드 2를 낸다.
import { parseArgs as nodeParseArgs } from 'node:util'

export const KINDS = ['score', 'type', 'balance', 'worldcup'] as const
export type Kind = (typeof KINDS)[number]

export const LANGS = ['ko', 'ja', 'en'] as const
export type Lang = (typeof LANGS)[number]

export const DEFAULT_API = 'https://letsplaytest.com'

export type Command = 'guide' | 'validate' | 'publish' | 'list'

export const COMMANDS: Command[] = ['guide', 'validate', 'publish', 'list']

export interface ParsedArgs {
  command: Command
  file?: string
  kind?: Kind
  json: boolean
  lang?: Lang
  api: string
  noSave: boolean
}

export type ParseOutcome =
  | { kind: 'run'; args: ParsedArgs }
  | { kind: 'help'; exitCode: 0 | 2 }
  | { kind: 'version' }
  | { kind: 'error'; message: string; exitCode: 2 }

export const HELP_TEXT = `letsplaytest — AI 에이전트로 PlayTest 테스트를 만들고 발행하는 CLI

사용법:
  letsplaytest guide [--kind score|type|balance|worldcup]
  letsplaytest validate <file | ->
  letsplaytest publish  <file | ->
  letsplaytest list

공통 옵션:
  --json          서버 응답(또는 list의 기록)을 그대로 출력
  --lang ko|ja|en 서버 메시지 언어(쿼리 lang)
  --api <url>     서버 주소 (기본값: ${DEFAULT_API}, 환경변수 LETSPLAYTEST_API로도 설정 가능)
  --no-save       publish 결과를 ~/.config/letsplaytest/tests.json에 남기지 않음
  --help          도움말 출력
  --version       버전 출력
`

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParseOutcome {
  let parsed: ReturnType<typeof nodeParseArgs>
  try {
    parsed = nodeParseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        kind: { type: 'string' },
        json: { type: 'boolean', default: false },
        lang: { type: 'string' },
        api: { type: 'string' },
        'no-save': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    })
  } catch (e) {
    return { kind: 'error', message: (e as Error).message, exitCode: 2 }
  }

  if (parsed.values.version) return { kind: 'version' }
  if (parsed.values.help) return { kind: 'help', exitCode: 0 }

  const [command, file] = parsed.positionals
  if (!command) return { kind: 'help', exitCode: 2 }

  if (!COMMANDS.includes(command as Command)) {
    return { kind: 'error', message: `모르는 명령이에요: ${command}`, exitCode: 2 }
  }

  if ((command === 'validate' || command === 'publish') && !file) {
    return {
      kind: 'error',
      message: `${command} 명령에는 파일 경로나 -(표준 입력)가 필요해요`,
      exitCode: 2,
    }
  }

  let kind: Kind | undefined
  if (parsed.values.kind !== undefined) {
    if (!KINDS.includes(parsed.values.kind as Kind)) {
      return { kind: 'error', message: `모르는 --kind 값이에요: ${parsed.values.kind}`, exitCode: 2 }
    }
    kind = parsed.values.kind as Kind
  }

  let lang: Lang | undefined
  if (parsed.values.lang !== undefined) {
    if (!LANGS.includes(parsed.values.lang as Lang)) {
      return { kind: 'error', message: `모르는 --lang 값이에요: ${parsed.values.lang}`, exitCode: 2 }
    }
    lang = parsed.values.lang as Lang
  }

  const api = (parsed.values.api as string | undefined) || env.LETSPLAYTEST_API || DEFAULT_API

  return {
    kind: 'run',
    args: {
      command: command as Command,
      file,
      kind,
      json: Boolean(parsed.values.json),
      lang,
      api,
      noSave: Boolean(parsed.values['no-save']),
    },
  }
}
