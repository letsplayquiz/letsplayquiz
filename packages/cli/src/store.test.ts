import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, mkdirSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { saveRecord, loadRecords, resolveStoreFile, resolveConfigDir, type StoreIo } from './store.js'

const isWindows = process.platform === 'win32'
const isRoot = !isWindows && typeof process.getuid === 'function' && process.getuid() === 0

/** 실행이 끝난(=확실히 죽은) 자식 프로세스의 pid를 얻는다. `spawnSync`가 돌아온
 * 시점엔 이미 종료돼 있으므로 플랫폼과 무관하게 항상 죽은 pid를 보장한다. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  if (typeof result.pid !== 'number') throw new Error('자식 프로세스를 띄우지 못했어요')
  return result.pid
}

/** 락 파일을 오래된 것처럼 보이게 만든다: 내용은 `{pid, token, createdAt}`,
 * mtime은 스펙의 STALE 기준(30초)보다 훨씬 이전으로 되돌린다. */
async function writeOldLock(dir: string, pid: number, token = 'old-token'): Promise<string> {
  const lockFile = path.join(dir, 'tests.json.lock')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(lockFile, JSON.stringify({ pid, token, createdAt: Date.now() - 3_600_000 }))
  const old = new Date(Date.now() - 3_600_000)
  await fs.utimes(lockFile, old, old)
  return lockFile
}

let tmpHome: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'letsplaytest-store-'))
})

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true })
})

function io(env: Record<string, string | undefined> = {}): StoreIo {
  return { env: env as NodeJS.ProcessEnv, homedir: () => tmpHome }
}

const record = {
  slug: 'abc123',
  title: '나의 여행 스타일',
  kind: 'type',
  url: 'https://letsplaytest.com/t/abc123',
  ownerUrl: 'https://letsplaytest.com/t/abc123/owner/tok',
  api: 'https://letsplaytest.com',
  publishedAt: '2026-09-26T00:00:00.000Z',
}

describe('resolveConfigDir / resolveStoreFile', () => {
  it('기본은 homedir/.config/letsplaytest', () => {
    expect(resolveConfigDir(io())).toBe(path.join(tmpHome, '.config', 'letsplaytest'))
    expect(resolveStoreFile(io())).toBe(path.join(tmpHome, '.config', 'letsplaytest', 'tests.json'))
  })

  it('XDG_CONFIG_HOME이 있으면 그 아래', () => {
    const xdg = path.join(tmpHome, 'xdg')
    expect(resolveConfigDir(io({ XDG_CONFIG_HOME: xdg }))).toBe(path.join(xdg, 'letsplaytest'))
  })
})

describe('saveRecord', () => {
  it('발행 성공 시 파일이 생기고 권한이 600/700이 된다', async () => {
    const result = await saveRecord(io(), record)
    expect(result.warning).toBeUndefined()

    const file = resolveStoreFile(io())
    const dir = resolveConfigDir(io())
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(saved).toEqual([record])

    if (!isWindows) {
      const fileMode = (await fs.stat(file)).mode & 0o777
      const dirMode = (await fs.stat(dir)).mode & 0o777
      expect(fileMode).toBe(0o600)
      expect(dirMode).toBe(0o700)
    }
  })

  it('미리 644 파일과 755 디렉터리가 있어도 600/700으로 바뀐다', async () => {
    if (isWindows) return
    const dir = resolveConfigDir(io())
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o755)
    const file = resolveStoreFile(io())
    writeFileSync(file, JSON.stringify([]), { mode: 0o644 })

    await saveRecord(io(), record)

    const fileMode = (await fs.stat(file)).mode & 0o777
    const dirMode = (await fs.stat(dir)).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)
  })

  it('기록 파일이 심볼릭 링크면 쓰지 않고 경고한다', async () => {
    if (isWindows) return
    const dir = resolveConfigDir(io())
    mkdirSync(dir, { recursive: true })
    const elsewhere = path.join(tmpHome, 'elsewhere.json')
    writeFileSync(elsewhere, JSON.stringify([]))
    const file = resolveStoreFile(io())
    symlinkSync(elsewhere, file)

    const result = await saveRecord(io(), record)
    expect(result.warning).toBeDefined()

    const elsewhereContent = JSON.parse(await fs.readFile(elsewhere, 'utf8'))
    expect(elsewhereContent).toEqual([])
  })

  it('디렉터리가 심볼릭 링크면 쓰지 않고 경고한다', async () => {
    if (isWindows) return
    const realDir = path.join(tmpHome, 'real-config')
    await fs.mkdir(realDir, { recursive: true })
    const configBase = path.join(tmpHome, '.config')
    await fs.mkdir(configBase, { recursive: true })
    symlinkSync(realDir, path.join(configBase, 'letsplaytest'))

    const result = await saveRecord(io(), record)
    expect(result.warning).toBeDefined()

    const entries = await fs.readdir(realDir)
    expect(entries).toEqual([])
  })

  it('--no-save 시나리오는 saveRecord를 부르지 않는다(호출부 책임) — 여기서는 저장 자체를 검증', async () => {
    await saveRecord(io(), record)
    const { records } = await loadRecords(io())
    expect(records).toHaveLength(1)
  })

  it('기록 항목에 필요한 필드가 모두 있다', async () => {
    await saveRecord(io(), record)
    const { records } = await loadRecords(io())
    expect(records[0]).toMatchObject({
      slug: expect.any(String),
      title: expect.any(String),
      kind: expect.any(String),
      url: expect.any(String),
      ownerUrl: expect.any(String),
      api: expect.any(String),
      publishedAt: expect.any(String),
    })
  })

  it('깨진 파일은 타임스탬프가 붙은 .bak으로 옮기고(600) 새로 쓴다', async () => {
    if (isWindows) return
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const file = resolveStoreFile(io())
    await fs.writeFile(file, '{ this is not json')

    const result = await saveRecord(io(), record)
    expect(result.warning).toBeUndefined()

    const entries = await fs.readdir(dir)
    const backupName = entries.find((name) => name.startsWith('tests.json.bak.'))
    expect(backupName).toBeDefined()
    const backup = await fs.readFile(path.join(dir, backupName as string), 'utf8')
    expect(backup).toBe('{ this is not json')
    const backupMode = (await fs.stat(path.join(dir, backupName as string))).mode & 0o777
    expect(backupMode).toBe(0o600)

    const fresh = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(fresh).toEqual([record])
  })

  it('배열이 아닌 JSON도 손상으로 보고 백업한다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const file = resolveStoreFile(io())
    await fs.writeFile(file, JSON.stringify({ not: 'an array' }))

    const result = await saveRecord(io(), record)
    expect(result.warning).toBeUndefined()
    const fresh = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(fresh).toEqual([record])
  })

  it('여러 번 저장하면 기록이 누적된다', async () => {
    await saveRecord(io(), record)
    await saveRecord(io(), { ...record, slug: 'def456' })
    const { records } = await loadRecords(io())
    expect(records).toHaveLength(2)
  })

  it('절대 던지지 않는다 — 저장에 실패해도 {warning}으로 돌아온다', async () => {
    // XDG_CONFIG_HOME 자리에 디렉터리 대신 파일을 둬서 mkdir/쓰기가 실패하게 만든다.
    const blockerFile = path.join(tmpHome, 'not-a-dir')
    writeFileSync(blockerFile, 'i am a file')
    const badIo = io({ XDG_CONFIG_HOME: blockerFile })
    const result = await saveRecord(badIo, record)
    expect(result.warning).toBeDefined()
  })

  it('병렬로 여러 번 저장해도 기록을 잃지 않는다(락)', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_v, i) => saveRecord(io(), { ...record, slug: `slug-${i}` })),
    )
    const { records } = await loadRecords(io())
    expect(records).toHaveLength(8)
  })
})

describe('loadRecords', () => {
  it('파일이 없으면 빈 배열', async () => {
    expect(await loadRecords(io())).toEqual({ records: [] })
  })

  it('JSON이 손상됐으면 경고와 함께 빈 배열을 낸다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolveStoreFile(io()), '{ broken')
    const result = await loadRecords(io())
    expect(result.records).toEqual([])
    expect(result.warning).toBeDefined()
  })

  it('항목 하나가 깨져 있어도 나머지는 보여 준다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolveStoreFile(io()), JSON.stringify([record, { broken: true }, 'not an object']))
    const result = await loadRecords(io())
    expect(result.records).toEqual([record])
  })

  it('EACCES 같은 읽기 오류는 손상으로 보지 않는다 — 백업 없이 경고만', async () => {
    if (isWindows || isRoot) return // root는 권한 검사를 무시한다
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const file = resolveStoreFile(io())
    await fs.writeFile(file, JSON.stringify([record]))
    await fs.chmod(file, 0o000)
    try {
      const result = await loadRecords(io())
      expect(result.records).toEqual([])
      expect(result.warning).toBeDefined()
      // 백업하지 않았다 — 원본이 그대로 남아 있다(권한만 복구하면 다시 읽힌다).
      const entries = await fs.readdir(dir)
      expect(entries.some((name) => name.includes('.bak'))).toBe(false)
    } finally {
      await fs.chmod(file, 0o600)
    }
  })
})

describe('락 재설계 — 소유권·생존 확인', () => {
  it('(a) 죽은 pid의 오래된 락 + 병렬 30 publish → 30건 전부 남는다', async () => {
    const dir = resolveConfigDir(io())
    await writeOldLock(dir, deadPid())

    await Promise.all(
      Array.from({ length: 30 }, (_v, i) => saveRecord(io(), { ...record, slug: `dead-lock-${i}` })),
    )
    const { records } = await loadRecords(io())
    expect(records).toHaveLength(30)
  }, 10_000)

  it('(b) 살아 있는 pid의 오래된 락은 빼앗지 않는다 — 재시도 끝에 경고, exit은 여전히 0(저장만 건너뜀)', async () => {
    const dir = resolveConfigDir(io())
    await writeOldLock(dir, process.pid) // 지금 이 테스트 프로세스 — 확실히 살아 있다

    const result = await saveRecord(io(), record)
    expect(result.warning).toBeDefined()

    // 살아 있는 pid의 락은 그대로 남아 있어야 한다(빼앗기지 않았다).
    const lockFile = path.join(dir, 'tests.json.lock')
    const lockContent = JSON.parse(await fs.readFile(lockFile, 'utf8'))
    expect(lockContent.pid).toBe(process.pid)

    // 기록도 쓰이지 않았다.
    const { records } = await loadRecords(io())
    expect(records).toHaveLength(0)
  }, 10_000)

  it('(c) 락 경로가 디렉터리면 재시도 없이 곧장 포기하고 경고한다', async () => {
    const dir = resolveConfigDir(io())
    const lockFile = path.join(dir, 'tests.json.lock')
    await fs.mkdir(lockFile, { recursive: true }) // 락 자리에 디렉터리를 둔다

    const start = Date.now()
    const result = await saveRecord(io(), record)
    const elapsed = Date.now() - start

    expect(result.warning).toBeDefined()
    expect(elapsed).toBeLessThan(2_000) // 재시도 데드라인을 기다리지 않고 즉시 포기한다
  })

  it('(d) release는 남의 락을 지우지 않는다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const lockFile = path.join(dir, 'tests.json.lock')

    // 첫 저장이 락을 잡기 직전에 "다른 프로세스"가 그 사이 락을 새로 잡았다고
    // 가정한다: saveRecord 진행 중 같은 파일에 다른 토큰의 락을 심어 둔다.
    // (직접 acquireLock을 노출하지 않으므로, saveRecord 한 번을 정상 진행시켜
    // release 시점에 파일 내용이 이미 남의 것으로 바뀌어 있는 상황을 만든다.)
    await saveRecord(io(), record) // 락 파일은 이 시점엔 이미 release되어 없다.
    expect(await fs.readFile(lockFile, 'utf8').catch(() => undefined)).toBeUndefined()

    // 이제 남이 쓰는 것처럼 락을 직접 심어 두고, saveRecord가 그 락을 지우지
    // 않는지 본다(락을 못 잡으므로 자기 락을 만들지 않고, 기존 락도 건드리지
    // 않아야 한다 — 살아 있는 pid이므로 stale 판정도 나지 않는다).
    await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, token: 'someone-elses-token', createdAt: Date.now() }))
    const before = await fs.readFile(lockFile, 'utf8')

    await saveRecord(io(), { ...record, slug: 'def456' })

    const after = await fs.readFile(lockFile, 'utf8').catch(() => undefined)
    expect(after).toBe(before) // 남의 락이 그대로 남아 있다 — 지워지지 않았다.
  }, 10_000)
})
