/**
 * 扩展 tab：技能 / MCP 两切片共用一个工作区 tab（tab 切换，均为本地管理）。
 * 技能 = 全局目录（带「全局」标签，skill 级只读）+ 项目目录；MCP = 外部 server 本地管理。
 */
import { useState } from 'react'
import { TabStrip } from '@/components/common/TabStrip'
import { ProjectSkillsPanel } from './ProjectSkillsSection'
import { McpPanel } from './McpPanel'

export function ExtensionsTab() {
  const [view, setView] = useState<'skills' | 'mcp'>('skills')
  return (
    <div className="extensions-tab">
      <TabStrip
        label="扩展类型"
        active={view}
        onChange={setView}
        items={[
          { id: 'skills', label: '技能' },
          { id: 'mcp', label: 'MCP' },
        ]}
      />
      <div className="extensions-tab__body">
        {view === 'skills' ? <ProjectSkillsPanel /> : <McpPanel />}
      </div>
    </div>
  )
}
