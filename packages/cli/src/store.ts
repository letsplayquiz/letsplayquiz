// 발행 기록 `~/.config/letsplaytest/tests.json` (스펙 §7.3). 웹이 localStorage에
// "내가 만든 테스트"를 남기듯, CLI는 이 파일에 남긴다. 같은 컴퓨터의 다른
// 사용자가 못 읽게 디렉터리 700 · 파일 600을 쓸 때마다 다시 건다 — `mkdir`의
// `mode`는 이미 있는 디렉터리의 권한을 고치지 않기 때문이다. 쓰기는 같은
// 디렉터리의 임시 파일에 먼저 쓰고 `rename`으로 바꿔치는 원자적 교체다.
//
// 기록 저장은 절대 발행 자체를 실패시키지 않는다 — 대시보드 링크는 이미
// 화면에 나왔으므로, 저장이 안 되면 경고만 내고 넘어간다(exit 0). 그래서
// `saveRecord`는 무엇이 잘못되든 던지지 않고 `{ warning }`을 돌려준다.
import { promises as fs, lstatSync, mkdirSync, chmodSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
  return path.join(base, 'letsplaytest')
}

export function resolveStoreFile(io: StoreIo): string {
  return path.join(resolveConfigDir(io), 'tests.json')
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
    typeof v.publishedAt === 'string'
  )
}

/**
 * 심볼릭 링크이거나 다른 사용자 소유면 쓰지 않는다(2026-09-26 Codex 문서 리뷰
 * 반영) — 심볼릭 링크를 따라가 엉뚱한 파일을 덮어쓰거나, 다른 사용자가 만들어
 * 둔 파일에 대시보드 링크를 흘리는 걸 막는다. 아직 없는 경로는 안전하다(새로
 * 만들면 된다). `rename`은 링크를 따라가지 않고 대상 자체를 바꿔치므로(실측
 * 확인됨) TOCTOU 경쟁은 없다 — 이 검사는 "이미 심볼릭 링크로 만들어 둔 경로에
 * 아예 손대지 않기 위한" 정책적 방어다.
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

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_TOTAL_MS = 2_000
const LOCK_RETRY_INTERVAL_MS = 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface LockInfo {
  pid: number
  token: string
  createdAt: number
}

function isLockInfo(v: unknown): v is LockInfo {
  return (
    isRecordLike(v) &&
    typeof v.pid === 'number' &&
    typeof v.token === 'string' &&
    typeof v.createdAt === 'number'
  )
}

async function readLockInfo(lockFile: string): Promise<LockInfo | undefined> {
  try {
    const raw = await fs.readFile(lockFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isLockInfo(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * `pid`가 아직 살아 있는지 본다(신호 0은 아무 것도 보내지 않고 존재만 확인한다 —
 * Windows에서도 동작한다). `ESRCH`(그런 프로세스 없음)만 "죽었다"로 본다.
 * `EPERM`(다른 사용자 소유라 신호를 못 보냄)이나 그 밖의 오류는 "살아 있을 수도
 * 있다"로 보수적으로 판단한다 — 살아 있는 프로세스의 락을 빼앗는 것보다, 죽은
 * 락을 조금 늦게 치우는 쪽이 훨씬 안전하다.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

interface LockHandle {
  release: () => Promise<void>
  /** tests.json을 쓰기 직전에 부른다 — 그 사이 다른 프로세스가 이 락을 "죽은
   * 프로세스의 오래된 락"으로 오판해 치우고 자기 락을 잡았을 수 있다. */
  verifyOwnership: () => Promise<boolean>
}

type AcquireResult = { ok: true; lock: LockHandle } | { ok: false; reason?: string }

/**
 * 동시에 여러 `publish`가 같은 tests.json을 read→push→write하면 나중에 쓴 쪽이
 * 먼저 쓴 기록을 덮어써 잃어버린다. `open(path, 'wx')`는 파일이 이미 있으면
 * 원자적으로 실패하는 걸 이용해 락으로 쓴다.
 *
 * 락 파일에는 `{ pid, token, createdAt }`을 적는다. "오래된 락"은 30초를
 * 넘겼다는 것만으로는 안 지운다 — 그 pid가 실제로 죽었을 때만(`isProcessAlive`)
 * 지운다. 지우기 직전에 파일을 다시 읽어 토큰이 처음 본 것과 같을 때만
 * unlink한다 — 그 사이 다른 프로세스가 이미 지우고 자기 락을 새로 잡았다면
 * 토큰이 달라져 있으므로 건드리지 않는다(동시에 두 프로세스가 같은 오래된
 * 락을 발견해도 서로의 새 락을 지우지 않는다).
 *
 * 모든 재시도 경로는 **호출자가 정한 `deadline`을 반드시 거쳐서** 다음 시도로
 * 넘어간다 — 예전 버전은 "오래된 락을 지웠다"는 이유로 `continue`해 데드라인
 * 검사를 건너뛸 수 있었고, unlink가 계속 실패하는 상황(락이 디렉터리이거나
 * 권한이 없는 경우)에서 무한 루프가 됐다.
 */
async function acquireLock(dir: string, deadline: number): Promise<AcquireResult> {
  const lockFile = path.join(dir, 'tests.json.lock')

  // 락 경로가 이미 파일이 아닌 무언가(디렉터리 등)로 막혀 있으면 재시도해도
  // 나아지지 않는다 — 곧장 포기한다.
  try {
    const stat = await fs.lstat(lockFile)
    if (!stat.isFile()) {
      return { ok: false, reason: `기록 락 경로가 파일이 아니에요(저장을 건너뜁니다): ${lockFile}` }
    }
  } catch {
    // 없으면 문제 없다 — 아래에서 만든다.
  }

  for (;;) {
    const token = crypto.randomBytes(16).toString('hex')
    try {
      const handle = await fs.open(lockFile, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() } satisfies LockInfo))
      } finally {
        await handle.close()
      }
      return {
        ok: true,
        lock: {
          release: async () => {
            const current = await readLockInfo(lockFile)
            if (current && current.token === token) {
              await fs.unlink(lockFile).catch(() => {})
            }
          },
          verifyOwnership: async () => {
            const current = await readLockInfo(lockFile)
            return current !== undefined && current.token === token
          },
        },
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException

      if (err.code !== 'EEXIST') {
        return {
          ok: false,
          reason: `기록 폴더를 만들거나 쓸 수 없어요: ${lockFile} (${err.code ?? err.message})`,
        }
      }

      // 락이 있다 — 파일인지, 죽은 프로세스가 남긴 오래된 락인지 본다. 무엇을
      // 하든(지웠든, 못 지웠든, 그대로 두든) 아래 데드라인 검사를 반드시 거친다.
      let stat
      try {
        stat = await fs.lstat(lockFile)
      } catch {
        stat = undefined // 그 사이 사라졌다 — 데드라인만 보고 다시 시도한다.
      }

      if (stat && !stat.isFile()) {
        return { ok: false, reason: `기록 락 경로가 파일이 아니에요(저장을 건너뜁니다): ${lockFile}` }
      }

      if (stat) {
        const info = await readLockInfo(lockFile)
        const age = Date.now() - stat.mtimeMs
        const isStale = age > LOCK_STALE_MS && (info === undefined || !isProcessAlive(info.pid))
        if (isStale) {
          // 지우기 직전에 다시 읽어 같은 락인지 확인한다(동시 정리 방지).
          const recheck = await readLockInfo(lockFile)
          const stillSame = info === undefined ? recheck === undefined : recheck?.token === info.token
          if (stillSame) {
            await fs.unlink(lockFile).catch(() => {})
          }
        }
      }

      if (Date.now() > deadline) {
        return { ok: false, reason: '기록 파일이 다른 프로세스에서 쓰이고 있어요 — 이번엔 저장을 건너뜁니다' }
      }
      await sleep(LOCK_RETRY_INTERVAL_MS)
    }
  }
}

/**
 * 발행 결과 한 건을 기록한다. 무엇이 잘못되든(권한, 락, 디스크 오류) 던지지
 * 않고 `{ warning }`을 돌려준다 — 발행 자체는 성공으로 둔다(스펙 §7.3).
 */
export async function saveRecord(io: StoreIo, record: TestRecord): Promise<{ warning?: string }> {
  let lockRelease: (() => Promise<void>) | undefined
  let tmpFile: string | undefined
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

    const lockResult = await acquireLock(dir, Date.now() + LOCK_RETRY_TOTAL_MS)
    if (!lockResult.ok) {
      return { warning: lockResult.reason ?? '기록 파일이 다른 프로세스에서 쓰이고 있어요 — 이번엔 저장을 건너뜁니다' }
    }
    lockRelease = lockResult.lock.release

    let records: TestRecord[] = []
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('NOT_ARRAY')
      records = parsed as TestRecord[]
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        records = []
      } else if (err.code) {
        // 손상이 아니라 권한 같은 다른 문제 — 함부로 덮어쓰지 않는다.
        return { warning: `기록 파일을 읽을 수 없어요 — 저장을 건너뜁니다: ${file}` }
      } else {
        // JSON 파싱 실패 또는 배열이 아님 — 손상됐다고 보고 백업한다.
        const backup = `${file}.bak.${Date.now()}`
        try {
          await fs.rename(file, backup)
          if (!isWindows) await fs.chmod(backup, 0o600)
        } catch {
          // 백업이 안 되면 그냥 새로 쓴다 — 저장 자체를 포기하지 않는다.
        }
        records = []
      }
    }

    records.push(record)

    // 다른 프로세스가 그 사이 이 락을 "죽은 프로세스의 오래된 락"으로 오판해
    // 치우고 자기 락을 잡았을 수 있다 — 쓰기 직전에 다시 확인한다.
    if (!(await lockResult.lock.verifyOwnership())) {
      return { warning: '기록 락을 잃어버려서 저장을 건너뜁니다(다른 프로세스와 겹쳤을 수 있어요)' }
    }

    tmpFile = path.join(dir, `.tests.json.${process.pid}.${Date.now()}.tmp`)
    await fs.writeFile(tmpFile, JSON.stringify(records, null, 2), { mode: 0o600 })
    await fs.rename(tmpFile, file)
    tmpFile = undefined
    try {
      if (!isWindows) {
        await fs.chmod(file, 0o600)
        await fs.chmod(dir, 0o700)
      }
    } catch {
      // 최선을 다한다.
    }
    return {}
  } catch (e) {
    return { warning: `기록을 저장하지 못했어요: ${(e as Error).message}` }
  } finally {
    if (tmpFile) await fs.unlink(tmpFile).catch(() => {})
    if (lockRelease) await lockRelease()
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

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { records: [], warning: `기록 파일이 손상됐어요: ${file}` }
  }
  if (!Array.isArray(parsed)) {
    return { records: [], warning: `기록 파일이 손상됐어요: ${file}` }
  }

  // 항목 하나가 깨져 있어도(§12) 나머지는 보여 준다.
  return { records: parsed.filter(isValidRecord) }
}
