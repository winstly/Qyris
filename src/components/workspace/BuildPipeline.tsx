import type { BuildPhase } from '@/types'

const STAGES: { key: BuildPhase; label: string }[] = [
  { key: 'building', label: '编译中' },
  { key: 'deploying', label: '部署中' },
  { key: 'running', label: '运行中' },
  { key: 'error', label: '异常' },
]

/** phase → 各阶段的视觉状态 */
function stageStates(phase: BuildPhase): ('pending' | 'active' | 'done' | 'error')[] {
  const states: ('pending' | 'active' | 'done' | 'error')[] = ['pending', 'pending', 'pending', 'pending']
  switch (phase) {
    case 'idle':
      break
    case 'building':
      states[0] = 'active'
      break
    case 'deploying':
      states[0] = 'done'
      states[1] = 'active'
      break
    case 'running':
      states[0] = 'done'
      states[1] = 'done'
      states[2] = 'active'
      break
    case 'error':
      // 异常时点亮异常节点
      states[3] = 'error'
      break
  }
  return states
}

export function BuildPipeline({ phase }: { phase: BuildPhase }) {
  const states = stageStates(phase)
  const reached = phase !== 'idle'

  return (
    <div className={`pipeline ${reached ? '' : 'pipeline--idle'}`} role="status" aria-label={`当前状态：${phase}`}>
      {STAGES.map((stage, i) => (
        <div key={stage.key} className="pipeline__segment">
          {i > 0 && (
            <span
              className={`pipeline__line ${
                states[i] !== 'pending' ? 'pipeline__line--filled' : ''
              } pipeline__line--${STAGES[i - 1].key}`}
            />
          )}
          <span className={`pipeline__node pipeline__node--${stage.key} pipeline__node--${states[i]}`}>
            <span className="pipeline__pip" />
            <span className="pipeline__label">{stage.label}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
