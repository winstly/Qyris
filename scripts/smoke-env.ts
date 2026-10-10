/**
 * 子进程环境构建冒烟测试：PATH 重建（注册表/登录 shell 探测解析）、命令检测、首 token 提取。
 * 运行：npm run smoke:env
 */
import { detectCommand, firstToken } from '../electron/lib/proc'
import { buildChildEnv, parseProbedPath } from '../electron/lib/proc-env'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

console.log('parseProbedPath（标记定位解析）：')
assert(parseProbedPath('noise echo stuff\n__QYRIS_PATH__/usr/bin:/bin') === '/usr/bin:/bin', 'profile 噪声输出后取标记行')
assert(parseProbedPath('__QYRIS_PATH__/opt/homebrew/bin') === '/opt/homebrew/bin', '无换行结尾')
assert(parseProbedPath('__QYRIS_PATH__/a\nAFTER_NOISE') === '/a', '标记行后噪声被截断')
assert(parseProbedPath('no marker here') === null, '无标记返回 null')
assert(parseProbedPath('__QYRIS_PATH__   ') === null, '空 PATH 返回 null')
assert(parseProbedPath(undefined) === null, 'undefined 返回 null')

console.log('buildChildEnv（真实环境）：')
process.env.QYRIS_SSH_CRED_smoke = 'secret'
process.env.QYRIS_HOST_TOOL_TOKEN = 'bridge-token'
process.env.QYRIS_HOST_TOOL_PORT = '12345'
const env = buildChildEnv()
const p = env.PATH ?? ''
assert(p.length > 0, 'PATH 非空')
if (process.platform === 'win32') {
  assert(/windows\\system32/i.test(p), '包含 HKLM 注册表系统目录（注册表重建生效）')
}
assert(env.QYRIS_SSH_CRED_smoke === undefined, 'SSH 凭据注入键被剥离')
assert(env.QYRIS_HOST_TOOL_TOKEN === undefined, '代行通道令牌被剥离')
assert(env.QYRIS_HOST_TOOL_PORT === undefined, '代行通道端口被剥离')
delete process.env.QYRIS_SSH_CRED_smoke
delete process.env.QYRIS_HOST_TOOL_TOKEN
delete process.env.QYRIS_HOST_TOOL_PORT

async function main(): Promise<void> {
  console.log('detectCommand：')
  // detectCommand 是异步探测：必须 await 后再比（拿 Promise 直接 === 恒为 false）
  assert((await detectCommand('npm --version')) === true, 'npm 可找到')
  assert((await detectCommand('qyris_definitely_missing_9137 --x')) === false, '乱串命令判缺失')
  assert((await detectCommand('dir')) === true, 'cmd 内建命令白名单放行')
  assert((await detectCommand('')) === null, '空命令返回 null（不阻塞）')

  console.log('firstToken：')
  assert(firstToken('npm run dev') === 'npm', '普通命令')
  assert(firstToken('"C:/Program Files/x/mvn.cmd" -q package') === 'C:/Program Files/x/mvn.cmd', '引号路径')
  assert(firstToken('  spaced  out ') === 'spaced', '前后空白')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

void main()
