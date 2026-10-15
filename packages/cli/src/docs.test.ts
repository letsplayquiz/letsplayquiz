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
