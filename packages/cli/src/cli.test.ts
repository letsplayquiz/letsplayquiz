import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run, main, type Io } from './cli.js'
import { resolveStoreFile } from './store.js'

let tmpHome: string
let tmpDir: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'letsplayquiz-cli-home-'))
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'letsplayquiz-cli-files-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(tmpHome, { recursive: true, force: true })
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeIo(
  stdin = '',
  opts: { isStdinTTY?: boolean } = {},
): Io & { stdoutText: () => string; stderrText: () => string } {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => stdin,
    isStdinTTY: () => opts.isStdinTTY ?? false,
    env: {} as NodeJS.ProcessEnv,
    homedir: () => tmpHome,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** 기록 파일은 JSONL이다(한 줄에 레코드 하나). 테스트에서 통째로 읽어 배열로
 * 돌려준다. */
async function readStoredRecords(): Promise<unknown[]> {
  const file = resolveStoreFile({ env: {} as NodeJS.ProcessEnv, homedir: () => tmpHome })
  const raw = await fs.readFile(file, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

async function storeFileExists(): Promise<boolean> {
  const file = resolveStoreFile({ env: {} as NodeJS.ProcessEnv, homedir: () => tmpHome })
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
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
      url: 'https://letsplayquiz.net/t/ab12cd34',
      ownerUrl: 'https://letsplayquiz.net/t/ab12cd34/owner/tok',
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
      url: 'https://letsplayquiz.net/t/ab12cd34',
      ownerUrl: 'https://letsplayquiz.net/t/ab12cd34/owner/tok',
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, body)))
    const io = makeIo()
    await run(['publish', file], io)
    const stored = await readStoredRecords()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ slug: 'ab12cd34', title: '짜장 vs 짬뽕', kind: 'balance' })
  })

  it('--no-save면 기록 파일을 만들지 않는다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    const body = {
      ok: true,
      slug: 'ab12cd34',
      url: 'https://letsplayquiz.net/t/ab12cd34',
      ownerUrl: 'https://letsplayquiz.net/t/ab12cd34/owner/tok',
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, body)))
    const io = makeIo()
    await run(['publish', file, '--no-save'], io)
    expect(await storeFileExists()).toBe(false)
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

  it('연결 자체가 안 되면(ECONNREFUSED류) 4', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('fetch failed') as Error & { cause?: unknown }
        err.cause = { code: 'ECONNREFUSED' }
        throw err
      }),
    )
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(4)
  })

  it('원인 코드를 알 수 없는 fetch 실패는 5(확실하지 않음)다', async () => {
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
    expect(code).toBe(5)
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
      url: 'https://letsplayquiz.net/t/ab12cd34',
      ownerUrl: 'https://letsplayquiz.net/t/ab12cd34/owner/tok',
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

  it('예전 버전이 남긴 알 수 없는 필드(unconfirmed 등)가 있어도 깨진 줄로 취급하지 않고 보여 준다', async () => {
    // "확인 필요" 자동 기록 기능은 2026-09-26 다섯 번째 리뷰에서 걷어냈지만
    // (죽은 코드였다), 그 기능이 살아 있던 버전이 남긴 tests.jsonl은 여전히
    // 디스크에 있을 수 있다 — list가 그런 줄을 무시하고 나머지 필드로
    // 정상 표시해야 한다(경고나 "(확인 필요)" 표시는 더 이상 없다).
    const configDir = path.join(tmpHome, '.config', 'letsplayquiz')
    await fs.mkdir(configDir, { recursive: true })
    const legacyRecord = {
      slug: 'ab12cd34',
      title: '예전 버전 기록',
      kind: 'balance',
      url: 'https://letsplayquiz.net/t/ab12cd34',
      ownerUrl: 'https://letsplayquiz.net/t/ab12cd34/owner/tok',
      api: 'https://letsplayquiz.net',
      publishedAt: '2026-09-26T00:00:00.000Z',
      unconfirmed: true,
    }
    await fs.writeFile(path.join(configDir, 'tests.jsonl'), `${JSON.stringify(legacyRecord)}\n`)

    const io = makeIo()
    const code = await run(['list'], io)
    expect(code).toBe(0)
    expect(io.stderrText()).toBe('')
    expect(io.stdoutText()).toContain('예전 버전 기록')
    expect(io.stdoutText()).not.toContain('확인 필요')
  })
})

describe('공통', () => {
  it('명령 없이 부르면 도움말 + 2', async () => {
    const io = makeIo()
    const code = await run([], io)
    expect(code).toBe(2)
    expect(io.stderrText()).toContain('letsplayquiz')
  })

  it('--version', async () => {
    const io = makeIo()
    const code = await run(['--version'], io)
    expect(code).toBe(0)
    expect(io.stdoutText().trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('위치 인자가 명령+파일을 넘으면 2', async () => {
    const io = makeIo()
    const code = await run(['validate', 'a.json', 'b.json'], io)
    expect(code).toBe(2)
  })

  it('--api가 http이면서 로컬이 아니면 2', async () => {
    const io = makeIo()
    vi.stubGlobal('fetch', vi.fn())
    const code = await run(['guide', '--api', 'http://example.com'], io)
    expect(code).toBe(2)
    expect(io.stderrText()).toContain('https')
  })

  it('--api가 http://localhost면 허용한다', async () => {
    const io = makeIo()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# guide', { status: 200 })))
    const code = await run(['guide', '--api', 'http://localhost:3000'], io)
    expect(code).toBe(0)
  })

  it('--api가 올바른 URL이 아니면 2', async () => {
    const io = makeIo()
    vi.stubGlobal('fetch', vi.fn())
    const code = await run(['guide', '--api', 'not a url'], io)
    expect(code).toBe(2)
  })

  it('list는 잘못된 --api를 무시하고 동작한다', async () => {
    const io = makeIo()
    const code = await run(['list', '--api', 'not a url'], io)
    expect(code).toBe(0)
  })
})

describe('- 표준 입력', () => {
  it('stdin이 TTY면 2를 내고 fetch를 부르지 않는다', async () => {
    const io = makeIo('', { isStdinTTY: true })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await run(['validate', '-'], io)
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('BOM 처리', () => {
  it('파일 앞에 UTF-8 BOM이 있어도 JSON으로 읽는다', async () => {
    const file = path.join(tmpDir, 'bom.json')
    await fs.writeFile(file, `﻿${JSON.stringify({ kind: 'balance' })}`)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true, blockers: [], warnings: [] })))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(0)
  })
})

describe('타임아웃', () => {
  it('30초 안에 응답이 없으면 4 + 안내 문구', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted', 'AbortError')),
              )
            }),
        ),
      )
      const io = makeIo()
      const promise = run(['guide'], io)
      await vi.advanceTimersByTimeAsync(30_000)
      const code = await promise
      expect(code).toBe(4)
      expect(io.stderrText()).toContain('30초')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('계약과 다른 응답(비정상 2xx)', () => {
  it('validate가 200인데 JSON이 아니면 4', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>ok?</html>', { status: 200 })))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(4)
  })

  it('validate가 200인데 ok 필드가 없으면 4', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { hello: 'world' })))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(4)
  })

  it('--json이면 bad_response 코드를 담은 합성 JSON을 낸다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const io = makeIo()
    const code = await run(['validate', file, '--json'], io)
    expect(code).toBe(4)
    const parsed = JSON.parse(io.stdoutText())
    expect(parsed.error.code).toBe('bad_response')
  })

  it('publish가 ok:true인데 url/ownerUrl/slug가 없으면 5(결과 불명), 원문을 함께 낸다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, { ok: true })))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(5)
    expect(io.stderrText()).toContain('발행됐을 수 있어요')
    expect(io.stderrText()).toContain('"ok":true')
  })

  it('validate가 ok:true인데 필드가 없어도(계약이 요구하지 않으므로) 정상 0이다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(0)
  })
})

describe('publish 결과 불명(exit 5)', () => {
  // stdin('-')으로 입력을 준다 — 실제 파일을 읽으면 libuv 스레드풀을 거치는
  // 진짜 비동기 I/O라 `vi.advanceTimersByTimeAsync`가 시작되는 시점에 아직
  // 안 끝나 있을 수 있고, 그러면 그 뒤에 등록되는 setTimeout을 놓쳐 테스트가
  // 영영 멈춘다(실측 확인됨). `io.readStdin`은 순수 마이크로태스크라 이 경쟁이
  // 없다.
  it('60초 안에 응답이 없으면 5(4가 아니다) — 이미 도달했을 수 있다', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted', 'AbortError')),
              )
            }),
        ),
      )
      const io = makeIo(JSON.stringify({ kind: 'balance' }))
      const promise = run(['publish', '-'], io)
      await vi.advanceTimersByTimeAsync(60_000)
      const code = await promise
      expect(code).toBe(5)
      expect(io.stderrText()).toContain('발행됐을 수 있어요')
    } finally {
      vi.useRealTimers()
    }
  })

  it('30초에서는 아직 타임아웃되지 않는다(publish는 60초)', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'AbortError'))
              })
            }),
        ),
      )
      const promise = run(['publish', '-'], makeIo(JSON.stringify({ kind: 'balance' }))).then((code) => {
        settled = true
        return code
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      await promise
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('연결 자체가 안 되면(cause.code가 ECONNREFUSED류) 4 그대로다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('fetch failed') as Error & { cause?: unknown }
        err.cause = { code: 'ECONNREFUSED' }
        throw err
      }),
    )
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(4)
  })

  it('연결은 됐지만 본문이 끊기면 5다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const res = new Response('irrelevant')
        vi.spyOn(res, 'text').mockRejectedValue(new Error('ECONNRESET'))
        return res
      }),
    )
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(5)
  })

  it('--json이면 publish_unknown 코드를 담은 합성 JSON을 낸다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, { ok: true })))
    const io = makeIo()
    const code = await run(['publish', file, '--json'], io)
    expect(code).toBe(5)
    const parsed = JSON.parse(io.stdoutText())
    expect(parsed.error.code).toBe('publish_unknown')
    expect(parsed.raw).toContain('"ok":true')
  })

  it('ok:true인데 ownerUrl이 없으면(계약 위반) 5, 기록은 남기지 않는다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    // ok: true인데 ownerUrl이 없다 — hasRequiredFields가 실패해 5(결과 불명)로
    // 끝난다. "확인 필요" 자동 기록 기능은 걷어냈으므로(2026-09-26 다섯 번째
    // 리뷰) 5는 항상 기록을 남기지 않는다.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(201, { ok: true, slug: 'ab12cd34', url: 'https://letsplayquiz.net/t/ab12cd34' })),
    )
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(5)
    expect(await storeFileExists()).toBe(false)
  })

  it('ok 필드가 없는(계약 위반) 502류 응답은 링크가 본문에 있어도 기록을 남기지 않는다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    const raw = JSON.stringify({
      slug: 'ab12cd34',
      url: 'https://letsplayquiz.net/t/ab12cd34',
      ownerUrl: 'https://letsplayquiz.net/t/ab12cd34/owner/tok',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 200 })))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(5)
    expect(await storeFileExists()).toBe(false)
  })

  it('--no-save면 뽑은 링크가 있어도 저장하지 않는다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, { ok: true })))
    const io = makeIo()
    const code = await run(['publish', file, '--no-save'], io)
    expect(code).toBe(5)
    expect(await storeFileExists()).toBe(false)
  })
})

describe('서버가 결과 불명을 스스로 알림(publish_unknown) / 알려진 4 코드', () => {
  it('JSON 502 publish_unknown → 5', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: false, error: { code: 'publish_unknown', message: '서버도 결과를 몰라요' } }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, body)))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(5)
  })

  it('JSON 500 internal → 4(알려진 코드는 그대로)', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: false, error: { code: 'internal', message: '문제가 생겼어요' } }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, body)))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(4)
  })

  it('JSON 5xx의 모르는 코드는 5(안전한 쪽)', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: false, error: { code: 'brand_new_server_code', message: 'm' } }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, body)))
    const io = makeIo()
    const code = await run(['publish', file], io)
    expect(code).toBe(5)
  })
})

describe('429/503과 --json', () => {
  it('429 --json 출력에 retryAfterSeconds를 덧붙인다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: false, error: { code: 'rate_limited', message: 'm' } }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, body, { 'retry-after': '77' })))
    const io = makeIo()
    const code = await run(['validate', file, '--json'], io)
    expect(code).toBe(3)
    expect(JSON.parse(io.stdoutText())).toMatchObject({ retryAfterSeconds: 77 })
  })

  it('Retry-After가 없으면 잠시 후 문구로 대체한다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = { ok: false, error: { code: 'rate_limited', message: 'm' } }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, body)))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(3)
    expect(io.stderrText()).toContain('잠시 후')
  })
})

describe('validate 성공 + warnings', () => {
  it('blocker가 없어도 warnings를 사람용 출력에 보여 준다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance' }))
    const body = {
      ok: true,
      blockers: [],
      warnings: [{ code: 'title_short', message: '제목이 짧아요', path: ['title'] }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)))
    const io = makeIo()
    const code = await run(['validate', file], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toContain('title_short')
  })
})

describe('list의 손상된 기록 파일', () => {
  it('깨진 줄이 있으면 stderr로 알리고 나머지만 보여 준다', async () => {
    const configDir = path.join(tmpHome, '.config', 'letsplayquiz')
    await fs.mkdir(configDir, { recursive: true })
    const good = {
      slug: 'abc',
      title: '좋은 기록',
      kind: 'balance',
      url: 'https://letsplayquiz.net/t/abc',
      ownerUrl: 'https://letsplayquiz.net/t/abc/owner/tok',
      api: 'https://letsplayquiz.net',
      publishedAt: '2026-09-26T00:00:00.000Z',
    }
    await fs.writeFile(path.join(configDir, 'tests.jsonl'), `${JSON.stringify(good)}\n{ broken\n`)
    const io = makeIo()
    const code = await run(['list'], io)
    expect(code).toBe(0)
    expect(io.stderrText()).toContain('깨진')
    expect(io.stdoutText()).toContain('좋은 기록')
  })
})

describe('저장 실패는 발행을 실패시키지 않는다', () => {
  it('쓸 수 없는 XDG_CONFIG_HOME이어도 publish는 exit 0이다', async () => {
    const file = path.join(tmpDir, 'test.json')
    await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: '짜장 vs 짬뽕' }))
    const body = {
      ok: true,
      slug: 'ab12cd34',
      url: 'https://letsplayquiz.net/t/ab12cd34',
      ownerUrl: 'https://letsplayquiz.net/t/ab12cd34/owner/tok',
      warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(201, body)))

    // XDG_CONFIG_HOME 자리에 디렉터리가 아니라 파일을 둬서 mkdir/write가 실패하게 만든다.
    const blockerFile = path.join(tmpDir, 'not-a-dir')
    await fs.writeFile(blockerFile, 'i am a file, not a directory')

    const out: string[] = []
    const err: string[] = []
    const io: Io = {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      readStdin: async () => '',
      isStdinTTY: () => false,
      env: { XDG_CONFIG_HOME: blockerFile } as unknown as NodeJS.ProcessEnv,
      homedir: () => tmpHome,
    }
    const code = await run(['publish', file], io)
    expect(code).toBe(0)
    // 저장에 실패했다는 경고는 나오지만(구체적 문구는 실패 지점에 따라 다르다),
    // 발행 자체는 exit 0으로 끝난다 — 중복 발행을 유발하지 않는다.
    expect(err.join('').length).toBeGreaterThan(0)
    expect(out.join('')).toContain('url:')
  })
})

describe('동시 publish', () => {
  it('병렬로 10번 발행해도 기록 10건이 모두 남는다', async () => {
    const files = await Promise.all(
      Array.from({ length: 10 }, async (_v, i) => {
        const file = path.join(tmpDir, `test-${i}.json`)
        await fs.writeFile(file, JSON.stringify({ kind: 'balance', title: `테스트 ${i}` }))
        return file
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const slug = `slug-${Math.random().toString(36).slice(2)}`
        return jsonResponse(201, {
          ok: true,
          slug,
          url: `https://letsplayquiz.net/t/${slug}`,
          ownerUrl: `https://letsplayquiz.net/t/${slug}/owner/tok`,
          warnings: [],
        })
      }),
    )
    await Promise.all(files.map((file) => run(['publish', file], makeIo())))

    const stored = await readStoredRecords()
    expect(stored).toHaveLength(10)
  })
})

describe('main()은 process.exit()을 부르지 않는다', () => {
  it('--version 경로에서 exitCode만 설정하고 process.exit은 부르지 않는다', async () => {
    const originalArgv = process.argv
    const originalExitCode = process.exitCode
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit()이 불렸어요 — process.exitCode만 설정해야 해요')
    })
    try {
      process.argv = [process.execPath, 'letsplayquiz', '--version']
      process.exitCode = undefined
      await main()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(0)
    } finally {
      process.argv = originalArgv
      process.exitCode = originalExitCode
      exitSpy.mockRestore()
    }
  })

  it('사용법 오류 경로(exit 2)에서도 process.exit을 부르지 않는다', async () => {
    const originalArgv = process.argv
    const originalExitCode = process.exitCode
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit()이 불렸어요 — process.exitCode만 설정해야 해요')
    })
    try {
      process.argv = [process.execPath, 'letsplayquiz', 'dance']
      process.exitCode = undefined
      await main()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(2)
    } finally {
      process.argv = originalArgv
      process.exitCode = originalExitCode
      exitSpy.mockRestore()
    }
  })
})
