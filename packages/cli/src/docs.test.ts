// 사용자에게 가는 안내문(스킬·README)이 CLI의 실제 동작과 어긋나지 않는지 지키는
// 시험. 문장 전체를 고정하지 않고, 틀리면 사용자를 오도하는 핵심 사실만 본다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..', '..')

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(repoRoot, ...segments), 'utf8')
}

describe('skills/letsplayquiz/SKILL.md', () => {
  const skill = readRepoFile('skills', 'letsplayquiz', 'SKILL.md')

  // 종료 코드 5(결과 불명)면 CLI는 아무 것도 기록하지 않는다(cli.ts printPublishUnknown) —
  // `list`로 찾아보라거나 공유 링크를 열어 보라고 하면 없는 것을 찾게 만든다.
  describe('종료 코드 5 안내', () => {
    const line = skill.split('\n').find((l) => l.includes('Exit code 5')) ?? ''

    it('안내가 있다', () => {
      expect(line).not.toBe('')
    })

    it('list나 공유 링크로 확인하라고 하지 않는다(기록도 링크도 없다)', () => {
      expect(line).not.toMatch(/suggest checking/i)
      expect(line).not.toMatch(/trying the share link/i)
    })

    it('list에 없다는 사실, 다시 발행하지 말 것, 원문(raw)의 url, 사용자 결정을 말한다', () => {
      expect(line).toMatch(/does not (record|save)|won't show|will not show/i)
      expect(line).toMatch(/do not publish again/i)
      expect(line).toContain('raw')
      expect(line).toContain('url')
      expect(line).toMatch(/user decide|user decides|up to the user/i)
    })
  })

  // list는 ownerUrl을 기본으로 숨긴다 — 스킬이 에이전트에게 그걸 먼저 알려야 한다.
  it('list가 ownerUrl을 숨기고 --show-owner는 사용자가 요청할 때만 쓰라고 안내한다', () => {
    const line = skill.split('\n').find((l) => l.includes('--show-owner')) ?? ''
    expect(line).not.toBe('')
    expect(line).toMatch(/ownerUrl/)
    expect(line).toMatch(/explicitly asks/i)
  })

  // 검수 차단(moderation_blocked)은 publish에서만 나온다(validate로 미리 잡히지 않는다).
  // 에이전트가 혼자 내용을 바꿔 몰래 다시 시도하면 사용자가 모르는 새 내용이 발행된다.
  describe('moderation_blocked 안내', () => {
    const para = skill.split('\n').find((l) => l.includes('moderation_blocked')) ?? ''

    it('안내가 있다', () => {
      expect(para).not.toBe('')
    })

    it('validate로 미리 잡히지 않는다, 혼자 바꿔 재시도하지 않는다, 사용자와 함께 고친다를 말한다', () => {
      expect(para).toMatch(/validate/)
      expect(para).toMatch(/not caught|cannot catch|can't catch|won't catch/i)
      expect(para).toMatch(/do not (quietly )?(reword|change|edit)[^.]*retry/i)
      expect(para).toMatch(/tell the user/i)
      expect(para).toMatch(/together/i)
    })
  })
})

describe('제품 명사(quiz) 규칙', () => {
  it('스킬 본문은 만드는 물건을 test가 아니라 quiz로 부른다(사용자가 하는 말을 모은 트리거 문구는 제외)', () => {
    const skill = readRepoFile('skills', 'letsplayquiz', 'SKILL.md')
    const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '')
    expect(body).not.toMatch(/personality test/i)
  })

  it('플러그인 설명도 quiz다', () => {
    const plugin = JSON.parse(readRepoFile('.claude-plugin', 'plugin.json')) as { description: string }
    expect(plugin.description).not.toMatch(/personality test/i)
    expect(plugin.description).toMatch(/personality quiz/i)
  })
})

describe('npm에서 깨지는 상대 링크', () => {
  // npm 패키지 페이지는 저장소 안의 상대 경로를 풀지 못한다 — 패키지 README의 링크는 절대 URL이어야 한다.
  for (const pkg of ['cli', 'mcp', 'lpq']) {
    it(`packages/${pkg}/README.md에 상대 링크가 없다`, () => {
      const readme = readRepoFile('packages', pkg, 'README.md')
      const relative = [...readme.matchAll(/\]\((?!https?:\/\/|#|mailto:)([^)]*)\)/g)].map((m) => m[1])
      expect(relative).toEqual([])
    })
  }

  it('MCP README의 CLI 링크는 저장소의 packages/cli를 가리키는 절대 URL이다', () => {
    const readme = readRepoFile('packages', 'mcp', 'README.md')
    expect(readme).toContain('](https://github.com/letsplayquiz/letsplayquiz/tree/main/packages/cli)')
  })
})

describe('docs/api.md가 서버 계약을 빠짐없이 적는다', () => {
  const api = readRepoFile('docs', 'api.md')

  it('본문 표에 cover가 있고 guide JSON의 covers를 가리킨다', () => {
    expect(api).toMatch(/^\| `cover` \|/m)
    expect(api).toContain('`covers`')
  })

  it('이슈 코드 목록에 cover_save_failed와 duplicate_pole_key가 있다', () => {
    expect(api).toContain('`cover_save_failed`')
    expect(api).toContain('`duplicate_pole_key`')
  })

  it('오류 표에 503 feature_unavailable 행이 있다', () => {
    expect(api).toMatch(/^\| 503 \| `feature_unavailable` \|/m)
  })
})

describe('packages/cli/README.md', () => {
  it('공통 필드 표에 cover가 있다', () => {
    const readme = readRepoFile('packages', 'cli', 'README.md')
    expect(readme).toMatch(/^\| `cover` \|/m)
  })
})

// README 세 언어는 같은 내용을 말해야 한다 — 한 언어에만 있는 절은 나머지 언어 사용자에게 없는 기능이 된다.
describe('세 언어 README', () => {
  const readmes = {
    en: readRepoFile('README.md'),
    ko: readRepoFile('README.ko.md'),
    ja: readRepoFile('README.ja.md'),
  } as const
  type Lang = keyof typeof readmes
  const langs = Object.keys(readmes) as Lang[]

  function mcpSection(text: string): string {
    const match = text.match(/^## MCP[^\n]*\n([\s\S]*?)(?=^## )/m)
    return match ? match[1] : ''
  }

  it('packages/cli README(영어) 링크의 언어 표기가 실제와 맞다', () => {
    const lineOf = (lang: Lang) => readmes[lang].split('\n').find((l) => l.includes('](packages/cli/README.md)')) ?? ''
    expect(lineOf('en')).not.toMatch(/Korean/)
    expect(lineOf('ja')).not.toContain('韓国語')
    expect(lineOf('ja')).toContain('英語')
    expect(lineOf('ko')).toContain('영어')
  })

  it.each(langs)('%s: MCP 절에 도구 네 개, 클라이언트 설정 세 가지, 로컬 서버 예시가 있다', (lang) => {
    const section = mcpSection(readmes[lang])
    expect(section).not.toBe('')
    for (const needle of [
      'get_guide',
      'validate_quiz',
      'publish_quiz',
      'list_my_quizzes',
      'includeOwnerUrls',
      'claude mcp add letsplayquiz -- npx -y letsplayquiz-mcp',
      'claude_desktop_config.json',
      '.cursor/mcp.json',
      'LETSPLAYQUIZ_API',
      'packages/mcp/README.md',
    ]) {
      expect(section, `${lang} MCP 절에 ${needle}`).toContain(needle)
    }
  })

  it('MCP 절의 코드 블록 수가 세 언어에서 같다', () => {
    const fences = (lang: Lang) => (mcpSection(readmes[lang]).match(/^```/gm) ?? []).length
    expect(fences('ko')).toBeGreaterThan(0)
    expect(fences('en')).toBe(fences('ko'))
    expect(fences('ja')).toBe(fences('ko'))
  })

  it.each(langs)('%s: 발행이 타임아웃·전송 오류로 끝나면 재시도하지 말고 사용자에게 묻는다는 경고가 있다', (lang) => {
    const marker = { en: /timeout/i, ko: /타임아웃/, ja: /タイムアウト/ }[lang]
    expect(mcpSection(readmes[lang])).toMatch(marker)
  })

  it.each(langs)('%s: pnpm smoke 설명이 MCP 서버도 돈다고 말한다', (lang) => {
    const line = readmes[lang].split('\n').find((l) => l.includes('pnpm smoke')) ?? ''
    expect(line).toContain('MCP')
  })
})
