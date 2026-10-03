import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { vi } from 'vitest'
import { createServer } from './server.js'

describe('createServer', () => {
  it('네 도구와 어노테이션을 등록한다', async () => {
    const server = createServer(
      { api: 'https://example.test', ua: 'ua', store: { env: {} as NodeJS.ProcessEnv, homedir: () => '/nonexistent-home' } },
      '0.0.0',
    )
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    await Promise.all([server.connect(a), client.connect(b)])
    const { tools } = await client.listTools()
    const by = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(Object.keys(by).sort()).toEqual(['get_guide', 'list_my_quizzes', 'publish_quiz', 'validate_quiz'])
    expect(by.get_guide.annotations?.readOnlyHint).toBe(true)
    expect(by.validate_quiz.annotations?.readOnlyHint).toBe(true)
    expect(by.list_my_quizzes.annotations?.readOnlyHint).toBe(true)
    expect(by.publish_quiz.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
    expect(by.publish_quiz.description).toContain('PUBLIC')
    expect(by.publish_quiz.description).toContain('Confirm with the user')
    await client.close()
  })

  it('progressToken이 있으면 publish 중 진행 알림을 보낸다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 80))
        return new Response(JSON.stringify({ ok: true, slug: 's', url: 'https://e.test/t/s', ownerUrl: 'https://e.test/owner/T' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    try {
      const server = createServer(
        { api: 'https://example.test', ua: 'ua', store: { env: {} as NodeJS.ProcessEnv, homedir: () => '/nonexistent-home' } },
        '0.0.0',
        { progressIntervalMs: 10 },
      )
      const [a, b] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 't', version: '0' })
      await Promise.all([server.connect(a), client.connect(b)])
      let progress = 0
      const r = await client.callTool(
        { name: 'publish_quiz', arguments: { quiz: { kind: 'balance', title: 't' }, save: false } },
        undefined,
        { onprogress: () => progress++ },
      )
      expect(r.isError).toBeFalsy()
      expect(progress).toBeGreaterThanOrEqual(1)
      await client.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('list_my_quizzes는 includeOwnerUrls 입력을 가지며 기본 false다', async () => {
    const server = createServer(
      { api: 'https://example.test', ua: 'ua', store: { env: {} as NodeJS.ProcessEnv, homedir: () => '/nonexistent-home' } },
      '0.0.0',
    )
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '0' })
    await Promise.all([server.connect(a), client.connect(b)])
    const { tools } = await client.listTools()
    const list = tools.find((t) => t.name === 'list_my_quizzes')
    const prop = (list?.inputSchema.properties as Record<string, { default?: unknown }>).includeOwnerUrls
    expect(prop.default).toBe(false)
    await client.close()
  })
})
