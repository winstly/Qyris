/**
 * 桌宠面板定位矩阵冒烟：用真实 computePanelPosition（electron/lib/pet.ts）跑
 * 四角 / 中部 / 矮屏 / 窄屏 / 副屏 / 重开跟随全场景，任何一项不满足即退出码 1。
 * 断言口径：面板必须完整落在工作区内（窄屏横向溢出场景除外——物理放不下，保左缘）。
 */
import { computePanelPosition } from '../electron/lib/pet'

const PANEL = { width: 400, height: 600 }
const PET = { width: 128, height: 128 }
const GAP = 8

let failed = 0

function check(name: string, pet: { x: number; y: number }, wa: { x: number; y: number; width: number; height: number }, expect: { x: number; y: number }, opts?: { allowXOverflow?: boolean; allowYOverflow?: boolean }): void {
  const got = computePanelPosition({ ...pet, ...PET }, wa, PANEL)
  const xOk = got.x >= wa.x && (opts?.allowXOverflow || got.x + PANEL.width <= wa.x + wa.width)
  const yOk = got.y >= wa.y && (opts?.allowYOverflow || got.y + PANEL.height <= wa.y + wa.height)
  const exactOk = got.x === expect.x && got.y === expect.y
  if (!xOk || !yOk || !exactOk) {
    failed++
    console.error(`❌ ${name}: got(${got.x},${got.y}) expect(${expect.x},${expect.y}) inBounds=${xOk && yOk}`)
  } else {
    console.log(`✅ ${name}: (${got.x},${got.y})`)
  }
}

// 主力屏：1920×1040 工作区（1080p 减任务栏）
const MAIN = { x: 0, y: 0, width: 1920, height: 1040 }

// 1) 右上角：上方不足 → 下方；X 中线对齐不越界
check('右上角→下方', { x: 1600, y: 10 }, MAIN, { x: 1600 + PET.width / 2 - PANEL.width / 2, y: 10 + PET.height + GAP })
// 2) 右下角：上方充足 → 上方；X 中线越界 → 钳到右缘（面板右缘=工作区右缘）
check('右下角→上方+右钳制', { x: 1792, y: 900 }, MAIN, { x: 1920 - PANEL.width, y: 900 - PANEL.height - GAP })
check('右下角贴死(进一步贴角)→X 吸右缘', { x: 1850, y: 1000 }, MAIN, { x: 1920 - PANEL.width, y: 1000 - PANEL.height - GAP })
// 3) 左下角：上方充足 → 上方；X 钳到左缘
check('左下角→上方+左钳制', { x: 0, y: 900 }, MAIN, { x: 0, y: 900 - PANEL.height - GAP })
// 4) 左上角：上方不足 → 下方；X 钳左缘
check('左上角→下方+左钳制', { x: 0, y: 10 }, MAIN, { x: 0, y: 10 + PET.height + GAP })
// 5) 屏幕中部（桌宠 y=500，上方仅 500 < 面板 608 需求）→ 下方也放不下 → 贴工作区底缘
check('中部偏上→贴底缘', { x: 896, y: 500 }, MAIN, { x: 896 + PET.width / 2 - PANEL.width / 2, y: 1040 - PANEL.height })
// 6) 中部偏下但上方够 → 上方（只要装得下就不遮桌宠下方内容）
check('偏下但上方够→上方', { x: 896, y: 700 }, MAIN, { x: 896 + PET.width / 2 - PANEL.width / 2, y: 700 - PANEL.height - GAP })

// 7) 矮屏（工作区 640 高）：上下都放不下 → 贴底缘，面板完整在屏内
const SHORT = { x: 0, y: 0, width: 1366, height: 640 }
check('矮屏贴底→完整可见', { x: 500, y: 500 }, SHORT, { x: 500 + PET.width / 2 - PANEL.width / 2, y: 640 - PANEL.height })

// 8) 窄竖屏（工作区 300 宽 < 面板 400 宽）：物理放不下 → 保左缘、右缘溢出（披露的既有取舍）
const NARROW = { x: 0, y: 0, width: 300, height: 1040 }
check('窄竖屏→保左缘', { x: 50, y: 400 }, NARROW, { x: 0, y: 1040 - PANEL.height }, { allowXOverflow: true })

// 9) 副屏：工作区 (1920,0) 起，桌宠在副屏中部 → 全程相对副屏钳制
const SECOND = { x: 1920, y: 0, width: 1920, height: 1040 }
check('副屏中部→贴副屏底缘', { x: 3000, y: 500 }, SECOND, { x: 3000 + PET.width / 2 - PANEL.width / 2, y: 1040 - PANEL.height })
// 10) 副屏右缘：X 钳到副屏右缘（不是主屏右缘）
check('副屏右缘→副屏右钳制', { x: 3800, y: 500 }, SECOND, { x: 3840 - PANEL.width, y: 1040 - PANEL.height })

// 11) 重开跟随：面板停在旧位置不重要，函数只看桌宠当前位置——桌宠拖到哪，面板就跟到哪
check('拖到新位置→面板跟随', { x: 1200, y: 800 }, MAIN, { x: 1200 + PET.width / 2 - PANEL.width / 2, y: 800 - PANEL.height - GAP })

if (failed > 0) {
  console.error(`\n[smoke-pet-panel] ${failed} 项失败`)
  process.exit(1)
}
console.log('\n[smoke-pet-panel] 全部边界矩阵通过')
