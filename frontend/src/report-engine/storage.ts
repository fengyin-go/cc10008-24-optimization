import type { EngineStore } from './engine.ts'
import { buildSeedState } from './seed.ts'
import type { ReportEngineState } from './types.ts'

const STORAGE_KEY = 'interactive-analytics-lab:report-engine-v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** localStorage 持久化：每个 tick 落盘，关闭页面/刷新后从同一批次继续。 */
export class LocalEngineStore implements EngineStore {
  private key: string

  constructor(key: string = STORAGE_KEY) {
    this.key = key
  }

  load(): ReportEngineState {
    if (typeof window === 'undefined' || !window.localStorage) {
      return buildSeedState(Date.now())
    }
    const raw = window.localStorage.getItem(this.key)
    if (!raw) {
      const seed = buildSeedState(Date.now())
      window.localStorage.setItem(this.key, JSON.stringify(seed))
      return seed
    }
    try {
      const parsed = JSON.parse(raw) as ReportEngineState
      // 兼容旧数据缺字段的情况，保证重新进入页面不会崩。
      return {
        templates: parsed.templates ?? [],
        batches: parsed.batches ?? [],
        scenarios: parsed.scenarios ?? [],
        seq: parsed.seq ?? 0,
      }
    } catch {
      const seed = buildSeedState(Date.now())
      window.localStorage.setItem(this.key, JSON.stringify(seed))
      return seed
    }
  }

  save(state: ReportEngineState): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      return
    }
    window.localStorage.setItem(this.key, JSON.stringify(clone(state)))
  }
}

/** 测试用内存存储：不依赖浏览器，也不读写磁盘。 */
export class MemoryEngineStore implements EngineStore {
  private state: ReportEngineState

  constructor(initial?: ReportEngineState) {
    this.state = initial ? clone(initial) : buildSeedState(Date.now())
  }

  load(): ReportEngineState {
    return this.state
  }

  save(state: ReportEngineState): void {
    this.state = clone(state)
  }

  snapshot(): ReportEngineState {
    return clone(this.state)
  }
}

export { STORAGE_KEY as REPORT_ENGINE_STORAGE_KEY }
