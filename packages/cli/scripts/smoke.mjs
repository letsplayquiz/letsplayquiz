#!/usr/bin/env node
// 빌드된 dist/bin.js를 실제 프로세스로 실행해 npm/npx가 만드는 심볼릭 링크
// 시나리오를 재현한다. 단위 테스트는 `run(argv, io)`를 직접 부르기 때문에
// "실행 파일 진입점이 실제로 동작하는가"는 여기서만 검증된다(SWE-19 리뷰
// 1번 항목 — 심볼릭 링크로 실행하면 아무 것도 안 하고 exit 0으로 끝나던
// 버그의 회귀 방지).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import net from 'node:net'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const distBin = path.join(here, '..', 'dist', 'bin.js')

/** 실제로 열려 있지 않은 포트를 얻는다. `127.0.0.1:1`은 "금지 포트"라 fetch가
 * 연결을 시도조차 하지 않고 즉시 거부하는 경로라(2026-09-26 세 번째 리뷰
 * 지적) — 진짜 "연결 거부(ECONNREFUSED)" 경로를 타려면 한 번 리슨했다가 바로
 * 닫은, 정상 범위의 포트를 써야 한다. */
async function getUnusedPort() {
  const probe = net.createServer()
  const port = await new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => resolve(probe.address().port))
  })
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'letsplayquiz-smoke-'))
  try {
    const linkPath = path.join(tmp, 'letsplayquiz-link.js')
    await symlink(distBin, linkPath)

    // 1) 심볼릭 링크로 실행한 --version이 버전을 찍고 exit 0인지.
    const versionResult = await execFileAsync(process.execPath, [linkPath, '--version'])
    if (!/^\d+\.\d+\.\d+\s*$/.test(versionResult.stdout)) {
      throw new Error(`--version 출력이 이상해요: ${JSON.stringify(versionResult.stdout)}`)
    }
    console.log('OK  --version (심볼릭 링크로 실행):', versionResult.stdout.trim())

    // 2) 안 쓰는 포트(연결 거부, ECONNREFUSED) → exit 4.
    const unusedPort = await getUnusedPort()
    let failed = false
    try {
      await execFileAsync(process.execPath, [linkPath, 'guide', '--api', `http://127.0.0.1:${unusedPort}`])
    } catch (e) {
      failed = true
      if (e.code !== 4) throw new Error(`연결 거부인데 종료 코드가 4가 아니에요: ${e.code}`)
    }
    if (!failed) throw new Error('연결할 수 없는 서버인데 성공(exit 0)했어요')
    console.log('OK  guide --api (안 쓰는 포트, 연결 거부) → exit 4')

    // 3) 큰 응답을 파이프로 받아도 process.exit()에 잘리지 않는지.
    const bigBody = '#'.repeat(200_000)
    const bigServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/markdown' })
      res.end(bigBody)
    })
    await new Promise((resolve) => bigServer.listen(0, '127.0.0.1', resolve))
    try {
      const port = bigServer.address().port
      const big = await execFileAsync(
        process.execPath,
        [linkPath, 'guide', '--api', `http://127.0.0.1:${port}`],
        { maxBuffer: 10 * 1024 * 1024 },
      )
      if (big.stdout.length < bigBody.length) {
        throw new Error(`출력이 잘렸어요: ${big.stdout.length} < ${bigBody.length}`)
      }
      console.log('OK  200KB 응답이 잘리지 않고 그대로 나옴:', big.stdout.length, 'bytes')
    } finally {
      await new Promise((resolve) => bigServer.close(resolve))
    }

    // 4) 로컬 서버가 요청 본문을 다 읽고 나서 소켓을 끊으면(연결은 됐다) —
    // "확실히 발행 안 됨"인 4가 아니라 "결과 불명"인 5여야 한다.
    const dropServer = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.socket?.destroy()
      })
    })
    await new Promise((resolve) => dropServer.listen(0, '127.0.0.1', resolve))
    try {
      const port = dropServer.address().port
      const testFile = path.join(tmp, 'test.json')
      await writeFile(testFile, JSON.stringify({ kind: 'balance', title: '스모크 테스트' }))
      let publishFailed = false
      try {
        await execFileAsync(process.execPath, [linkPath, 'publish', testFile, '--api', `http://127.0.0.1:${port}`])
      } catch (e) {
        publishFailed = true
        if (e.code !== 5) throw new Error(`본문 읽고 끊었는데 종료 코드가 5가 아니에요: ${e.code}`)
      }
      if (!publishFailed) throw new Error('연결이 끊겼는데 성공(exit 0)했어요')
      console.log('OK  publish (본문 읽고 소켓 끊김) → exit 5')
    } finally {
      await new Promise((resolve) => dropServer.close(resolve))
    }

    // 5) 본 패키지(letsplayquiz)의 npm pack --dry-run 파일 목록에 bin이
    // 가리키는 dist/bin.js가 있는지(스펙 §7.3, §10). 이건 빌드 산출물이
    // 있어야 의미가 있어서 vitest가 아니라 여기서 확인한다.
    const cliDir = path.join(here, '..')
    const { stdout: packOut } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], { cwd: cliDir })
    const [packResult] = JSON.parse(packOut)
    if (!packResult.files.some((f) => f.path === 'dist/bin.js')) {
      throw new Error('letsplayquiz npm pack 파일 목록에 dist/bin.js가 없어요')
    }
    console.log('OK  letsplayquiz npm pack --dry-run 파일 목록에 dist/bin.js가 있음')

    // 6) 연결 패키지 packages/lpqz/bin.js를 실행하면 본 CLI와 같은 결과가
    // 나오는지(스펙 §7.3, §10 — "연결 패키지를 실행하면 본 CLI와 같은
    // 결과가 나온다(스모크)"). 빌드 없이 저장소에 그대로 커밋된 파일이라
    // dist/bin.js가 이미 있으면 바로 실행할 수 있다.
    const lpqzBin = path.join(here, '..', '..', 'lpqz', 'bin.js')
    const lpqzVersion = await execFileAsync(process.execPath, [lpqzBin, '--version'])
    if (lpqzVersion.stdout !== versionResult.stdout) {
      throw new Error(
        `lpqz --version이 본 CLI와 달라요: ${JSON.stringify(lpqzVersion.stdout)} !== ${JSON.stringify(versionResult.stdout)}`,
      )
    }
    console.log('OK  packages/lpqz/bin.js --version이 본 CLI와 같음:', lpqzVersion.stdout.trim())
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }

  console.log('스모크 테스트 통과')
}

main().catch((e) => {
  console.error('스모크 테스트 실패:', e.message)
  process.exitCode = 1
})
