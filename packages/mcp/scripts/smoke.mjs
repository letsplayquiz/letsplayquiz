#!/usr/bin/env node
// 빌드된 dist/bin.js를 실제 stdio 프로세스로 띄워 SDK Client로 붙는다. 서버 쪽은
// 로컬 http 스텁이라 네트워크가 필요 없다. 도구 4개와 어노테이션, get_guide와
// validate_quiz 호출, 잘못된 LETSPLAYQUIZ_API로 즉시 종료하는 것을 확인한다.
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const distBin = path.join(here, '..', 'dist', 'bin.js')

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/api/v1/guide') {
    res.end(JSON.stringify({ kind: url.searchParams.get('kind'), format: url.searchParams.get('format') }))
  } else if (url.pathname === '/api/v1/tests/validate') {
    req.resume()
    req.on('end', () => res.end(JSON.stringify({ ok: true, warnings: [] })))
  } else {
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'nope' } }))
  }
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const api = `http://127.0.0.1:${stub.address().port}`

try {
  // 1) 잘못된 LETSPLAYQUIZ_API면 즉시 종료(exit 2)하고 stderr에 이유를 남긴다.
  const bad = spawnSync(process.execPath, [distBin], {
    env: { ...process.env, LETSPLAYQUIZ_API: 'http://example.com' },
    encoding: 'utf8',
    input: '',
  })
  assert(bad.status === 2, `잘못된 API인데 종료 코드가 2가 아니에요: ${bad.status}`)
  assert(bad.stderr.includes('LETSPLAYQUIZ_API'), 'stderr에 LETSPLAYQUIZ_API 안내가 없어요')
  assert(bad.stdout === '', 'stdout에 아무것도 쓰면 안 돼요')
  console.log('OK  잘못된 LETSPLAYQUIZ_API → exit 2, stdout 비어 있음')

  // 2) 정상 서버에 붙어 도구를 확인한다.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distBin],
    env: { ...process.env, LETSPLAYQUIZ_API: api },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'smoke', version: '0.0.0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    assert(
      JSON.stringify(names) === JSON.stringify(['get_guide', 'list_my_quizzes', 'publish_quiz', 'validate_quiz']),
      `도구 목록이 이상해요: ${names}`,
    )
    const by = Object.fromEntries(tools.map((t) => [t.name, t]))
    for (const n of ['get_guide', 'validate_quiz', 'list_my_quizzes']) {
      assert(by[n].annotations?.readOnlyHint === true, `${n}은 readOnlyHint여야 해요`)
    }
    const p = by.publish_quiz.annotations ?? {}
    assert(
      p.readOnlyHint === false && p.destructiveHint === false && p.idempotentHint === false && p.openWorldHint === true,
      `publish_quiz 어노테이션이 이상해요: ${JSON.stringify(p)}`,
    )
    console.log('OK  tools/list: 4개 도구와 어노테이션')

    const guide = await client.callTool({ name: 'get_guide', arguments: { kind: 'balance', lang: 'en' } })
    assert(!guide.isError, 'get_guide가 오류를 냈어요')
    assert(
      guide.structuredContent?.kind === 'balance' && guide.structuredContent?.format === 'json',
      `get_guide 결과가 이상해요: ${JSON.stringify(guide.structuredContent)}`,
    )
    console.log('OK  get_guide → format=json&kind=balance 로 스텁 호출')

    const validated = await client.callTool({
      name: 'validate_quiz',
      arguments: { quiz: { kind: 'balance', title: 'smoke' } },
    })
    assert(!validated.isError && validated.structuredContent?.ok === true, 'validate_quiz가 ok여야 해요')
    console.log('OK  validate_quiz → ok:true')
  } finally {
    await client.close()
  }
} finally {
  await new Promise((resolve) => stub.close(resolve))
}
console.log('MCP 스모크 테스트 통과')
