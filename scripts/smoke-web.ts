/**
 * 网络检索工具冒烟测试：实体解码、URL 安全闸、HTML 转文本、Bing 结果解析。
 * 运行：npm run smoke:web
 */
import { assertAddrsSafe, assertSafeUrl, decodeEntities, htmlToText, httpGet, parseBingHtml } from '../electron/lib/webops'
import { allTools, getTool, toolsForPermission } from '../electron/lib/tools'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

/** 命中即抛；用于断言「必须拒绝」 */
function rejects(fn: () => unknown, label: string): void {
  try {
    fn()
    failures++
    console.error(`  FAIL ${label}（未拒绝）`)
  } catch {
    console.log(`  OK ${label}`)
  }
}

async function main(): Promise<void> {
  console.log('decodeEntities（实体单遍解码）：')
  assert(decodeEntities('a &amp; b') === 'a & b', '命名实体 amp')
  assert(decodeEntities('&lt;tag&gt;') === '<tag>', '命名实体 lt/gt')
  assert(decodeEntities('&#39;x&#39;') === "'x'", '十进制实体')
  assert(decodeEntities('&#x27;') === "'", '十六进制实体')
  assert(decodeEntities('&nbsp;') === ' ', 'nbsp → U+00A0')
  assert(decodeEntities('&ensp;') === ' ', 'ensp → U+2002')
  assert(decodeEntities('&emsp;') === ' ', 'emsp → U+2003')
  assert(decodeEntities('&thinsp;') === ' ', 'thinsp → U+2009')
  assert(decodeEntities('&mdash;') === '—', 'mdash')
  assert(decodeEntities('&unknownentity;') === '&unknownentity;', '未知命名实体原样保留')
  assert(decodeEntities('&#x110000;') === '&#x110000;', '非法码点原样保留')
  assert(decodeEntities('&#0;') === '&#0;', 'NUL 码点原样保留')
  assert(decodeEntities('&#xD800;') === '&#xD800;', '孤立代理项原样保留')
  assert(decodeEntities('&amp;lt;') === '&lt;', '双编码只解一层（不是 <）')
  assert(decodeEntities('&amp;amp;lt;') === '&amp;lt;', '三重编码只解一层')

  console.log('assertSafeUrl（协议与内网闸门）：')
  assert(assertSafeUrl('https://example.com/a').hostname === 'example.com', '公网 https 放行')
  assert(assertSafeUrl('http://example.com').protocol === 'http:', '公网 http 放行')
  rejects(() => assertSafeUrl('file:///etc/passwd'), 'file 协议拒绝')
  rejects(() => assertSafeUrl('data:text/plain,hi'), 'data 协议拒绝')
  rejects(() => assertSafeUrl('javascript:alert(1)'), 'javascript 协议拒绝')
  rejects(() => assertSafeUrl('https://user:pass@example.com'), '内嵌凭据拒绝')
  rejects(() => assertSafeUrl('http://localhost:8080/'), 'localhost 拒绝')
  rejects(() => assertSafeUrl('http://localhost./'), 'localhost. 拒绝')
  rejects(() => assertSafeUrl('http://foo.localhost/'), '*.localhost 拒绝')
  rejects(() => assertSafeUrl('http://127.0.0.1/'), '127.0.0.1 拒绝')
  rejects(() => assertSafeUrl('http://10.1.2.3/'), '10 段拒绝')
  rejects(() => assertSafeUrl('http://192.168.0.1/'), '192.168 段拒绝')
  rejects(() => assertSafeUrl('http://172.16.0.1/'), '172.16 段拒绝')
  rejects(() => assertSafeUrl('http://169.254.169.254/'), '链路本地/云 metadata 拒绝')
  rejects(() => assertSafeUrl('http://100.64.0.1/'), 'CGNAT 100.64 段拒绝')
  rejects(() => assertSafeUrl('http://[::1]/'), 'IPv6 回环拒绝')
  rejects(() => assertSafeUrl('http://[::ffff:127.0.0.1]/'), 'IPv4-mapped 回环拒绝')
  rejects(() => assertSafeUrl('http://[::ffff:7f00:1]/'), 'IPv4-mapped 十六进制形态拒绝')
  rejects(() => assertSafeUrl('http://[::ffff:a9fe:a9fe]/'), 'IPv4-mapped 169.254 云 metadata 拒绝')
  rejects(() => assertSafeUrl('http://[::7f00:1]/'), 'IPv4-compatible 回环拒绝')
  rejects(() => assertSafeUrl('http://[fec0::1]/'), 'IPv6 站点本地拒绝')
  rejects(() => assertSafeUrl('http://[ff02::1]/'), 'IPv6 组播拒绝')
  rejects(() => assertSafeUrl('http://[2002:7f00:1::]/'), '6to4 内嵌回环拒绝')
  rejects(() => assertSafeUrl('http://[64:ff9b::7f00:1]/'), 'NAT64 内嵌回环拒绝')
  rejects(() => assertSafeUrl('http://printer.local/'), '*.local 拒绝')
  rejects(() => assertSafeUrl('not-a-url'), '非法 URL 拒绝')

  console.log('assertAddrsSafe（解析结果闸门，堵 DNS 旁路）：')
  {
    // 稳定别名指向回环（localtest.me / nip.io 类）靠这里拦，字面闸门看不到
    rejects(() => assertAddrsSafe('localtest.me', [{ address: '127.0.0.1' }]), '别名解析到 127.0.0.1')
    rejects(() => assertAddrsSafe('localtest.me', [{ address: '::1' }]), '别名解析到 ::1')
    rejects(() => assertAddrsSafe('x', [{ address: '::ffff:7f00:1' }]), 'IPv4-mapped 解析结果')
    rejects(() => assertAddrsSafe('x', [{ address: '2002:7f00:1::' }]), '6to4 内嵌回环')
    rejects(() => assertAddrsSafe('x', [{ address: '64:ff9b::7f00:1' }]), 'NAT64 内嵌回环')
    rejects(() => assertAddrsSafe('x', [{ address: 'ff02::1' }]), '组播地址')
    rejects(() => assertAddrsSafe('x', [{ address: 'fec0::1' }]), '站点本地地址')
    rejects(() => assertAddrsSafe('x', [{ address: '1.2.3.4' }, { address: '10.0.0.1' }]), '批量中混入私网即整批拒绝')
    assertAddrsSafe('example.com', [{ address: '93.184.216.34' }])
    console.log('  OK 放行公网地址')
  }

  console.log('htmlToText（HTML → 纯文本）：')
  const doc = [
    '<html><head><title>  My &amp; Page  </title>',
    '<style>.x{color:red}</style><script>var a=1</script></head>',
    '<body><!-- comment --><nav><a href="/home">Home</a></nav>',
    '<header><h1>Real Heading</h1><span>by Author</span></header>',
    '<p>Para one with <a href="https://ex.com/l">a link</a> inside.</p>',
    '<p>Line A<br>Line B</p>',
    '<ul><li>item 1</li><li>item 2</li></ul>',
    '<footer>foot text</footer></body></html>',
  ].join('\n')
  const r = htmlToText(doc)
  assert(r.title === 'My & Page', 'title 提取并解码实体')
  assert(!r.text.includes('color:red'), 'style 整块丢弃')
  assert(!r.text.includes('var a=1'), 'script 整块丢弃')
  assert(!r.text.includes('comment'), '注释丢弃')
  assert(!r.text.includes('Home'), 'nav 整块丢弃')
  assert(!r.text.includes('foot text'), 'footer 整块丢弃')
  assert(r.text.includes('Real Heading'), 'header 内 H1 保留')
  assert(r.text.includes('by Author'), 'header 内署名保留')
  assert(r.text.includes('a link (https://ex.com/l)'), '链接转「文本 (URL)」')
  assert(r.text.includes('Line A\nLine B'), 'br 转换行')
  assert(r.text.includes('item 1'), 'li 文本保留')
  assert(!/\n{3,}/.test(r.text), '3+ 空行折叠')
  assert(htmlToText('<p>only &lt;b&gt; text</p>').text === 'only <b> text', '实体只解一层')
  assert(htmlToText('<p>a &lt; b</p>').text === 'a < b', '比较符实体解码')
  assert(htmlToText('<a href="#top">top</a>').text === 'top', '锚点链接只留文本')
  assert(htmlToText('').text === '', '空输入不抛')
  assert(htmlToText('<p>令 x<y 且 y>z</p>').text.includes('x<y 且 y>z'), '正文含 <y …> 不误删')
  assert(
    htmlToText('<p>select x<y and y>z from t</p>').text.includes('x<y and y>z'),
    'ASCII 正文 x<y and y>z 不误删',
  )
  assert(htmlToText('<p>if a<b then c>d</p>').text.includes('a<b then c>d'), '比较式正文不误删')
  assert(
    htmlToText('<a href="/docs/api" data-href="https://tracker.example/click">API</a>').text ===
      'API (/docs/api)',
    '链接只取真 href，忽略 data-href',
  )
  assert(
    htmlToText("<a href='https://ex.com/s'>single</a>").text === 'single (https://ex.com/s)',
    '单引号 href 可取',
  )
  assert(!htmlToText('<!doctype html><p>body</p>').text.includes('doctype'), 'doctype 丢弃')

  console.log('parseBingHtml（Bing 结果）：')
  const bing = [
    '<ol id="b_results">',
    '<li class="b_algo"><h2><a href="https://bing.example/one">One &amp; Only</a></h2>',
    '<div class="b_caption"><p class="b_lineclamp2">First snippet here</p></div></li>',
    '<li class="b_algo"><h2><a href="https://bing.example/two?x=1&amp;y=2">Two</a></h2>',
    '<p>Second snippet</p></li>',
    '</ol>',
  ].join('')
  const bingHits = parseBingHtml(bing)
  assert(bingHits.length === 2, '解析出 2 条')
  assert(bingHits[0].title === 'One & Only', '标题解码')
  assert(bingHits[0].url === 'https://bing.example/one', 'URL 提取')
  assert(bingHits[0].snippet === 'First snippet here', '摘要取 h2 后首个 p')
  assert(bingHits[1].url === 'https://bing.example/two?x=1&y=2', 'URL 内实体解码')
  assert(bingHits[1].snippet === 'Second snippet', '无 b_caption 仍能取摘要')
  const trick = parseBingHtml(
    '<li class="b_algo"><h2><a data-href="https://tracker" href="https://real.example/x">T</a></h2><p>s</p></li>',
  )
  assert(trick.length === 1 && trick[0].url === 'https://real.example/x', 'data-href 不抢真 href')
  const quoted = parseBingHtml(
    `<li class="b_algo"><h2><a href='https://real.example/y'>T2</a></h2><p>s2</p></li>`,
  )
  assert(quoted.length === 1 && quoted[0].url === 'https://real.example/y', '单引号 href 可取')

  console.log('注册表暴露面（runner / MCP / 提示词同源）：')
  {
    const all = allTools()
    const names = new Set(all.map((t) => t.name))
    assert(names.has('web_search') && names.has('web_fetch'), '两工具已注册进 ToolRegistry')
    assert(getTool('web_search')?.permission === 'readonly', 'web_search 只读档')
    assert(getTool('web_fetch')?.permission === 'readonly', 'web_fetch 只读档')
    const readonly = new Set(toolsForPermission('readonly').map((t) => t.name))
    assert(readonly.has('web_search') && readonly.has('web_fetch'), '最低权限档会话可暴露')
    assert(
      all.every((t) => t.name !== 'websearch' && t.name !== 'webfetch'),
      '无 snake_case 之外的同义注册名',
    )

    // 安全闸要在 execute 层收敛成 isError 结果（模型看到的是内容，不是抛错）
    const fetchTool = getTool('web_fetch')
    if (fetchTool) {
      const ctx = { projectRoot: null, permission: 'readonly' as const }
      const bad1 = await fetchTool.execute({ url: 'http://127.0.0.1:5173' }, ctx)
      assert(
        bad1.isError === true && bad1.content.includes('禁止访问本地/内网地址'),
        `execute 层拒绝本地地址（${bad1.content.split('\n')[1] ?? ''}）`,
      )
      const bad2 = await fetchTool.execute({ url: 'file:///etc/passwd' }, ctx)
      assert(
        bad2.isError === true && bad2.content.includes('仅支持 http/https'),
        'execute 层拒绝 file 协议',
      )
    }
  }

  console.log('联网探针（网络类失败跳过，其他失败计红）：')
  try {
    const search = getTool('web_search')
    const fetchTool = getTool('web_fetch')
    if (!search || !fetchTool) throw new Error('注册表缺少 web_search / web_fetch')

    /** 网络不可达才允许跳过；闸门/解析/HTTP 状态类失败是回归，必须计红 */
    const offline = (content: string): boolean =>
      content.includes('网络请求失败') || content.includes('超时') || content.includes('请求已被取消')

    // DNS 旁路回归：稳定别名解析到回环。字面闸门看不到 host，必须由连接期 lookup 拦
    try {
      await httpGet('http://localtest.me/', 'text/html', 8000)
      failures++
      console.error('  FAIL localtest.me 未被拒（DNS 旁路复活）')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('禁止访问本地/内网地址')) console.log('  OK localtest.me 解析到回环被拒（DNS 旁路已堵）')
      else if (offline(msg)) console.log(`  SKIP（离线：${msg}）`)
      else {
        failures++
        console.error(`  FAIL localtest.me 被拒但原因不对：${msg}`)
      }
    }

    const s = await search.execute({ query: 'example domain' }, { projectRoot: null, permission: 'readonly' })
    if (s.isError && offline(s.content)) console.log(`  SKIP（离线：${s.content.split('\n')[1] ?? s.content.split('\n')[0]}）`)
    else {
      assert(s.isError !== true, 'web_search 联网不报错')
      assert(s.content.startsWith('[web_search]'), '搜索结果带头')
      assert(/· 共 [1-9]\d* 条/.test(s.content), '搜索结果至少 1 条（0 条 = 解析回归）')
      assert(/https?:\/\//.test(s.content.split('\n').slice(1).join('\n')), '结果含链接行')
      console.log('  OK web_search 联网往返')
    }

    const f = await fetchTool.execute({ url: 'https://example.com' }, { projectRoot: null, permission: 'readonly' })
    if (f.isError && offline(f.content)) console.log(`  SKIP（离线：${f.content.split('\n')[1] ?? f.content.split('\n')[0]}）`)
    else {
      assert(f.isError !== true, 'web_fetch 联网不报错')
      assert(f.content.startsWith('[web_fetch]'), '抓页结果带头')
      assert(f.content.includes('---'), '抓页结果带分隔')
      const bodyPart = f.content.split('\n---\n')[1] ?? ''
      assert(/Example/i.test(bodyPart), '抓页正文可读（只验分隔后正文）')
      console.log('  OK web_fetch 联网往返')
    }
  } catch (e) {
    console.log(`  SKIP（离线：${e instanceof Error ? e.message : String(e)}）`)
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

void main()
