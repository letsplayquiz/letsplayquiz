import { describe, it, expect } from 'vitest'
import { parseArgs, DEFAULT_API, HELP_TEXT, KINDS } from './args.js'

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

describe('HELP_TEXT', () => {
  it('기록 파일을 실제 이름(tests.jsonl)으로 안내한다', () => {
    expect(HELP_TEXT).toContain('tests.jsonl')
    expect(HELP_TEXT).not.toMatch(/tests\.json(?!l)/)
  })

  it('--show-owner를 안내하고 --json이 ownerUrl을 뺀다고 알린다', () => {
    expect(HELP_TEXT).toContain('--show-owner')
    expect(HELP_TEXT).toMatch(/--json[^\n]*ownerUrl/)
  })

  it('--kind 목록에 level이 있다', () => {
    expect(HELP_TEXT).toContain('--kind score|type|balance|worldcup|level')
  })
})

describe('parseArgs', () => {
  it('명령이 없으면 도움말(2)을 낸다', () => {
    const outcome = parseArgs([], env())
    expect(outcome).toEqual({ kind: 'help', exitCode: 2 })
  })

  it('모르는 명령이면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['dance'], env())
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('dance'), exitCode: 2 })
  })

  // 서버에 새 종류가 생겨도 옛 버전 CLI가 쓸 수 있어야 한다 — 로컬은 모양만 보고, 아는 종류인지는 서버가 정한다.
  it('--kind가 목록에 없는 종류여도 모양이 맞으면 서버로 넘긴다', () => {
    for (const kind of ['nope', 'mbti_2', 'quiz2', 'a', 'a'.repeat(20)]) {
      expect(parseArgs(['guide', '--kind', kind], env())).toMatchObject({ kind: 'run', args: { command: 'guide', kind } })
    }
  })

  it('--kind 모양이 틀리면(대문자·공백·기호·빈 값·21자 이상) 오류(2)를 낸다', () => {
    for (const kind of ['Nope', 'has space', 'kor-ean', 'q?x=1', '', 'a'.repeat(21), '한글', '../x']) {
      const outcome = parseArgs(['guide', '--kind', kind], env())
      expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('--kind'), exitCode: 2 })
    }
  })

  it('알려진 종류 다섯 개는 그대로 통과한다', () => {
    for (const kind of KINDS) {
      expect(parseArgs(['guide', '--kind', kind], env())).toMatchObject({ kind: 'run', args: { kind } })
    }
  })

  it('도움말의 종류 목록은 예시임을 밝힌다', () => {
    expect(HELP_TEXT).toMatch(/--kind[^\n]*(예|서버)/)
  })

  it('--kind level을 받아들인다', () => {
    const outcome = parseArgs(['guide', '--kind', 'level'], env())
    expect(outcome).toMatchObject({ kind: 'run', args: { command: 'guide', kind: 'level' } })
  })

  it('--show-owner는 기본 false, 주면 true', () => {
    expect(parseArgs(['list'], env())).toMatchObject({ kind: 'run', args: { showOwner: false } })
    expect(parseArgs(['list', '--show-owner'], env())).toMatchObject({ kind: 'run', args: { showOwner: true } })
  })

  it('--lang이 목록에 없으면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['guide', '--lang', 'fr'], env())
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('fr'), exitCode: 2 })
  })

  it('validate/publish에 파일 인자가 없으면 오류(2)를 낸다', () => {
    expect(parseArgs(['validate'], env())).toEqual({
      kind: 'error',
      message: expect.stringContaining('validate'),
      exitCode: 2,
    })
    expect(parseArgs(['publish'], env())).toEqual({
      kind: 'error',
      message: expect.stringContaining('publish'),
      exitCode: 2,
    })
  })

  it('list는 파일 인자가 없어도 된다', () => {
    const outcome = parseArgs(['list'], env())
    expect(outcome.kind).toBe('run')
  })

  it('--api가 LETSPLAYQUIZ_API보다 이긴다', () => {
    const outcome = parseArgs(['list', '--api', 'https://flag.example'], env({ LETSPLAYQUIZ_API: 'https://env.example' }))
    expect(outcome).toMatchObject({ kind: 'run', args: { api: 'https://flag.example' } })
  })

  it('--api가 없으면 LETSPLAYQUIZ_API를 쓴다', () => {
    const outcome = parseArgs(['list'], env({ LETSPLAYQUIZ_API: 'https://env.example' }))
    expect(outcome).toMatchObject({ kind: 'run', args: { api: 'https://env.example' } })
  })

  it('둘 다 없으면 기본 API를 쓴다', () => {
    const outcome = parseArgs(['list'], env())
    expect(outcome).toMatchObject({ kind: 'run', args: { api: DEFAULT_API } })
  })

  it('--version은 version을 낸다', () => {
    expect(parseArgs(['--version'], env())).toEqual({ kind: 'version' })
  })

  it('--help는 도움말(0)을 낸다', () => {
    expect(parseArgs(['--help'], env())).toEqual({ kind: 'help', exitCode: 0 })
  })

  it('올바른 validate 호출을 파싱한다', () => {
    const outcome = parseArgs(['validate', 'file.json', '--json', '--lang', 'ja'], env())
    expect(outcome).toEqual({
      kind: 'run',
      args: {
        command: 'validate',
        file: 'file.json',
        kind: undefined,
        json: true,
        lang: 'ja',
        api: DEFAULT_API,
        noSave: false,
        showOwner: false,
      },
    })
  })

  it('--no-save를 인식한다', () => {
    const outcome = parseArgs(['publish', 'file.json', '--no-save'], env())
    expect(outcome).toMatchObject({ kind: 'run', args: { noSave: true } })
  })

  it('위치 인자가 명령+파일 둘을 넘으면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['validate', 'a.json', 'b.json'], env())
    expect(outcome).toEqual({ kind: 'error', message: expect.any(String), exitCode: 2 })
  })

  it('--api가 http이고 로컬이 아니면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['guide', '--api', 'http://example.com'], env())
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('https'), exitCode: 2 })
  })

  it('--api가 올바른 URL이 아니면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['guide', '--api', 'not a url'], env())
    expect(outcome.kind).toBe('error')
  })

  it('--api가 http://localhost, http://127.0.0.1, http://[::1]이면 허용한다', () => {
    expect(parseArgs(['guide', '--api', 'http://localhost:3000'], env()).kind).toBe('run')
    expect(parseArgs(['guide', '--api', 'http://127.0.0.1:3000'], env()).kind).toBe('run')
    expect(parseArgs(['guide', '--api', 'http://[::1]:3000'], env()).kind).toBe('run')
  })

  it('--api에 user:pass@가 있으면 오류(2)를 낸다(로컬 http도 마찬가지)', () => {
    expect(parseArgs(['guide', '--api', 'https://user:pass@host.example'], env())).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseArgs(['guide', '--api', 'https://user@host.example'], env())).toMatchObject({ kind: 'error', exitCode: 2 })
    expect(parseArgs(['guide', '--api', 'http://u:p@localhost:3000'], env())).toMatchObject({ kind: 'error', exitCode: 2 })
  })

  it('경로가 있는 --api도 https면 허용한다', () => {
    const outcome = parseArgs(['guide', '--api', 'https://host.example/sub/'], env())
    expect(outcome).toMatchObject({ kind: 'run', args: { api: 'https://host.example/sub/' } })
  })

  it('list는 --api 검증을 건너뛴다(잘못된 LETSPLAYQUIZ_API가 로컬 목록을 막지 않게)', () => {
    expect(parseArgs(['list'], env({ LETSPLAYQUIZ_API: 'http://not-local.example' })).kind).toBe('run')
    expect(parseArgs(['list', '--api', 'not a url either'], env()).kind).toBe('run')
  })
})
