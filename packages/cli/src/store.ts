// 발행 기록 `~/.config/letsplayquiz/tests.jsonl` (스펙 §7.3). 웹이 localStorage에
// "내가 만든 테스트"를 남기듯, CLI는 이 파일에 남긴다.
//
// **락을 쓰지 않는다** (2026-09-26 세 번째 리뷰 라운드 후 조율자 결정 — 락을
// 다시 설계할 때마다 새로운 경쟁 조건이 나와서, 아예 락이 필요 없는 모양으로
// 바꿨다). 대신 한 줄에 레코드 하나(JSONL)를 O_APPEND로 이어 붙인다.
//
// **O_APPEND의 원자성 근거는 PIPE_BUF가 아니다** — PIPE_BUF(4096바이트)는
// 파이프(`|`)에 대한 POSIX 보장이고, 여기서 쓰는 건 일반 파일이다(2026-09-26
// 네 번째 리뷰에서 지적받아 정정). 일반 파일에서 `O_APPEND` 쓰기가 서로
// 섞이지 않는다는 보장은 각 플랫폼의 실제 구현에서 온다: Linux(ext4 등)는
// 파일 오프셋 갱신과 쓰기를 같은 inode 잠금 아래 원자적으로 처리하고, macOS의
// APFS도 마찬가지이며, Windows는 `FILE_APPEND_DATA` 접근 권한으로 비슷하게
// 보장한다. **NFS 같은 네트워크 파일시스템은 이 보장이 없다** — 이 CLI는
// 로컬 홈 디렉터리(`~/.config`)만 쓰므로 해당하지 않는다고 본다. 한 번의
// `write()` 호출로 여러 프로세스가 동시에 써도 파일 끝에서 섞이지 않으니,
// read→수정→write 왕복이 없어 "먼저 쓴 걸 나중에 쓴 게 덮어쓴다"는 경쟁
// 자체가 생기지 않는다. 그래서 임시 파일·rename·락 파일·`.bak` 백업이 전부
// 필요 없어졌다.
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
  return path.join(base, 'letsplayquiz')
}

export function resolveStoreFile(io: StoreIo): string {
  return path.join(resolveConfigDir(io), 'tests.jsonl')
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// 알 수 없는 추가 필드(예전 버전이 남긴 `unconfirmed` 등)는 일부러 검사하지
// 않는다 — 여기 적힌 필드들만 맞으면 통과시켜서, 스키마가 조금 바뀌어도
// 예전 기록이 "깨진 줄"로 취급되지 않게 한다.
function isValidRecord(v: unknown): v is TestRecord {
  return (
    isRecordLike(v) &&
    typeof v.slug === 'string' &&
    typeof v.title === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.url === 'string' &&
    typeof v.ownerUrl === 'string' &&
    typeof v.api === 'string' &&
    typeof v.publishedAt === 'string'
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

/** 여러 프로세스가 동시에 쓰다 보면 한쪽이 파일 끝에 개행 없이 멈춰 있을 수
 * 있다(수동 편집, 예전 버전의 short write 등). 그 상태에서 다음 레코드를 바로
 * 이어 붙이면 두 줄이 한 줄로 뭉쳐 **둘 다** 깨진 줄이 된다 — 그래서 앞에도
 * 개행을 하나 붙인다(2026-09-26 네 번째 리뷰, spec·code 리뷰 공통 지적).
 * 빈 줄은 `loadRecords`가 이미 건너뛰므로 안전하다. 한도(4000바이트)는 앞뒤
 * 개행을 포함해서 잰다. */
const MAX_LINE_BYTES = 4000
/** 줄이 한도를 넘겨 title을 줄여야 할 때, 한 글자씩 지우는 루프가 오래
 * 걸리지 않도록 먼저 이 길이로 잘라 놓는다(2026-09-26 네 번째 리뷰) — 정상
 * 제목은 서버 상한(60자)보다 훨씬 짧으니 이 루프를 타는 건 예외적인 경우
 * (예: 결과 불명 응답에서 뽑아낸 값)뿐이고, 그런 값이 수십만~수백만 자라도
 * 이 루프는 최대 200번만 돈다. */
const TITLE_PRETRIM_CHARS = 200

/**
 * 레코드를 한 줄짜리 JSON으로 만든다(앞뒤 개행 포함). 그대로 4000바이트를
 * 넘으면 `title`을 줄여서라도 맞춘다(제목이 유일하게 길이가 들쭉날쭉한
 * 필드다 — 나머지는 서버가 만든 짧고 고정된 모양의 값이다). 그래도 안
 * 맞으면(예: url 자체가 비정상적으로 김) 포기를 알린다.
 */
function fitLine(record: TestRecord): { line: string; truncated: boolean } | { error: true } {
  const render = (title: string) => `\n${JSON.stringify({ ...record, title })}\n`

  let line = render(record.title)
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) {
    return { line, truncated: false }
  }

  let title = record.title.length > TITLE_PRETRIM_CHARS ? record.title.slice(0, TITLE_PRETRIM_CHARS) : record.title
  line = render(title)
  while (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES && title.length > 0) {
    title = title.slice(0, -1)
    line = render(title)
  }

  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) {
    return { line, truncated: true }
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
    let bytesWritten = 0
    try {
      // 쓸 때마다 다시 건다 — 이미 있던 파일이 644 같은 느슨한 권한이었을 수
      // 있고, `open`의 mode는 새로 만들 때만 적용된다.
      if (!isWindows) await fs.chmod(file, 0o600).catch(() => {})
      ;({ bytesWritten } = await handle.write(fitted.line))
    } finally {
      await handle.close()
    }
    const expectedBytes = Buffer.byteLength(fitted.line, 'utf8')
    if (bytesWritten !== expectedBytes) {
      // 디스크가 꽉 찼거나(ENOSPC 직전) 그 밖의 이유로 일부만 쓰였다 —
      // O_APPEND의 원자성 보장은 "한 번의 write() 호출"을 전제로 하는데, 이미
      // 절반만 나간 뒤라 되돌릴 수 없다. 다음 레코드가 이 줄에 이어 붙는 걸
      // 앞 개행이 막아 주지만, 이번 줄 자체는 깨졌을 수 있다는 걸 알린다.
      return {
        warning: `기록 쓰기가 일부만 됐어요(${bytesWritten}/${expectedBytes}바이트) — 이번 줄이 깨졌을 수 있어요: ${file}`,
      }
    }
    return {}
  } catch (e) {
    return { warning: `기록을 저장하지 못했어요: ${(e as Error).message}` }
  }
}

export async function loadRecords(io: StoreIo): Promise<LoadResult> {
  const dir = resolveConfigDir(io)
  if (isUnsafe(dir)) {
    return {
      records: [],
      warning: `기록 폴더가 안전하지 않아요(심볼릭 링크이거나 다른 사용자 소유): ${dir}`,
    }
  }

  const file = resolveStoreFile(io)
  if (isUnsafe(file)) {
    return {
      records: [],
      warning: `기록 파일이 안전하지 않아요(심볼릭 링크이거나 다른 사용자 소유): ${file}`,
    }
  }

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
