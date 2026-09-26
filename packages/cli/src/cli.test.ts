import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, type Io } from './cli.js'
import { resolveStoreFile } from './store.js'

let tmpHome: string
let tmpDir: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'letsplaytest-cli-home-'))
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'letsplaytest-cli-files-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(tmpHome, { recursive: true, force: true })
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeIo(stdin = ''): Io & { stdoutText: () => string; stderrText: () => string } {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => stdin,
    env: {} as NodeJS.ProcessEnv,
    homedir: () => tmpHome,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('validate 명령', () => {
  it('없는 파일 → 2', async () => {
    const io = makeIo()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await run(['validate', path.join(tmpDir, 'nope.json')], io)
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('JSON 문법 오류 → 2, fetch를 부르지 않는다', async () => {
    const file = path.join(tmpDir, 'broken.json')
    await fs.writeFile(file, '{ broken')
    const io = makeIo()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await run(['validate', file], io)
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('- 이면 stdin에서 읽는다', async () => {
    const io = makeIo(JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true, blockers: [], warnings: [] })))
    const code = await run(['validate', '-'], io)
    expect(code).toBe(0)
  })

  it('사람용 출력은 blocker 한 줄에 하나, 경로  코드  메시지 형식이다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = {
      ok: false,
      error: { code: 'validation_failed', message: '고칠 곳 있음' },
      blockers: [{ code: 'choice_no_weight', message: '가중치를 넣어 주세요', path: ['questions', 2, 'choices', 1] }],
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(1)
    expect(io.stdoutText()).toContain('questions[2].choices[1]  choice_no_weight  가중치를 넣어 주세요')
  })

  it('--json이면 서버 본문을 그대로 출력한다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: true, blockers: [], warnings: [] }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)))
    const io = makeIo()
    const code = await run(['validate', file, '--json'], io)
    expect(code).toBe(0)
    expect(JSON.parse(io.stdoutText())).toEqual(body)
  })

  it('429이면 Retry-After 값을 사람용 출력에 적는다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: false, error: { code: 'rate_limited', message: '너무 많아요' } }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, body, { 'retry-after': '120' })))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(3)
    expect(io.stderrText()).toContain('120')
  })
})

describe('publish 명령', () => {
  it('성공하면 url과 ownerUrl을 출력하고 경고를 낸다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    const body = {
      ok: true,
      slug: 'ab12cd34',
      url: 'https://letsplaytest.com/t/ab12cd34',
      ownerUrl: 'https://letsplaytest.com/t/ab12cd34/owner/tok',
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, body)))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toContain(body.url)
    expect(io.stdoutText()).toContain(body.ownerUrl)
    expect(io.stdoutText()).toContain('창작자 전용')
  })

  it('성공하면 기록 파일에 저장된다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    const body = {
      ok: true,
      slug: 'ab12cd34',
      url: 'https://letsplaytest.com/t/ab12cd34',
      ownerUrl: 'https://letsplaytest.com/t/ab12cd34/owner/tok',
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, body)))
    const io = makeIo()
    await run(['publish', file], io)
    const stored = JSON.parse(await fs.readFile(resolveStoreFile({ env: {} as NodeJS.ProcessEnv, homedir: () => tmpHome }), 'utf8'))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ slug: 'ab12cd34', title: '짜장 vs 짬뽕', kind: 'balance' })
  })

  it('--no-save면 기록 파일을 만들지 않는다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    const body = {
      ok: true,
      slug: 'ab12cd34',
      url: 'https://letsplaytest.com/t/ab12cd34',
      ownerUrl: 'https://letsplaytest.com/t/ab12cd34/owner/tok',
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, body)))
    const io = makeIo()
    await run(['publish', file, '--no-save'], io)
    await expect(fs.access(resolveStoreFile({ env: {} as NodeJS.ProcessEnv, homedir: () => tmpHome }))).rejects.toThrow()
  })

  it('검사 실패(400 validation_failed) → 1, blocker를 출력한다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = {
      ok: false,
      error: { code: 'validation_failed', message: '고칠 곳 있음' },
      blockers: [{ code: 'no_questions', message: '문항을 만들어 주세요', path: ['questions'] }],
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, body)))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(1)
    expect(io.stdoutText()).toContain('no_questions')
  })

  it('서버가 500을 주면 4', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: false, error: { code: 'internal', message: '문제가 생겼어요' } }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, body)))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(4)
  })

  it('fetch가 던지면 4', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(4)
  })
})

describe('guide 명령', () => {
  it('서버 응답을 그대로 출력한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('# 설명서', { status: 200, headers: { 'content-type': 'text/markdown' } })),
    )
    const io = makeIo()
    const code = await run(['guide'], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toContain('# 설명서')
  })
})

describe('list 명령', () => {
  it('비어 있으면 안내 문구를 낸다', async () => {
    const io = makeIo()
    const code = await run(['list'], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toContain('없어요')
  })

  it('--json이면 배열을 낸다', async () => {
    const io = makeIo()
    const code = await run(['list', '--json'], io)
    expect(code).toBe(0)
    expect(JSON.parse(io.stdoutText())).toEqual([])
  })

  it('발행 기록이 있으면 보여 준다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    const body = {
      ok: true,
      slug: 'ab12cd34',
      url: 'https://letsplaytest.com/t/ab12cd34',
      ownerUrl: 'https://letsplaytest.com/t/ab12cd34/owner/tok',
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, body)))
    await run(['publish', file], makeIo())

    vi.unstubAllGlobals()
    const io = makeIo()
    const code = await run(['list'], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toContain('짜장 vs 짬뽕')
  })
})

describe('공통', () => {
  it('명령 없이 부르면 도움말 + 2', async () => {
    const io = makeIo()
    const code = await run([], io)
    expect(code).toBe(2)
    expect(io.stderrText()).toContain('letsplaytest')
  })

  it('--version', async () => {
    const io = makeIo()
    const code = await run(['--version'], io)
    expect(code).toBe(0)
    expect(io.stdoutText().trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
