import { describe, it, expect } from 'vitest'
import { parseArgs, DEFAULT_API } from './args.js'

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

describe('parseArgs', () => {
  it('명령이 없으면 도움말(2)을 낸다', () => {
    const outcome = parseArgs([], env())
    expect(outcome).toEqual({ kind: 'help', exitCode: 2 })
  })

  it('모르는 명령이면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['dance'], env())
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('dance'), exitCode: 2 })
  })

  it('--kind가 목록에 없으면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['guide', '--kind', 'nope'], env())
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('nope'), exitCode: 2 })
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

  it('--api가 LETSPLAYTEST_API보다 이긴다', () => {
    const outcome = parseArgs(['list', '--api', 'https://flag.example'], env({ LETSPLAYTEST_API: 'https://env.example' }))
    expect(outcome).toMatchObject({ kind: 'run', args: { api: 'https://flag.example' } })
  })

  it('--api가 없으면 LETSPLAYTEST_API를 쓴다', () => {
    const outcome = parseArgs(['list'], env({ LETSPLAYTEST_API: 'https://env.example' }))
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
    const outcome = parseArgs(['list', '--api', 'http://example.com'], env())
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('https'), exitCode: 2 })
  })

  it('--api가 올바른 URL이 아니면 오류(2)를 낸다', () => {
    const outcome = parseArgs(['list', '--api', 'not a url'], env())
    expect(outcome.kind).toBe('error')
  })

  it('--api가 http://localhost, http://127.0.0.1이면 허용한다', () => {
    expect(parseArgs(['list', '--api', 'http://localhost:3000'], env()).kind).toBe('run')
    expect(parseArgs(['list', '--api', 'http://127.0.0.1:3000'], env()).kind).toBe('run')
  })

  it('경로가 있는 --api도 https면 허용한다', () => {
    const outcome = parseArgs(['list', '--api', 'https://host.example/sub/'], env())
    expect(outcome).toMatchObject({ kind: 'run', args: { api: 'https://host.example/sub/' } })
  })
})
