// CLI 이름 변경(SWE-37, 스펙 §7.3)이 패키지 메타데이터에 실제로 반영됐는지
// 확인한다. `dist/bin.js`가 필요한 검사(빌드 산출물, npm pack 파일 목록)는
// 여기서 하지 않는다 — `pnpm cli:smoke`(scripts/smoke.mjs)가 빌드 뒤에 돈다.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// npm이 Windows에서 npm.cmd(배치 셸)로 설치되므로 execFileSync('npm', ...)은
// ENOENT로 죽는다(T1 리뷰 4번). npx/pnpm 스크립트는 셸을 거쳐 PATH의 확장자
// 해석 규칙을 타지만, execFileSync는 셸 없이 그대로 실행하기 때문에 플랫폼별
// 실행 파일 이름을 직접 골라야 한다.
// Node 18.20 이후로는 .cmd를 셸 없이 실행하면 EINVAL로 거부한다(CVE-2024-27980
// 대응). 그래서 Windows에서는 이름만 바꾸지 않고 셸을 거친다. 인자는 고정
// 문자열뿐이라 셸 해석에 끼어들 사용자 입력이 없다.
const isWindows = process.platform === 'win32'
const npmCommand = isWindows ? 'npm.cmd' : 'npm'

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

  // T1 리뷰 1번: 두 패키지가 같은 bin 이름(lpqz)을 선언하면 둘 다 전역
  // 설치할 때 EEXIST로 실패한다. 본 패키지의 bin은 letsplayquiz 하나뿐이고,
  // lpqz는 연결 패키지(packages/lpqz)만 선언한다 — 아래 두 describe의
  // "겹치지 않음" 테스트가 이걸 같이 확인한다.
  it('bin은 letsplayquiz 하나뿐이다(lpqz는 없음)', () => {
    expect(pkg.bin).toEqual({ letsplayquiz: 'dist/bin.js' })
  })

  // T1 리뷰 3번: lpqz/bin.js가 `letsplayquiz/dist/bin.js`를 직접 import한다
  // (스펙 §7.3). 본 패키지가 exports를 두게 되면 그 경로가 막힐 수 있으니,
  // exports가 없거나 있다면 './dist/bin.js'가 열려 있음을 고정한다.
  it('exports가 없거나, 있으면 ./dist/bin.js가 열려 있다', () => {
    if (pkg.exports === undefined) return
    const exportsMap = pkg.exports as Record<string, unknown>
    expect(exportsMap['./dist/bin.js']).toBeDefined()
  })

  // letsplayquiz-mcp가 `letsplayquiz/lib`로 판정 로직을 재사용한다. 의존성은 0개로 유지한다.
  it('./lib와 ./package.json이 열려 있다', () => {
    const exportsMap = pkg.exports as Record<string, unknown>
    expect(exportsMap['./lib']).toBeDefined()
    expect(exportsMap['./package.json']).toBe('./package.json')
  })

  it('런타임 의존성이 없다', () => {
    expect(pkg.dependencies).toBeUndefined()
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

  it('두 패키지의 bin 이름이 겹치지 않는다(전역 설치 EEXIST 방지)', () => {
    const cliBinNames = Object.keys(cliPkg.bin as Record<string, string>)
    const lpqzBinNames = Object.keys(lpqzPkg.bin as Record<string, string>)
    expect(cliBinNames).toEqual(['letsplayquiz'])
    expect(lpqzBinNames).toEqual(['lpqz'])
    expect(cliBinNames.some((n) => lpqzBinNames.includes(n))).toBe(false)
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
    const out = execFileSync(npmCommand, ['pack', '--dry-run', '--json'], { cwd: lpqzDir, encoding: 'utf8', shell: isWindows })
    const [result] = JSON.parse(out) as { files: { path: string }[] }[]
    expect(result.files.some((f) => f.path === 'bin.js')).toBe(true)
  })
})
