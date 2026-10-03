import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
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
})
