/**
 * UI 组件运行时冒烟（jsdom + react-dom 真渲染）：结构/交互契约不再靠源码字符串钉。
 * 覆盖共享原语：Notice/useNotice（提示条 + 自动收口）、TabStrip（切页契约）、
 * ScopeRow（目录/配置域行）、MemoryItemRow（.card 基座组合）。
 * 运行：npm run smoke:ui
 */
import './ui-env'
import { domWindow } from './ui-env'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactElement } from 'react'
import { Notice, useNotice, type NoticeState } from '../src/components/common/Notice'
import { TabStrip } from '../src/components/common/TabStrip'
import { ScopeRow } from '../src/components/common/ScopeRow'
import { MemoryItemRow } from '../src/components/memory/MemoryItemRow'
import { McpPanel } from '../src/components/workspace/McpPanel'
import { DeployTab } from '../src/components/workspace/DeployTab'
import { MemoryPanel } from '../src/components/memory/MemoryPanel'
import { UserMemorySection } from '../src/components/memory/UserMemorySection'
import { useAppStore } from '../src/store/useAppStore'
import type { MemoryItem } from '../src/types'
import type { DesktopAPI } from '../shared/desktop-api'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 挂载一个组件，返回容器与卸载器（act 内跑渲染/交互） */
function mount(el: ReactElement): { container: HTMLElement; root: Root } {
  const container = domWindow.document.createElement('div')
  domWindow.document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  return { container, root }
}

function unmount(root: Root, container: HTMLElement): void {
  act(() => { root.unmount() })
  container.remove()
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

const memItem: MemoryItem = {
  id: 'm1', projectKey: 'global', sessionId: null, tier: 'long', category: 'preference',
  title: '包管理器用 pnpm', content: '用户要求一律用 pnpm', sourceJson: null,
  importance: 0.7, accessCount: 0, lastAccessedAt: null, status: 'active',
  supersededBy: null, origin: 'user_explicit', archivedAt: null, archivedBy: null, archivedReason: null,
  createdAt: 1, updatedAt: 1,
}

async function main(): Promise<void> {
  console.log('Notice（ok/err 渲染 + 文案）：')
  {
    const ok = mount(<Notice notice={{ kind: 'ok', text: '保存成功' }} />)
    assert(ok.container.querySelector('.notice.notice--ok')?.textContent === '保存成功', 'ok 态类名与文案')
    unmount(ok.root, ok.container)
    const err = mount(<Notice notice={{ kind: 'err', text: '连接失败' }} />)
    assert(err.container.querySelector('.notice.notice--err')?.textContent === '连接失败', 'err 态类名与文案')
    unmount(err.root, err.container)
    const none = mount(<Notice notice={null} />)
    assert(none.container.innerHTML === '', 'notice=null 不渲染')
    unmount(none.root, none.container)
  }

  console.log('useNotice（自动收口——提示条不许粘屏）：')
  {
    const held: { snap: NoticeState | null; set: ((n: NoticeState | null) => void) | null } = { snap: null, set: null }
    function Probe() {
      const [notice, setNotice] = useNotice(5)
      held.snap = notice
      held.set = setNotice
      return <Notice notice={notice} />
    }
    const { container, root } = mount(<Probe />)
    act(() => { held.set!({ kind: 'ok', text: '动态提示' }) })
    assert(held.snap?.text === '动态提示' && container.querySelector('.notice') !== null, 'setNotice 即时上屏')
    // 异步 act：等定时器在 act 壳内 fire（否则 setState 在 act 外触发，React 出警告噪音）
    await act(async () => { await sleep(30) })
    assert(held.snap === null && container.querySelector('.notice') === null, '超时后自动收口（DOM 一并移除）')
    unmount(root, container)
  }

  console.log('TabStrip（tablist 语义 + 激活态 + 切换回调）：')
  {
    let active: string = 'a'
    let changed: string | null = null
    const items = [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }, { id: 'c', label: '丙' }]
    function Host() {
      return <TabStrip label="测试切页" active={active as 'a'} onChange={(id) => { changed = id }} items={items} />
    }
    const { container, root } = mount(<Host />)
    const strip = container.querySelector('.tab-strip[role="tablist"]')
    assert(strip !== null && strip.getAttribute('aria-label') === '测试切页', 'tablist 语义 + aria-label')
    const tabs = container.querySelectorAll('.tab-strip__btn')
    assert(tabs.length === 3, '三个切页项')
    assert(tabs[0].getAttribute('aria-selected') === 'true' && tabs[0].className.includes('tab-underline--active'), '激活项 aria-selected + 类名（.tab-underline 共享激活态）')
    assert(tabs[1].getAttribute('aria-selected') === 'false', '非激活项不选中')
    click(tabs[1])
    assert(changed === 'b', '点击触发 onChange(目标 id)')
    unmount(root, container)
  }

  console.log('ScopeRow（徽章/可选移除/选中回调——调用方不传假 props）：')
  {
    let selected = 0
    let removed = 0
    const { container, root } = mount(
      <ScopeRow
        row={{ dir: 'D:/proj/skills', kind: 'project', badge: '3', removable: true, removeTitle: '移除目录' }}
        active
        onSelect={() => { selected++ }}
        onRemove={() => { removed++ }}
        extraClass="mcp-panel__scope--off"
      />,
    )
    const row = container.querySelector('.skills-panel__dir')
    assert(row !== null && row.className.includes('skills-panel__dir--active'), '激活态类名')
    assert(row!.className.includes('mcp-panel__scope--off'), 'extraClass 透传')
    assert(row!.querySelector('.skills-panel__dir-badge')?.textContent === '3', '徽章渲染')
    assert((row!.querySelector('.skills-panel__dir-name')?.textContent ?? '').endsWith('proj/skills'), '目录名取末两级')
    click(row!)
    assert(selected === 1, '行点击触发 onSelect')
    const rm = row!.querySelector('button')
    assert(rm !== null && rm.getAttribute('aria-label') === '移除目录', '可移除 → 渲染移除钮 + aria-label')
    click(rm!)
    assert(removed === 1 && selected === 1, '移除钮独立回传（不冒泡到 onSelect）')
    unmount(root, container)

    const noRemove = mount(
      <ScopeRow row={{ dir: '全局', kind: 'global' }} active={false} onSelect={() => {}} />,
    )
    assert(noRemove.container.querySelector('button') === null, '不提供 onRemove → 无移除钮（无假 props）')
    unmount(noRemove.root, noRemove.container)
  }

  console.log('McpPanel（复合面板：ScopeRow 复用 + 卡片组合 + 失败错误独立成行）：')
  {
    const testCalls: string[] = []
    // 假 desktopAPI：挂载即 getConfig；测试失败且错误多行（钉「错误信息另起一行」契约）
    domWindow.desktopAPI = {
      getConfig: async () => ({ mcpServers: { fake: { command: 'node', args: ['srv.js'] } }, mcpServersMap: {} }),
      mcpTestState: async () => ({
        'global::fake': { ok: true, tools: [{ name: 'a', description: '' }, { name: 'b', description: '' }], testedAt: 1 },
      }),
      mcpTest: async (name: string) => {
        testCalls.push(name)
        return { ok: false, tools: [], error: 'spawn node ENOENT\n第二行：检查安装' }
      },
    } as unknown as DesktopAPI
    const { container, root } = mount(<McpPanel />)
    await act(async () => { await sleep(10) })
    assert(container.querySelectorAll('.card.mcp-panel__row').length === 1, 'server 行渲染（组合 .card 基座）')
    assert(container.querySelectorAll('.skills-panel__dir').length === 2, '配置域行 ×2 经 ScopeRow 渲染')
    // 持久化契约：进程级既有结果挂载即显（切换切片/重开面板不回「未测试」）
    assert(container.querySelector('.mcp-panel__status')?.textContent === '已连接 · 2 工具', '挂载即显进程级测试结果（不回未测试）')
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '测试')
    click(btn!)
    await act(async () => { await sleep(10) })
    assert(testCalls.includes('fake'), '点击触发 mcpTest')
    const err = container.querySelector('.mcp-panel__error')
    assert((err?.textContent ?? '').includes('spawn node ENOENT'), '失败错误另起一行（.mcp-panel__error）')
    assert((err?.textContent ?? '').includes('第二行'), '多行错误全文展示（不截 60 字）')
    assert(container.querySelector('.mcp-panel__status')?.textContent === '测试失败', '状态槽只留短标签')
    click(container.querySelector('.mcp-panel__row')!)
    const detail = container.querySelector('[role="dialog"]')
    assert(detail?.getAttribute('aria-label')?.endsWith('详情') === true, '整卡点击 → 只读详情弹窗')
    assert(!detail?.textContent?.includes('保存'), '详情弹窗只读（无保存动作）')
    assert(!!detail?.textContent?.includes('node srv.js'), '详情展示启动命令（配置字段）')
    click(detail!.querySelector('button[aria-label="关闭"]')!)
    click([...container.querySelectorAll('button')].find((b) => b.textContent === '编辑')!)
    assert(container.querySelector('[role="dialog"]')?.textContent?.includes('保存') === true, '编辑钮 → 编辑弹窗（带保存）')
    unmount(root, container)
    domWindow.desktopAPI = {} as unknown as DesktopAPI
  }

  console.log('DeployTab（复合面板：skill-card 组合 + 空态 + notice 独立成行）：')
  {
    domWindow.desktopAPI = {
      deployListServers: async () => [],
      onConfigChanged: () => () => {},
    } as unknown as DesktopAPI
    const { container, root } = mount(<DeployTab />)
    await act(async () => { await sleep(10) })
    assert(!!container.textContent?.includes('未打开项目'), '无项目空态（发布数据是项目级）')
    assert(container.querySelector('button')?.disabled === true, '无项目时添加按钮禁用')
    unmount(root, container)

    domWindow.desktopAPI = {
      deployListServers: async () => ([{ id: 's1', name: 'prod', host: '1.2.3.4', port: 22, username: 'root', auth: 'password', tags: [], strategy: 'single' }]),
      onConfigChanged: () => () => {},
    } as unknown as DesktopAPI
    useAppStore.setState({ projectPath: 'D:/proj' })
    const withCard = mount(<DeployTab />)
    await act(async () => { await sleep(10) })
    click(withCard.container.querySelector('.deploy-card')!)
    const srvDetail = withCard.container.querySelector('[role="dialog"]')
    assert(srvDetail?.getAttribute('aria-label')?.endsWith('详情') === true, '整卡点击 → 只读服务器详情')
    assert(!!srvDetail?.textContent?.includes('1.2.3.4'), '详情含主机信息')
    unmount(withCard.root, withCard.container)
    useAppStore.setState({ projectPath: null })
    domWindow.desktopAPI = {} as unknown as DesktopAPI
  }

  console.log('MemoryPanel（复合面板：MemoryItemRow 网格 + 写操作禁用态）：')
  {
    domWindow.desktopAPI = {
      memoryList: async () => ({ items: [{ ...memItem, id: 'p1', projectKey: 'proj-hash' }] }),
      memoryStats: async () => ({ total: 1, byTier: { long: 1 }, byCategory: {}, embedReady: true, vecAvailable: true, dbBytes: 0, distillTokens: { input: 0, output: 0 } }),
      memoryLastTidy: async () => null,
      memoryExtracting: async () => true,
      onMemoryChanged: () => () => {},
      onMemoryExtractState: () => () => {},
    } as unknown as DesktopAPI
    useAppStore.setState({ activeTab: 'memory', projectPath: 'D:/proj' })
    const { container, root } = mount(<MemoryPanel />)
    await act(async () => { await sleep(15) })
    assert(container.querySelectorAll('.card.memory__item').length === 1, '记忆行渲染（.card 组合，项目域条目）')
    const editBtn = container.querySelector('button[aria-label="编辑"]') as HTMLButtonElement | null
    assert(editBtn?.disabled === true, '整理中 → 写操作禁用（readOnly 透传）')
    unmount(root, container)
    useAppStore.setState({ activeTab: 'files', projectPath: null })
    domWindow.desktopAPI = {} as unknown as DesktopAPI
  }

  console.log('UserMemorySection（复合面板：全局记忆 + notice 通道）：')
  {
    domWindow.desktopAPI = {
      memoryList: async () => ({ items: [memItem] }),
      memoryStats: async () => ({ total: 1, byTier: { long: 1 }, byCategory: {}, embedReady: true, vecAvailable: true, dbBytes: 0 }),
      memoryLastTidy: async () => null,
      memoryExtracting: async () => false,
      onMemoryChanged: () => () => {},
    } as unknown as DesktopAPI
    const { container, root } = mount(<UserMemorySection />)
    await act(async () => { await sleep(15) })
    assert(container.querySelectorAll('.memory__item').length === 1, '全局记忆行渲染')
    unmount(root, container)
    domWindow.desktopAPI = {} as unknown as DesktopAPI
  }

  console.log('MemoryItemRow（.card 基座组合 + 列表项语义）：')
  {
    const { container, root } = mount(
      <MemoryItemRow item={memItem} onDetail={() => {}} onEdit={() => {}} onDelete={() => {}} />,
    )
    const row = container.querySelector('.memory__item')
    assert(row !== null && row.className.includes('card'), '组合 .card 基座（chrome 不自带）')
    assert(row!.getAttribute('role') === 'listitem' && row!.getAttribute('data-tier') === 'long', 'listitem 语义 + tier 标记')
    assert(row!.querySelector('.memory__item-title')?.textContent === '包管理器用 pnpm', '标题渲染')
    unmount(root, container)

    let details = 0
    let edits = 0
    let deletes = 0
    const clickMe = mount(
      <MemoryItemRow item={memItem} onDetail={() => { details++ }} onEdit={() => { edits++ }} onDelete={() => { deletes++ }} />,
    )
    click(clickMe.container.querySelector('.memory__item-head')!)
    assert(details === 1 && edits === 0, '整卡点击 → 只读详情（不是编辑态）')
    click(clickMe.container.querySelector('button[aria-label="删除"]')!)
    assert(deletes === 1 && details === 1, '删除钮独立回传（不冒泡到整卡点击）')
    unmount(clickMe.root, clickMe.container)

    const locked = mount(
      <MemoryItemRow item={memItem} onDetail={() => { details++ }} onEdit={() => { edits++ }} onDelete={() => {}} readOnly />,
    )
    click(locked.container.querySelector('.memory__item')!)
    assert(details === 2 && edits === 0, '整理中只读 → 仍可查看（详情不受写门控）')
    unmount(locked.root, locked.container)
  }

  // jsdom 窗口 / React 调度器是常驻 handle，不显式收场进程不退（断言全过也会挂住管道）
  act(() => { /* final flush */ })
  domWindow.close()
  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
  process.exit(0)
}

void main()
