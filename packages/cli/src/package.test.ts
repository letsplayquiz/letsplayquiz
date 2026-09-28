// CLI 이름 변경(SWE-37, 스펙 §7.3)이 패키지 메타데이터에 실제로 반영됐는지
// 확인한다. `dist/bin.js`가 필요한 검사(빌드 산출물, npm pack 파일 목록)는
// 여기서 하지 않는다 — `pnpm cli:smoke`(scripts/smoke.mjs)가 빌드 뒤에 돈다.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cliDir = path.join(here, '..')
const lpqzDir = path.join(here, '..', '..', 'lpqz')

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe('packages/cli package.json', () => {
  const pkg = readJson(path.join(cliDir, 'package.json'))

  it('name이 letsplayquiz다', () => {
    expect(pkg.name).toBe('letsplayquiz')
  })

  it('bin에 letsplayquiz와 lpqz 둘 다 dist/bin.js를 가리킨다', () => {
    expect(pkg.bin).toEqual({ letsplayquiz: 'dist/bin.js', lpqz: 'dist/bin.js' })
  })
})

describe('packages/lpqz package.json', () => {
  const cliPkg = readJson(path.join(cliDir, 'package.json'))
  const lpqzPkg = readJson(path.join(lpqzDir, 'package.json'))

  it('name이 lpqz다', () => {
    expect(lpqzPkg.name).toBe('lpqz')
  })

  it('bin이 bin.js를 가리키고 files에 포함된다', () => {
    expect(lpqzPkg.bin).toEqual({ lpqz: 'bin.js' })
    expect(lpqzPkg.files).toContain('bin.js')
  })

  it('type이 module이다', () => {
    expect(lpqzPkg.type).toBe('module')
  })

  it('버전이 본 패키지와 같다', () => {
    expect(lpqzPkg.version).toBe(cliPkg.version)
  })

  it('letsplayquiz 의존성 버전이 본 패키지 버전과 맞는다', () => {
    const deps = lpqzPkg.dependencies as Record<string, string>
    expect(deps.letsplayquiz).toBe(cliPkg.version)
  })

  it('npm pack --dry-run --json의 파일 목록에 bin.js가 있다(빌드 불필요)', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: lpqzDir, encoding: 'utf8' })
    const [result] = JSON.parse(out) as { files: { path: string }[] }[]
    expect(result.files.some((f) => f.path === 'bin.js')).toBe(true)
  })
})
