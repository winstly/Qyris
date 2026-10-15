/**
 * 技能描述解析冒烟：frontmatter description 在 LF/CRLF/多行/引号等形态下都不许丢。
 * 夹具 2 覆盖 CRLF 行切分（行正则须匹配得到）；夹具 3 覆盖 YAML 空值 key + 缩进续行。
 * 另含渲染/统型契约：CSS 布局规则（样式表即制品，grep 是正确层级）+ 源码结构锚
 * （导出/导入/不自写——不锚 className 模板串，类名增减不砸契约）。
 * 组件 DOM 行为（渲染/交互/自动收口）在 smoke:ui（jsdom 真渲染），此处不重复。
 * 运行：npm run smoke:skill-desc
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkills } from '../electron/lib/skills'

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  OK ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'qyris-skilldesc-'))

  // 夹具 1：LF + 带引号描述（含逗号/冒号/中文）
  mkdirSync(join(dir, 'lf-quoted'))
  writeFileSync(
    join(dir, 'lf-quoted', 'SKILL.md'),
    '---\nname: lf-quoted\ndescription: "带引号的描述，逗号,冒号:都在内。"\ntriggers: [a, b]\n---\n\n# 正文\n',
    'utf8',
  )
  // 夹具 2：CRLF + 描述（主 bug 回归）
  mkdirSync(join(dir, 'crlf-desc'))
  writeFileSync(
    join(dir, 'crlf-desc', 'SKILL.md'),
    '---\r\nname: crlf-desc\r\ndescription: CRLF 文件的描述必须可见\r\ntriggers: x\r\n---\r\n\r\n# 正文\r\n',
    'utf8',
  )
  // 夹具 3：空值 key + 缩进续行（YAML plain 多行标量）
  mkdirSync(join(dir, 'folded-desc'))
  writeFileSync(
    join(dir, 'folded-desc', 'SKILL.md'),
    '---\nname: folded-desc\ndescription:\n  这是缩进续行上的描述\n  会被折叠成一行\n---\n',
    'utf8',
  )
  // 夹具 4：无描述（渲染层兜底「（无描述）」）
  mkdirSync(join(dir, 'no-desc'))
  writeFileSync(join(dir, 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\n', 'utf8')
  // 夹具 5：triggers 空值 + 块序列（YAML list 形态）——不许折成单条垃圾串
  mkdirSync(join(dir, 'list-triggers'))
  writeFileSync(
    join(dir, 'list-triggers', 'SKILL.md'),
    '---\nname: list-triggers\ndescription: 列表形态触发词\ntriggers:\n  - deploy\n  - 发布\n---\n',
    'utf8',
  )

  console.log('夹具解析（LF / CRLF / 多行 / 无描述 / 列表触发词）：')
  const metas = await scanSkills(dir)
  const byId = new Map(metas.map((m) => [m.id, m]))
  assert(byId.get('lf-quoted')?.description === '带引号的描述，逗号,冒号:都在内。', 'LF 引号描述原样解析')
  assert(byId.get('crlf-desc')?.description === 'CRLF 文件的描述必须可见', 'CRLF 描述解析（主 bug 回归）')
  assert(byId.get('crlf-desc')?.name === 'crlf-desc', 'CRLF name 解析（不再掉回目录名）')
  assert(byId.get('crlf-desc')?.triggers?.[0] === 'x', 'CRLF triggers 解析')
  assert((byId.get('folded-desc')?.description ?? '').includes('这是缩进续行上的描述'), '空值 key + 缩进续行折叠')
  assert((byId.get('folded-desc')?.description ?? '').includes('会被折叠成一行'), '多行续行合并')
  assert(byId.get('no-desc')?.description === '', '无描述 → 空串（渲染层兜底）')
  const lt = byId.get('list-triggers')?.triggers ?? []
  assert(lt.includes('deploy') && lt.includes('发布') && lt.length === 2, `triggers 块序列解析为两条（实得 ${JSON.stringify(lt)}）`)

  console.log('真实技能目录回归（frontmatter 有 description 的不许解析为空）：')
  const realDir = join(homedir(), '.claude', 'skills')
  const real = await scanSkills(realDir)
  let checked = 0
  for (const m of real) {
    let raw = ''
    try {
      raw = readFileSync(join(realDir, m.id, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fm) continue
    if (!/^[ \t]*description[ \t]*:/m.test(fm[1])) continue
    checked++
    assert((m.description ?? '').length > 0, `真实 skill「${m.id}」description 非空`)
  }
  assert(checked > 0, `真实目录存在可断言样本（${checked} 个）`)

  console.log('渲染契约（塌陷家族全量：面板挤压 / 0 高塌陷都封死）：')
  const css = readFileSync(join(process.cwd(), 'src', 'styles', 'components.css'), 'utf8')
  const ext = readFileSync(join(process.cwd(), 'src', 'styles', 'extensions.css'), 'utf8')
  const descRules = [...css.matchAll(/\.skill-card__desc\s*\{([^}]*)\}/g)].map((m) => m[1])
  const v2Desc = descRules[descRules.length - 1] ?? ''
  assert(/-webkit-line-clamp:\s*3/.test(v2Desc), '长描述 3 行钳制截断（省略号）')
  assert(/height:\s*[\d.]+em/.test(v2Desc), 'desc 固定 3 行槽位（排版不随内容长短漂）')
  assert(/flex:\s*0 0 auto/.test(v2Desc), 'desc 不参与弹性伸缩（确定性排版）')
  const tagsRule = [...css.matchAll(/\.skill-card__tags\s*\{([^}]*)\}/g)].map((m) => m[1]).pop() ?? ''
  assert(/flex-wrap:\s*nowrap/.test(tagsRule), 'tags 单行钉死（节奏不随 tag 数量漂）')
  assert(/\.skills-panel__search\s*\{[^}]*flex:\s*0 0/.test(css), '搜索框定宽（不被同行按钮挤变形）')
  const actionRules = [...css.matchAll(/\.skill-card__actions\s*\{([^}]*)\}/g)].map((m) => m[1])
  assert(actionRules.some((r) => /position:\s*absolute/.test(r)), '删除钮出布局流（全局/项目头行高度一致）')
  const dirRemoveRule = /\.skills-panel__dir-remove\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert(/position:\s*absolute/.test(dirRemoveRule), '目录行移除钮出布局流（行排版一致）')
  assert(!/transform:/.test(dirRemoveRule), '移除钮居中不用 transform（让位给按压态 scale，防按下跳动）')
  assert(/padding-right:\s*30px/.test([...css.matchAll(/\.skill-card__head\s*\{([^}]*)\}/g)].map((m) => m[1]).pop() ?? ''), '卡头预留钮槽（标题宽度两态一致）')
  // 卡片语言收编：chrome 收敛在 .card 基座一处，记忆/MCP/技能卡 JSX 组合取用（grid 墙 + 卡面 + hover 浮起 + meta 贴底）
  const cardBase = /\.card\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const cardHover = /\.card:hover\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert(
    /var\(--radius-card\)/.test(cardBase) && /var\(--card-bg\)/.test(cardBase) && /translateY/.test(cardHover),
    '卡面 chrome 单一来源（.card 基座：圆角/卡面/hover 浮起）',
  )
  const tabBase = /\.tab-underline\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const tabBtn = /\.tab-strip__btn\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert(
    /border-bottom: 2px solid transparent/.test(tabBase) && !/color:/.test(tabBtn) && !/border-bottom:/.test(tabBtn),
    '下划线 tab chrome 单一来源（.tab-underline 基座，布局类不带 chrome）',
  )
  const memList = /\.memory__list\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert(/display:\s*grid/.test(memList), '记忆列表为卡片网格（与技能卡同族）')
  const memRowSrc = readFileSync(join(process.cwd(), 'src', 'components', 'memory', 'MemoryItemRow.tsx'), 'utf8')
  assert(memRowSrc.includes('card memory__item'), '记忆条目组合 .card 基座（chrome 不自带）')
  assert(/\.memory__item-meta\s*\{[^}]*margin-top:\s*auto/.test(css), '记忆 meta 贴底（排版不漂）')
  const mcpRow = /\.mcp-panel__row\s*\{([^}]*)\}/.exec(ext)?.[1] ?? ''
  assert(!/var\(--card-bg\)/.test(mcpRow), 'MCP 行不再自带 chrome（走 .card 基座）')
  assert(
    /\.mcp-panel > \.emptystate/.test(css) && /\.skills-panel__list > \.emptystate/.test(css) && /\.skills-panel > \.emptystate/.test(css),
    '空态紧凑卡覆盖技能/MCP 挂载点（漏挂载点会回落 flex:1 铺满整块）',
  )
  assert(
    /\.memory__list:has\(> \.emptystate\)/.test(css) && /justify-self:\s*center/.test(css),
    '空态卡双轴居中（网格行 align-content 归中 + 行内居中）',
  )
  // 定高只挂技能卡作用域：deploy-card 复用 skill-card 语言（host/策略/按钮更高），基类定高会裁按钮
  const scoped = /\.skills-panel__list \.skill-card\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert(/height:\s*\d+px/.test(scoped), '技能卡定高（不被面板/网格行挤压）')
  const baseCard = [...css.matchAll(/^\s*\.skill-card\s*\{([^}]*)\}/gm)].map((m) => m[1]).pop() ?? ''
  assert(!/height:/.test(baseCard), 'skill-card 基类不定高（deploy-card 不被误伤）')
  // 塌陷家族：纵向 flex 滚动容器里的消息/行/卡一律关收缩（矮了就滚，不许压扁）
  assert(/\.msg\s*\{[^}]*flex-shrink:\s*0/.test(css), '聊天消息关收缩（矮窗不压扁）')
  assert(/\.slots__row\s*\{[^}]*flex-shrink:\s*0/.test(css), '服务行关收缩（200px 容器内滚动）')
  assert(/\.agentpanel__item[^{]*\{[^}]*flex-shrink:\s*0/.test(css), '子任务卡关收缩')
  assert(/\.mcp-panel__row\s*\{[^}]*flex-shrink:\s*0/.test(ext), 'MCP server 行关收缩')
  // 宽度链护栏：横向 flex 子项关自动最小尺寸 + 错误行 anywhere 断行（长 token 不撑破面板）
  assert(/\.mcp-panel\s*\{[^}]*min-width:\s*0/.test(ext), 'MCP 面板关自动最小尺寸（长错误不撑破、不压对话区）')
  assert(/\.mcp-panel__error\s*\{[^}]*overflow-wrap:\s*anywhere/.test(ext), '错误行 anywhere 断行（压 min-content，break-word 不行）')
  assert(/\.detail-row__value\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css), '详情值区 anywhere 断行（文本不裁切）')
  assert(/\.detail-chips\s*\{[^}]*flex-wrap:\s*wrap/.test(css), '详情标签列表换行不裁剪（chip reflow）')

  console.log('统型契约（不许再分叉；DOM 行为由 smoke:ui 真渲染覆盖，此处只钉源码结构）：')
  const panel = readFileSync(join(process.cwd(), 'src', 'components', 'workspace', 'ProjectSkillsSection.tsx'), 'utf8')
  const scopeRowSrc = readFileSync(join(process.cwd(), 'src', 'components', 'common', 'ScopeRow.tsx'), 'utf8')
  const mcpSrc = readFileSync(join(process.cwd(), 'src', 'components', 'workspace', 'McpPanel.tsx'), 'utf8')
  // 单一来源断言锚在「导出/导入 + 不自写」；「不自写」按 className 模板起点判别
  // （skills-panel__dir 是行类，__dirs/__dir-group 等容器类不算——前缀匹配会误伤）
  const DIR_ROW_SITE = 'className={`skills-panel__dir'
  assert(/export function ScopeRow/.test(scopeRowSrc) && scopeRowSrc.includes(DIR_ROW_SITE), '目录行渲染单一来源（ScopeRow 组件）')
  assert(panel.includes("common/ScopeRow") && !panel.includes(DIR_ROW_SITE), '技能面板经 ScopeRow 渲染目录行（不自写 dir 行 JSX）')
  assert(mcpSrc.includes("common/ScopeRow") && !mcpSrc.includes(DIR_ROW_SITE), 'MCP 配置域行复用 ScopeRow（不自写 dir 行 JSX）')
  assert(!panel.includes('SkillDirRow') && !mcpSrc.includes('SkillDirRow'), '旧 SkillDirRow 已退役（无残留引用）')
  const skillCardSites = panel.match(/className=\{`[^`]*skill-card/g) ?? []
  assert(skillCardSites.length === 1, `技能卡渲染单一来源（卡片只有一处，实得 ${skillCardSites.length}）`)
  assert(/className=\{`[^`]*\bcard\b[^`]*mcp-panel__row/.test(mcpSrc), 'MCP 行组合 .card 基座（同类模板共现）')
  assert(!panel.includes('isBuiltinDir'), '废弃 isBuiltinDir 分叉（策略收敛到 canManage）')
  assert(panel.split('canManage').length - 1 >= 3, 'canManage 统管导入/删除/空态三处')

  console.log('反馈通道契约（操作反馈=Toast；静态常驻状态=Notice；行为断言在 smoke:ui）：')
  const noticeSrc = readFileSync(join(process.cwd(), 'src', 'components', 'common', 'Notice.tsx'), 'utf8')
  const toastSrc = readFileSync(join(process.cwd(), 'src', 'components', 'common', 'Toast.tsx'), 'utf8')
  const appStoreSrc = readFileSync(join(process.cwd(), 'src', 'store', 'useAppStore.ts'), 'utf8')
  assert(/export const toast/.test(toastSrc) && /export function ToastHost/.test(toastSrc), 'Toast 是操作反馈统一出口（toast 命令式入口 + ToastHost 挂载点）')
  assert(!/export function useNotice/.test(noticeSrc), 'useNotice 已退役（静态常驻状态直接用 <Notice/>）')
  assert(!/showAlert/.test(appStoreSrc), 'showAlert 已退役（不许回流）')
  assert(panel.includes("common/Toast") && mcpSrc.includes("common/Toast"), '技能/MCP 面板操作反馈走 toast（无各自计时副本）')
  assert(!/useNotice|showAlert/.test(panel) && !/useNotice|showAlert/.test(mcpSrc), '面板内不再自持提示条计时/旧模态告警')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  }
  console.log('\n全部断言通过')
}

void main()
