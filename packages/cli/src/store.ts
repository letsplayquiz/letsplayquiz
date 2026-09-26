// 발행 기록 `~/.config/letsplaytest/tests.json` (스펙 §7.3). 웹이 localStorage에
// "내가 만든 테스트"를 남기듯, CLI는 이 파일에 남긴다. 같은 컴퓨터의 다른
// 사용자가 못 읽게 디렉터리 700 · 파일 600을 쓸 때마다 다시 건다 — `mkdir`의
// `mode`는 이미 있는 디렉터리의 권한을 고치지 않기 때문이다. 쓰기는 같은
// 디렉터리의 임시 파일에 먼저 쓰고 `rename`으로 바꿔치는 원자적 교체다.
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

const isWindows = process.platform === 'win32'

export function resolveConfigDir(io: StoreIo): string {
  const xdg = io.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== '' ? xdg : path.join(io.homedir(), '.config')
  return path.join(base, 'letsplaytest')
}

export function resolveStoreFile(io: StoreIo): string {
  return path.join(resolveConfigDir(io), 'tests.json')
}

/**
 * 심볼릭 링크이거나 다른 사용자 소유면 쓰지 않는다(2026-09-26 Codex 문서 리뷰
 * 반영) — 심볼릭 링크를 따라가 엉뚱한 파일을 덮어쓰거나, 다른 사용자가 만들어
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
    // 이미 있으면 그대로 둔다 — 아래 chmod가 권한을 맞춘다.
  }
  try {
    if (!isWindows) chmodSync(dir, 0o700)
  } catch {
    // 최선을 다한다: chmod가 안 되는 파일시스템도 있다.
  }
  return {}
}

/**
 * 발행 결과 한 건을 기록한다. 기록에 실패해도 발행 자체는 성공으로 둔다 —
 * 대시보드 링크는 이미 화면에 나왔다(스펙 §7.3).
 */
export async function saveRecord(io: StoreIo, record: TestRecord): Promise<{ warning?: string }> {
  const dir = resolveConfigDir(io)
  const dirCheck = ensureDir(dir)
  if (dirCheck.warning) return dirCheck

  const file = resolveStoreFile(io)
  if (isUnsafe(file)) {
    return {
      warning: `기록 파일이 안전하지 않아요(심볼릭 링크이거나 다른 사용자 소유) — 저장을 건너뜁니다: ${file}`,
    }
  }

  let records: TestRecord[] = []
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('tests.json이 배열이 아니에요')
    records = parsed as TestRecord[]
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // 손상된 파일 — 백업하고 새로 시작한다.
      try {
        await fs.rename(file, `${file}.bak`)
      } catch {
        // 백업조차 안 되면 그냥 덮어쓴다.
      }
    }
    records = []
  }

  records.push(record)

  const tmp = path.join(dir, `.tests.json.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
  try {
    if (!isWindows) {
      await fs.chmod(file, 0o600)
      await fs.chmod(dir, 0o700)
    }
  } catch {
    // 최선을 다한다.
  }
  return {}
}

export async function loadRecords(io: StoreIo): Promise<TestRecord[]> {
  const file = resolveStoreFile(io)
  if (isUnsafe(file)) return []
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TestRecord[]) : []
  } catch {
    return []
  }
}
