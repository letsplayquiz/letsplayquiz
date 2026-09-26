import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, promises as fsPromises, mkdirSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveRecord, loadRecords, resolveStoreFile, resolveConfigDir, type StoreIo, type TestRecord } from './store.js'

const isWindows = process.platform === 'win32'

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

const record: TestRecord = {
  slug: 'abc123',
  title: '나의 여행 스타일',
  kind: 'type',
  url: 'https://letsplaytest.com/t/abc123',
  ownerUrl: 'https://letsplaytest.com/t/abc123/owner/tok',
  api: 'https://letsplaytest.com',
  publishedAt: '2026-09-26T00:00:00.000Z',
}

describe('resolveConfigDir / resolveStoreFile', () => {
  it('기본은 homedir/.config/letsplaytest, 파일은 tests.jsonl', () => {
    expect(resolveConfigDir(io())).toBe(path.join(tmpHome, '.config', 'letsplaytest'))
    expect(resolveStoreFile(io())).toBe(path.join(tmpHome, '.config', 'letsplaytest', 'tests.jsonl'))
  })

  it('XDG_CONFIG_HOME이 있으면 그 아래', () => {
    const xdg = path.join(tmpHome, 'xdg')
    expect(resolveConfigDir(io({ XDG_CONFIG_HOME: xdg }))).toBe(path.join(xdg, 'letsplaytest'))
  })
})

describe('saveRecord', () => {
  it('발행 성공 시 파일이 생기고(앞뒤 개행 포함) 권한이 600/700이 된다', async () => {
    const result = await saveRecord(io(), record)
    expect(result.warning).toBeUndefined()

    const file = resolveStoreFile(io())
    const dir = resolveConfigDir(io())
    const raw = await fs.readFile(file, 'utf8')
    expect(raw).toBe(`\n${JSON.stringify(record)}\n`)

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
    writeFileSync(file, '', { mode: 0o644 })

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
    const elsewhere = path.join(tmpHome, 'elsewhere.jsonl')
    writeFileSync(elsewhere, '')
    const file = resolveStoreFile(io())
    symlinkSync(elsewhere, file)

    const result = await saveRecord(io(), record)
    expect(result.warning).toBeDefined()

    const elsewhereContent = await fs.readFile(elsewhere, 'utf8')
    expect(elsewhereContent).toBe('')
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

  it('기록 파일이 다른 사용자 소유면 실제로 쓰기를 거부한다(uid를 다르게 stub)', async () => {
    if (isWindows || typeof process.getuid !== 'function') return
    const dir = resolveConfigDir(io())
    mkdirSync(dir, { recursive: true })
    const file = resolveStoreFile(io())
    writeFileSync(file, '') // 지금은 내 uid 소유

    const myUid = process.getuid()
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(myUid + 1) // "다른 사용자"인 척
    try {
      const result = await saveRecord(io(), record)
      expect(result.warning).toBeDefined()
      const content = await fs.readFile(file, 'utf8')
      expect(content).toBe('') // 실제로 안 쓰였다
    } finally {
      spy.mockRestore()
    }
  })

  it('여러 번 저장하면 한 줄씩 누적된다(append)', async () => {
    await saveRecord(io(), record)
    await saveRecord(io(), { ...record, slug: 'def456' })
    const { records } = await loadRecords(io())
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.slug)).toEqual(['abc123', 'def456'])
  })

  it('절대 던지지 않는다 — 저장에 실패해도 {warning}으로 돌아온다', async () => {
    // XDG_CONFIG_HOME 자리에 디렉터리 대신 파일을 둬서 mkdir/쓰기가 실패하게 만든다.
    const blockerFile = path.join(tmpHome, 'not-a-dir')
    writeFileSync(blockerFile, 'i am a file')
    const badIo = io({ XDG_CONFIG_HOME: blockerFile })
    const result = await saveRecord(badIo, record)
    expect(result.warning).toBeDefined()
  })

  it('앞에 개행이 없는(잘린) 파일에 이어 붙여도 기존·새 기록 모두 읽힌다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const file = resolveStoreFile(io())
    // 개행 없이 끝난 파일(수동 편집이나 예전 short write를 흉내).
    await fs.writeFile(file, JSON.stringify(record))

    const result = await saveRecord(io(), { ...record, slug: 'second' })
    expect(result.warning).toBeUndefined()

    const { records, warning } = await loadRecords(io())
    expect(warning).toBeUndefined()
    expect(records.map((r) => r.slug)).toEqual(['abc123', 'second'])
  })

  it('write()가 일부만 쓰였다고 보고되면(short write) 경고한다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })

    const openSpy = vi.spyOn(fsPromises, 'open')
    openSpy.mockImplementationOnce(async (...args: Parameters<typeof fsPromises.open>) => {
      openSpy.mockRestore() // 이후 호출(그리고 실제 핸들을 여는 아래 호출)은 원래 동작으로.
      const handle = await fsPromises.open(...args)
      const originalWrite = handle.write.bind(handle)
      vi.spyOn(handle, 'write').mockImplementationOnce(async (data: unknown) => {
        // 실제로는 파일에 전부 쓰지만(그래서 파일 내용 자체는 온전하다), 커널이
        // 절반만 썼다고 보고하는 상황(디스크 공간 부족 직전 등)을 흉내 낸다.
        const full = await originalWrite(data as string)
        return { ...full, bytesWritten: Math.floor(full.bytesWritten / 2) }
      })
      return handle
    })

    try {
      const result = await saveRecord(io(), record)
      expect(result.warning).toBeDefined()
      expect(result.warning).toContain('일부만')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('title이 아주 길어 4000바이트를 넘으면 title을 잘라서라도 한 줄에 담는다', async () => {
    const longRecord: TestRecord = { ...record, title: 'a'.repeat(6000) }
    const result = await saveRecord(io(), longRecord)
    expect(result.warning).toBeUndefined()

    const raw = await fs.readFile(resolveStoreFile(io()), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(1)
    expect(Buffer.byteLength(lines[0], 'utf8')).toBeLessThanOrEqual(4000)
    const parsed = JSON.parse(lines[0])
    expect(parsed.title.length).toBeLessThan(6000)
    expect(parsed.slug).toBe(record.slug) // 다른 필드는 그대로다
  })

  it('title을 다 잘라내도 4000바이트를 넘으면 저장을 건너뛰고 경고한다', async () => {
    const impossible: TestRecord = { ...record, title: '', url: `https://letsplaytest.com/t/${'x'.repeat(5000)}` }
    const result = await saveRecord(io(), impossible)
    expect(result.warning).toBeDefined()
    expect(result.warning).toContain('4000')

    const { records } = await loadRecords(io())
    expect(records).toHaveLength(0)
  })

  it('아주 긴 title(10만 자)도 100ms 안에 처리한다(한 글자씩 지우는 루프가 미리 잘라 둔 덕분)', async () => {
    const hugeTitleRecord: TestRecord = { ...record, title: 'a'.repeat(100_000) }
    const start = Date.now()
    const result = await saveRecord(io(), hugeTitleRecord)
    const elapsed = Date.now() - start
    expect(result.warning).toBeUndefined()
    expect(elapsed).toBeLessThan(100)
  })

  it('병렬로 60번 저장해도 60줄 모두 파싱 가능하고 깨진 줄이 없다', async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_v, i) => saveRecord(io(), { ...record, slug: `slug-${i}` })),
    )
    const { records, warning } = await loadRecords(io())
    expect(warning).toBeUndefined()
    expect(records).toHaveLength(60)
    const slugs = new Set(records.map((r) => r.slug))
    expect(slugs.size).toBe(60)
  })
})

describe('loadRecords', () => {
  it('파일이 없으면 빈 배열', async () => {
    expect(await loadRecords(io())).toEqual({ records: [] })
  })

  it('깨진 줄은 건너뛰고 개수를 경고로 알린다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const lines = [JSON.stringify(record), '{ not valid json', JSON.stringify({ only: 'partial' }), '']
    await fs.writeFile(resolveStoreFile(io()), lines.join('\n'))

    const result = await loadRecords(io())
    expect(result.records).toEqual([record])
    expect(result.warning).toContain('2')
  })

  it('전부 정상이면 경고가 없다', async () => {
    await saveRecord(io(), record)
    const result = await loadRecords(io())
    expect(result.warning).toBeUndefined()
  })

  it('알 수 없는 추가 필드(예전 unconfirmed 등)가 있어도 깨진 줄로 취급하지 않는다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const rec = { ...record, unconfirmed: true }
    await fs.writeFile(resolveStoreFile(io()), `${JSON.stringify(rec)}\n`)
    const result = await loadRecords(io())
    expect(result.warning).toBeUndefined()
    expect(result.records).toEqual([rec])
  })

  it('디렉터리가 심볼릭 링크면 경고를 돌려준다', async () => {
    if (isWindows) return
    const realDir = path.join(tmpHome, 'real-config')
    await fs.mkdir(realDir, { recursive: true })
    const configBase = path.join(tmpHome, '.config')
    await fs.mkdir(configBase, { recursive: true })
    symlinkSync(realDir, path.join(configBase, 'letsplaytest'))

    const result = await loadRecords(io())
    expect(result.records).toEqual([])
    expect(result.warning).toBeDefined()
  })

  it('파일이 심볼릭 링크면 경고를 돌려준다', async () => {
    if (isWindows) return
    const dir = resolveConfigDir(io())
    mkdirSync(dir, { recursive: true })
    const elsewhere = path.join(tmpHome, 'elsewhere.jsonl')
    writeFileSync(elsewhere, `${JSON.stringify(record)}\n`)
    symlinkSync(elsewhere, resolveStoreFile(io()))

    const result = await loadRecords(io())
    expect(result.records).toEqual([])
    expect(result.warning).toBeDefined()
  })
})
