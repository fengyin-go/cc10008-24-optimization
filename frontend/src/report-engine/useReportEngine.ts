import { useSyncExternalStore } from 'react'

import { ReportEngine } from './engine.ts'
import { LocalEngineStore } from './storage.ts'
import type { ReportEngineState } from './types.ts'

// 模块级单例：整个应用共享一个引擎与一个持久化状态。
let engineSingleton: ReportEngine | null = null

export function getReportEngine(): ReportEngine {
  if (engineSingleton === null) {
    engineSingleton = new ReportEngine(new LocalEngineStore())
    // 重新进入页面：从 localStorage 恢复在途批次，后台快照继续推进，不被“关闭页面”取消。
    engineSingleton.ensureRunner()
  }
  return engineSingleton
}

export function useReportEngine(): { engine: ReportEngine; state: ReportEngineState } {
  const engine = getReportEngine()
  const state = useSyncExternalStore(
    (onChange) => engine.subscribe(onChange),
    () => engine.getState(),
    () => engine.getState(),
  )
  return { engine, state }
}
