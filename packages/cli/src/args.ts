// argv 파싱. node:util의 parseArgs만 쓰고 의존성을 더하지 않는다(스펙 §7.1).
// 명령별 필수값(validate/publish의 파일 인자)과 옵션값(--kind, --lang, --api)의
// 허용 범위는 여기서 확정한다 — 서버까지 보내지 않고 로컬에서 걸러 종료 코드
// 2를 낸다.
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
  --api <url>     서버 주소. https만 허용(로컬 개발은 http://localhost, http://127.0.0.1 예외).
                  기본값: ${DEFAULT_API}, 환경변수 LETSPLAYTEST_API로도 설정 가능
  --no-save       publish 결과를 ~/.config/letsplaytest/tests.jsonl(XDG_CONFIG_HOME이 있으면 그 아래)에 남기지 않음
  --help          도움말 출력
  --version       버전 출력
`

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * `--api`는 https만 허용한다 — 대시보드 링크(`ownerUrl`)가 평문 http로 오가면
 * 그 자리에서 가로챌 수 있다. 로컬 개발 서버(`http://localhost:3000`)는 예외로
 * 둔다. `new URL('http://[::1]:3000').hostname`은 대괄호를 포함해 `'[::1]'`을
 * 돌려준다(다른 호스트명과 달리 IPv6 리터럴은 대괄호가 hostname의 일부다) —
 * 그래서 목록도 대괄호를 포함한 값으로 둔다.
 */
function validateApi(raw: string): { ok: true } | { ok: false; message: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: `--api 값이 올바른 URL이 아니에요: ${raw}` }
  }
  if (url.protocol === 'https:') return { ok: true }
  if (url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)) return { ok: true }
  return {
    ok: false,
    message: `--api는 https만 허용해요(로컬 http://localhost, http://127.0.0.1 예외): ${raw}`,
  }
}

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

  if (parsed.positionals.length > 2) {
    return { kind: 'error', message: '위치 인자는 명령과 파일 하나뿐이에요', exitCode: 2 }
  }

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
  // list는 서버를 부르지 않는다(§7.2) — 잘못 설정된 LETSPLAYTEST_API 하나 때문에
  // 로컬 기록 조회까지 막히지 않게 이 명령만 --api 검증을 건너뛴다.
  if (command !== 'list') {
    const apiCheck = validateApi(api)
    if (!apiCheck.ok) return { kind: 'error', message: apiCheck.message, exitCode: 2 }
  }

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
