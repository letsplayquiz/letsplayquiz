import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, mkdirSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs'
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
  it('발행 성공 시 파일이 생기고 권한이 600/700이 된다', async () => {
    const result = await saveRecord(io(), record)
    expect(result.warning).toBeUndefined()

    const file = resolveStoreFile(io())
    const dir = resolveConfigDir(io())
    const raw = await fs.readFile(file, 'utf8')
    expect(raw).toBe(`${JSON.stringify(record)}\n`)

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

  it('기록 파일이 다른 사용자 소유면 쓰지 않는다(uid 다르면) — 여기서는 함수가 존재하는지만 형태로 확인', async () => {
    // 실제로 다른 uid를 만들 수는 없으니, isUnsafe 경로 자체는 심볼릭 링크
    // 테스트로 충분히 덮는다. 이 테스트는 정상 경로(내 uid 소유)에서 통과하는지만 본다.
    const result = await saveRecord(io(), record)
    expect(result.warning).toBeUndefined()
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

  it('unconfirmed 필드를 담은 레코드도 유효하다', async () => {
    const dir = resolveConfigDir(io())
    await fs.mkdir(dir, { recursive: true })
    const rec = { ...record, unconfirmed: true }
    await fs.writeFile(resolveStoreFile(io()), `${JSON.stringify(rec)}\n`)
    const result = await loadRecords(io())
    expect(result.records).toEqual([rec])
  })
})
