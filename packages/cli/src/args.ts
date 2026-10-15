// argv 파싱. node:util의 parseArgs만 쓰고 의존성을 더하지 않는다(스펙 §7.1).
// 명령별 필수값(validate/publish의 파일 인자)과 옵션값(--kind, --lang, --api)의
// 허용 범위는 여기서 확정한다 — 서버까지 보내지 않고 로컬에서 걸러 종료 코드
// 2를 낸다.
import { parseArgs as nodeParseArgs } from 'node:util'

/** 지금 서버가 아는 종류들(도움말·문서의 예시). CLI는 이 목록으로 입력을 막지 않는다 —
 * 서버에 새 종류가 생겨도 옛 버전 CLI가 쓸 수 있게, 모르는 종류는 모양만 확인하고
 * 서버로 넘겨 서버의 400을 그대로 보여 준다("서버가 모든 규칙을 갖는다"). */
export const KINDS = ['score', 'type', 'balance', 'worldcup', 'level'] as const
export type Kind = (typeof KINDS)[number]

/** 종류 이름의 모양: 소문자 영문·숫자·_ 1~20자(서버의 키 규칙과 같다). 쿼리에 그대로 실려
 * 나가므로 이 모양이 아니면 로컬에서 거절한다. */
export const KIND_PATTERN = /^[a-z0-9_]{1,20}$/

export const LANGS = ['ko', 'ja', 'en'] as const
export type Lang = (typeof LANGS)[number]

export const DEFAULT_API = 'https://letsplayquiz.net'

export type Command = 'guide' | 'validate' | 'publish' | 'list'

export const COMMANDS: Command[] = ['guide', 'validate', 'publish', 'list']

export interface ParsedArgs {
  command: Command
  file?: string
  kind?: string
  json: boolean
  lang?: Lang
  api: string
  noSave: boolean
  /** list에서 ownerUrl(창작자 전용 비밀 링크)도 보여 줄지. 기본 false. */
  showOwner: boolean
}

export type ParseOutcome =
  | { kind: 'run'; args: ParsedArgs }
  | { kind: 'help'; exitCode: 0 | 2 }
  | { kind: 'version' }
  | { kind: 'error'; message: string; exitCode: 2 }

export const HELP_TEXT = `letsplayquiz — AI 에이전트로 LetsPlayQuiz 퀴즈를 만들고 발행하는 CLI

사용법:
  letsplayquiz guide [--kind score|type|balance|worldcup|level]
  letsplayquiz validate <file | ->
  letsplayquiz publish  <file | ->
  letsplayquiz list

공통 옵션:
  --kind <종류>   guide에서 볼 종류. 예: score|type|balance|worldcup|level (그 밖의 이름은 서버로 그대로 보내 서버가 판단)
  --json          서버 응답(또는 list의 기록)을 그대로 출력. list는 ownerUrl을 뺌(--show-owner로 넣음)
  --lang ko|ja|en 서버 메시지 언어(쿼리 lang)
  --api <url>     서버 주소. https만 허용(로컬 개발은 http://localhost, http://127.0.0.1 예외).
                  기본값: ${DEFAULT_API}, 환경변수 LETSPLAYQUIZ_API로도 설정 가능
  --show-owner    list에서 ownerUrl(창작자 전용 대시보드 링크, 비밀)도 보여 줌
  --no-save       publish 결과를 ~/.config/letsplayquiz/tests.jsonl(절대 경로인 XDG_CONFIG_HOME이 있으면 그 아래)에 남기지 않음
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
export function validateApi(raw: string): { ok: true } | { ok: false; message: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: `--api 값이 올바른 URL이 아니에요: ${raw}` }
  }
  // user:pass@host는 자격 증명이 로그·URL에 새기 쉬워 막는다.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, message: '--api에는 사용자 이름·비밀번호(user:pass@)를 넣을 수 없어요' }
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
        'show-owner': { type: 'boolean', default: false },
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

  let kind: string | undefined
  if (parsed.values.kind !== undefined) {
    const rawKind = parsed.values.kind as string
    if (!KIND_PATTERN.test(rawKind)) {
      return {
        kind: 'error',
        message: `--kind 값 모양이 올바르지 않아요(소문자 영문·숫자·_ 1~20자): ${rawKind}`,
        exitCode: 2,
      }
    }
    kind = rawKind
  }

  let lang: Lang | undefined
  if (parsed.values.lang !== undefined) {
    if (!LANGS.includes(parsed.values.lang as Lang)) {
      return { kind: 'error', message: `모르는 --lang 값이에요: ${parsed.values.lang}`, exitCode: 2 }
    }
    lang = parsed.values.lang as Lang
  }

  const api = (parsed.values.api as string | undefined) || env.LETSPLAYQUIZ_API || DEFAULT_API
  // list는 서버를 부르지 않는다(§7.2) — 잘못 설정된 LETSPLAYQUIZ_API 하나 때문에
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
      showOwner: Boolean(parsed.values['show-owner']),
    },
  }
}
