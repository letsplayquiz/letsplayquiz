// 발행 기록 `~/.config/letsplaytest/tests.jsonl` (스펙 §7.3). 웹이 localStorage에
// "내가 만든 테스트"를 남기듯, CLI는 이 파일에 남긴다.
//
// **락을 쓰지 않는다** (2026-09-26 세 번째 리뷰 라운드 후 조율자 결정 — 락을
// 다시 설계할 때마다 새로운 경쟁 조건이 나와서, 아예 락이 필요 없는 모양으로
// 바꿨다). 대신 한 줄에 레코드 하나(JSONL)를 O_APPEND로 이어 붙인다. POSIX에서
// `O_APPEND`로 연 파일에 4096바이트(PIPE_BUF) 이하를 **한 번의 `write()` 호출**로
// 쓰면, 로컬 파일시스템에서 여러 프로세스가 동시에 써도 커널이 파일 끝에서
// 섞이지 않게 보장한다(파일 오프셋을 커널이 원자적으로 갱신) — read→수정→write
// 왕복이 없으니 "먼저 쓴 걸 나중에 쓴 게 덮어쓴다"는 경쟁 자체가 생기지 않는다.
// 그래서 임시 파일·rename·락 파일·`.bak` 백업이 전부 필요 없어졌다.
//
// 기록 저장은 절대 발행 자체를 실패시키지 않는다 — 대시보드 링크는 이미
// 화면에 나왔으므로, 저장이 안 되면 경고만 내고 넘어간다(exit 0). 그래서
// `saveRecord`는 무엇이 잘못되든 던지지 않고 `{ warning }`을 돌려준다.
import { promises as fs, lstatSync, mkdirSync, chmodSync } from 'node:fs'
import path from 'node:path'

export interface TestRecord {
  slug: string
  title: string
  kind: string
  url: string
  ownerUrl: string
  api: string
  publishedAt: string
  /** publish가 종료 코드 5(결과 불명)를 냈지만 원문에서 slug/ownerUrl을 뽑아낼
   * 수 있었을 때만 true. 실제로 발행됐는지 사람이 다시 확인해야 한다는 표시다. */
  unconfirmed?: boolean
}

export interface StoreIo {
  env: NodeJS.ProcessEnv
  homedir: () => string
}

export interface LoadResult {
  records: TestRecord[]
  warning?: string
}

const isWindows = process.platform === 'win32'

export function resolveConfigDir(io: StoreIo): string {
  const xdg = io.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== '' ? xdg : path.join(io.homedir(), '.config')
  return path.join(base, 'letsplaytest')
}

export function resolveStoreFile(io: StoreIo): string {
  return path.join(resolveConfigDir(io), 'tests.jsonl')
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isValidRecord(v: unknown): v is TestRecord {
  return (
    isRecordLike(v) &&
    typeof v.slug === 'string' &&
    typeof v.title === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.url === 'string' &&
    typeof v.ownerUrl === 'string' &&
    typeof v.api === 'string' &&
    typeof v.publishedAt === 'string' &&
    (v.unconfirmed === undefined || typeof v.unconfirmed === 'boolean')
  )
}

/**
 * 심볼릭 링크이거나 다른 사용자 소유면 쓰지 않는다(2026-09-26 Codex 문서 리뷰
 * 반영) — 심볼릭 링크를 따라가 엉뚱한 파일에 덧붙이거나, 다른 사용자가 만들어
 * 둔 파일에 대시보드 링크를 흘리는 걸 막는다. 아직 없는 경로는 안전하다(새로
 * 만들면 된다).
 */
function isUnsafe(target: string): boolean {
  let stat
  try {
    stat = lstatSync(target)
  } catch {
    return false
  }
  if (stat.isSymbolicLink()) return true
  if (!isWindows && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return true
  }
  return false
}

function ensureDir(dir: string): { warning?: string } {
  if (isUnsafe(dir)) {
    return {
      warning: `기록 폴더가 안전하지 않아요(심볼릭 링크이거나 다른 사용자 소유) — 저장을 건너뜁니다: ${dir}`,
    }
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // 이미 있으면(또는 만들 수 없으면) 그대로 둔다 — 쓰기 시도에서 실패가 드러난다.
  }
  try {
    if (!isWindows) chmodSync(dir, 0o700)
  } catch {
    // 최선을 다한다: chmod가 안 되는 파일시스템도 있다.
  }
  return {}
}

/** O_APPEND 원자성이 보장되는 상한(PIPE_BUF, 4096바이트)보다 여유 있게 낮춘 값. */
const MAX_LINE_BYTES = 4000

/**
 * 레코드를 한 줄짜리 JSON으로 만든다. 그대로 4000바이트를 넘으면 `title`을
 * 줄여서라도 맞춘다(제목이 유일하게 길이가 들쭉날쭉한 필드다 — 나머지는 서버가
 * 만든 짧고 고정된 모양의 값이다). 그래도 안 맞으면(예: url 자체가 비정상적으로
 * 김) 포기를 알린다.
 */
function fitLine(record: TestRecord): { line: string; truncated: boolean } | { error: true } {
  const render = (title: string) => `${JSON.stringify({ ...record, title })}\n`

  let line = render(record.title)
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) {
    return { line, truncated: false }
  }

  let title = record.title
  while (title.length > 0) {
    title = title.slice(0, -1)
    line = render(title)
    if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) {
      return { line, truncated: true }
    }
  }

  return { error: true }
}

/**
 * 발행 결과 한 건을 이어 붙인다. 파일이 없으면 만들고(`a` 플래그가 없으면
 * 만든다), 있으면 끝에 한 줄을 더한다. `write()`를 정확히 한 번만 호출해야
 * O_APPEND의 원자성 보장을 받는다(청크로 나눠 쓰면 커널이 두 프로세스의 조각을
 * 섞을 수 있다). 무엇이 잘못되든(권한, 디스크 오류, 줄이 너무 김) 던지지 않고
 * `{ warning }`을 돌려준다 — 발행 자체는 성공으로 둔다(스펙 §7.3).
 */
export async function saveRecord(io: StoreIo, record: TestRecord): Promise<{ warning?: string }> {
  try {
    const dir = resolveConfigDir(io)
    const dirCheck = ensureDir(dir)
    if (dirCheck.warning) return dirCheck

    const file = resolveStoreFile(io)
    if (isUnsafe(file)) {
      return {
        warning: `기록 파일이 안전하지 않아요(심볼릭 링크이거나 다른 사용자 소유) — 저장을 건너뜁니다: ${file}`,
      }
    }

    const fitted = fitLine(record)
    if ('error' in fitted) {
      return {
        warning: `기록 한 줄이 너무 커요(${MAX_LINE_BYTES}바이트 초과) — 저장을 건너뜁니다`,
      }
    }

    const handle = await fs.open(file, 'a', 0o600)
    try {
      // 쓸 때마다 다시 건다 — 이미 있던 파일이 644 같은 느슨한 권한이었을 수
      // 있고, `open`의 mode는 새로 만들 때만 적용된다.
      if (!isWindows) await fs.chmod(file, 0o600).catch(() => {})
      await handle.write(fitted.line)
    } finally {
      await handle.close()
    }
    return {}
  } catch (e) {
    return { warning: `기록을 저장하지 못했어요: ${(e as Error).message}` }
  }
}

export async function loadRecords(io: StoreIo): Promise<LoadResult> {
  const file = resolveStoreFile(io)
  if (isUnsafe(file)) return { records: [] }

  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] }
    return { records: [], warning: `기록 파일을 읽을 수 없어요: ${file}` }
  }

  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  const records: TestRecord[] = []
  let broken = 0
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      broken++
      continue
    }
    if (isValidRecord(parsed)) records.push(parsed)
    else broken++
  }

  return {
    records,
    warning: broken > 0 ? `깨진 기록 ${broken}줄을 건너뛰었어요: ${file}` : undefined,
  }
}
