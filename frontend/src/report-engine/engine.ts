import type {
  BatchKind,
  ChannelCode,
  ChannelDelivery,
  CompressionKind,
  DeliveryAttempt,
  ExportFormat,
  FailReason,
  FailureScenario,
  ReportArtifact,
  ReportBatch,
  ReportEngineState,
  ReportTemplate,
  RenderSegment,
} from './types.ts'

/** 存储抽象：生产环境接 localStorage，测试环境接内存 Map，引擎本身不碰浏览器 API。 */
export interface EngineStore {
  load(): ReportEngineState
  save(state: ReportEngineState): void
}

type Listener = () => void

export interface StartResult {
  batch: ReportBatch
  reused: boolean
  message: string
}

const TICK_MS = 600

function nowIso(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function artifactKey(
  batch: Pick<ReportBatch, 'id' | 'templateCode' | 'templateVersion' | 'format' | 'compression'>,
  segmentId: string,
): string {
  const compressPart = batch.compression === 'none' ? 'raw' : batch.compression.replace('.', '-')
  // 文件键纳入批次 id、分段、模板版本、导出格式与压缩方式：
  // 任何一项变化都会得到独立文件，绝不与旧缓存共用。
  return [
    'art',
    batch.templateCode,
    batch.id,
    segmentId,
    `v${batch.templateVersion}`,
    batch.format,
    compressPart,
  ].join('/')
}

export interface EngineOptions {
  /** 是否自动启动后台定时器；测试环境关闭，改用手工 tick 保证确定性。 */
  autoRun?: boolean
}

export class ReportEngine {
  private store: EngineStore
  private clock: () => number
  private autoRun: boolean
  private state: ReportEngineState
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(store: EngineStore, clock: () => number = () => Date.now(), options: EngineOptions = {}) {
    this.store = store
    this.clock = clock
    this.autoRun = options.autoRun ?? true
    this.state = store.load()
  }

  // ---------- 订阅与持久化 ----------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn())
  }

  private persist(): void {
    this.store.save(this.state)
    this.emit()
  }

  getState(): ReportEngineState {
    return this.state
  }

  private nextId(prefix: string): string {
    this.state.seq += 1
    return `${prefix}-${String(this.state.seq).padStart(4, '0')}`
  }

  // ---------- 模板 ----------

  listTemplates(): ReportTemplate[] {
    return this.state.templates
  }

  getTemplate(templateId: string): ReportTemplate {
    const template = this.state.templates.find((item) => item.id === templateId)
    if (!template) {
      throw new Error(`未找到报告模板 ${templateId}`)
    }
    return template
  }

  /**
   * 模板改名：只递增模板自身版本。
   * 已生成批次持有冻结的 templateName/templateVersion，改名不回溯、不改写旧推送。
   */
  renameTemplate(templateId: string, newName: string): ReportTemplate {
    const template = this.getTemplate(templateId)
    const trimmed = newName.trim()
    if (!trimmed) {
      throw new Error('模板名称不能为空')
    }
    template.name = trimmed
    template.version += 1
    template.updatedAt = this.clock()
    this.persist()
    return template
  }

  // ---------- 批次检索 ----------

  listBatches(): ReportBatch[] {
    return [...this.state.batches].sort((a, b) => b.createdAt - a.createdAt)
  }

  getBatch(batchId: string): ReportBatch {
    const batch = this.state.batches.find((item) => item.id === batchId)
    if (!batch) {
      throw new Error(`未找到报告批次 ${batchId}`)
    }
    return batch
  }

  /** 按渠道定位批次：渠道编码或渠道目标名称命中即返回。 */
  findByChannel(channelRef: string): ReportBatch[] {
    const keyword = channelRef.trim()
    if (!keyword) {
      return []
    }
    return this.listBatches().filter((batch) =>
      batch.deliveries.some(
        (delivery) =>
          delivery.channelCode === keyword ||
          delivery.targetName.includes(keyword) ||
          delivery.channelKind.includes(keyword),
      ),
    )
  }

  /** 综合检索：批次号、周期、模板名/编号、渠道目标名称、收件人姓名/邮箱。 */
  searchBatches(keyword: string): ReportBatch[] {
    const query = keyword.trim().toLowerCase()
    if (!query) {
      return this.listBatches()
    }
    return this.listBatches().filter((batch) => {
      const haystack = [
        batch.id,
        batch.period,
        batch.templateCode,
        batch.templateName,
        batch.status,
        batch.kind === 'reissue' ? '补发' : '原始推送',
        ...batch.deliveries.map((delivery) => delivery.targetName),
        ...batch.deliveries.flatMap((delivery) =>
          delivery.recipients.flatMap((recipient) => [recipient.name, recipient.email, recipient.userId]),
        ),
      ]
        .join('\n')
        .toLowerCase()
      return haystack.includes(query)
    })
  }

  // ---------- 批次启动（幂等） ----------

  /**
   * 启动一个报告周期的渲染与推送。
   * 同一「模板 + 周期 + 格式 + 压缩」组合若已有在途批次，重复点击直接沿用，
   * 不再生成第二份快照；已结束的批次也不会被二次点击复制，需走补发入口。
   */
  startBatch(
    templateId: string,
    period: string,
    format: ExportFormat,
    compression: CompressionKind,
    kind: BatchKind = 'original',
    originBatchId: string | null = null,
  ): StartResult {
    const template = this.getTemplate(templateId)
    const idempotencyKey = [template.id, period, format, compression].join('|')
    const existing = this.state.batches.find((item) => item.idempotencyKey === idempotencyKey)
    if (existing) {
      if (existing.status === 'rendering' || existing.status === 'pushing') {
        return {
          batch: existing,
          reused: true,
          message: `批次 ${existing.id} 正在进行中，已沿用同一份快照，未重复生成`,
        }
      }
      return {
        batch: existing,
        reused: true,
        message: `周期 ${period} 的批次 ${existing.id} 已结束（${existing.status}），未生成新快照；如需再次推送请使用补发`,
      }
    }

    const batch = this.buildBatch({
      template,
      period,
      format,
      compression,
      kind,
      originBatchId,
      recipientSource: originBatchId ? this.getBatch(originBatchId) : null,
    })
    this.state.batches.push(batch)
    this.persist()
    this.ensureRunner()
    return {
      batch,
      reused: false,
      message: `已创建${kind === 'reissue' ? '补发' : ''}批次 ${batch.id}，渲染在后台继续，关闭页面也不会中断`,
    }
  }

  private buildBatch(args: {
    template: ReportTemplate
    period: string
    format: ExportFormat
    compression: CompressionKind
    kind: BatchKind
    originBatchId: string | null
    recipientSource: ReportBatch | null
  }): ReportBatch {
    const { template, period, format, compression, kind, originBatchId, recipientSource } = args
    const id = this.nextId('BAT')
    const createdAt = this.clock()
    const base = {
      id,
      idempotencyKey: [template.id, period, format, compression].join('|'),
      templateId: template.id,
      templateCode: template.code,
      // 冻结模板快照：之后模板改名/改版，本批次展示与推送均保持该版本。
      templateName: template.name,
      templateVersion: template.version,
      period,
      format,
      compression,
      createdAt,
    }

    // 封面始终存在：没有图表时生成封面说明分段并落一个非空附件，禁止空白文件。
    const segments: RenderSegment[] = [
      {
        id: `${id}-seg-cover`,
        kind: 'cover',
        chartIndex: null,
        title: template.chartCount === 0 ? '封面说明（本周期无图表）' : '封面',
        status: 'pending',
        renderedAt: null,
        failReason: null,
        failNote: null,
        artifact: null,
      },
    ]
    for (let index = 1; index <= template.chartCount; index += 1) {
      segments.push({
        id: `${id}-seg-chart-${index}`,
        kind: 'chart',
        chartIndex: index,
        title: `图表 ${index}`,
        status: 'pending',
        renderedAt: null,
        failReason: null,
        failNote: null,
        artifact: null,
      })
    }

    // 渠道与收件范围：补发严格沿用原批次冻结的收件人，不允许增删。
    const deliveries: ChannelDelivery[] = template.channels.map((channel) => {
      const origin = recipientSource?.deliveries.find((item) => item.channelCode === channel.code)
      return {
        id: `${id}-dlv-${channel.code}`,
        channelCode: channel.code,
        channelKind: channel.kind,
        targetName: channel.targetName,
        recipients: origin ? origin.recipients.map((item) => ({ ...item })) : channel.recipients.map((item) => ({ ...item })),
        status: 'pending',
        receiptId: null,
        deliveredAt: null,
        failReason: null,
        failNote: null,
        attempts: [],
      }
    })

    const lineage = originBatchId
      ? [...this.getBatch(originBatchId).lineage, id]
      : [id]

    return {
      ...base,
      kind,
      status: 'rendering',
      segments,
      deliveries,
      originBatchId,
      lineage,
      generatedAt: null,
      finishedAt: null,
    }
  }

  // ---------- 补发 ----------

  /**
   * 基于原批次补发：独立新批次、独立快照与附件，沿用原收件范围与周期；
   * 模板若已改名/改版，补发使用当前新版本，原批次保持原样、永不改写。
   */
  reissue(originBatchId: string): StartResult {
    const origin = this.getBatch(originBatchId)
    // 重新构造幂等键：补发生成独立批次，因此在键上加入 lineage 长度与原批次 id。
    const template = this.getTemplate(origin.templateId)
    const reissueCount = this.state.batches.filter(
      (item) => item.id !== origin.id && (item.originBatchId === origin.id || item.lineage.includes(origin.id)),
    ).length
    const period = `${origin.period}#补发${reissueCount + 1}`
    const idempotencyKey = [template.id, period, origin.format, origin.compression].join('|')
    if (this.state.batches.some((item) => item.idempotencyKey === idempotencyKey)) {
      throw new Error('该补发批次已存在，请勿重复创建')
    }
    const batch = this.buildBatch({
      template,
      period,
      format: origin.format,
      compression: origin.compression,
      kind: 'reissue',
      originBatchId: origin.id,
      recipientSource: origin,
    })
    this.state.batches.push(batch)
    this.persist()
    this.ensureRunner()
    return {
      batch,
      reused: false,
      message: `已基于原批次 ${origin.id} 创建补发批次 ${batch.id}，收件范围与原推送一致，使用模板 v${template.version}`,
    }
  }

  // ---------- 故障注入（演示网络断开/权限不足/重复回执） ----------

  addScenario(input: Omit<FailureScenario, 'id'>): FailureScenario {
    const scenario: FailureScenario = { ...input, id: this.nextId('SCN') }
    this.state.scenarios.push(scenario)
    this.persist()
    return scenario
  }

  removeScenario(scenarioId: string): void {
    this.state.scenarios = this.state.scenarios.filter((item) => item.id !== scenarioId)
    this.persist()
  }

  private consumeScenario(predicate: (scenario: FailureScenario) => boolean): FailureScenario | null {
    const scenario = this.state.scenarios.find((item) => item.remaining > 0 && predicate(item))
    if (!scenario) {
      return null
    }
    scenario.remaining -= 1
    if (scenario.remaining <= 0) {
      this.state.scenarios = this.state.scenarios.filter((item) => item.id !== scenario.id)
    }
    return scenario
  }

  // ---------- 渲染 ----------

  private renderSegment(batch: ReportBatch, segment: RenderSegment): void {
    const hit = this.consumeScenario(
      (scenario) =>
        scenario.batchId === batch.id && scenario.scope === 'segment' && scenario.segmentId === segment.id,
    )
    if (hit) {
      // 单图刷新失败：只标记这一个分段，已渲染分段与更早周期成果全部保留。
      segment.status = 'failed'
      segment.failReason = 'chart_refresh_failed'
      segment.failNote = `图表刷新失败（故障注入 ${hit.id}），仅该分段标记失败，不影响其他分段`
      return
    }
    const ts = this.clock()
    const fileName = [
      `${batch.templateCode}-${batch.period.replace(/[#]/g, '_')}-${segment.title.replace(/[（）\s]/g, '')}`,
      batch.format,
      batch.compression === 'none' ? null : batch.compression,
    ]
      .filter(Boolean)
      .join('.')
    const artifact: ReportArtifact = {
      fileKey: artifactKey(batch, segment.id),
      fileName,
      format: batch.format,
      compression: batch.compression,
      segmentId: segment.id,
      templateVersion: batch.templateVersion,
      generatedAt: ts,
      // 封面说明也是有内容的非空文件。
      sizeBytes: 128 + segment.id.length * 16 + batch.templateVersion * 7,
    }
    segment.status = 'rendered'
    segment.renderedAt = ts
    segment.artifact = artifact
    if (batch.generatedAt === null) {
      batch.generatedAt = ts
    }
  }

  /** 手动重试失败分段：只补渲染该分段，不触碰其他分段，也不会回退到更早周期。 */
  retrySegment(batchId: string, segmentId: string): void {
    const batch = this.getBatch(batchId)
    const segment = batch.segments.find((item) => item.id === segmentId)
    if (!segment) {
      throw new Error('未找到对应渲染分段')
    }
    if (segment.status !== 'failed') {
      throw new Error('只有失败状态的分段可以补渲染')
    }
    segment.failReason = null
    segment.failNote = null
    this.renderSegment(batch, segment)
    this.recomputeStatus(batch)
    this.persist()
  }

  // ---------- 渠道推送 ----------

  private pushDelivery(batch: ReportBatch, delivery: ChannelDelivery): void {
    const hit = this.consumeScenario(
      (scenario) =>
        scenario.batchId === batch.id && scenario.scope === 'channel' && scenario.channelCode === delivery.channelCode,
    )
    const attemptBase: DeliveryAttempt = {
      id: this.nextId('ATT'),
      at: this.clock(),
      kind: 'push',
      ok: true,
      reason: null,
      note: '',
      receiptId: null,
    }
    // 命中带失败归因的规则才记失败；仅要求重复回执的规则不阻断正常送达。
    if (hit && hit.reason) {
      // 权限不足与网络超时分别归因、分别留痕，互不混淆。
      const note =
        hit.reason === 'channel_permission_denied'
          ? `渠道权限不足，推送被拒（故障注入 ${hit.id}）`
          : `网络超时，渠道未响应（故障注入 ${hit.id}）`
      delivery.status = 'failed'
      delivery.failReason = hit.reason
      delivery.failNote = note
      delivery.attempts.push({ ...attemptBase, kind: 'retry', ok: false, reason: hit.reason, note })
      return
    }
    const receiptId = delivery.receiptId ?? `RC-${batch.id}-${delivery.channelCode}-${this.state.seq}`
    delivery.status = 'delivered'
    delivery.receiptId = receiptId
    delivery.deliveredAt = attemptBase.at
    delivery.failReason = null
    delivery.failNote = null
    delivery.attempts.push({
      ...attemptBase,
      ok: true,
      receiptId,
      note: `推送成功，渠道回执 ${receiptId}`,
    })
    if (hit?.duplicateReceipt) {
      // 渠道重复回执：同一 receiptId 只做去重登记，不重复计送达、不改送达时间。
      delivery.attempts.push({
        id: this.nextId('ATT'),
        at: this.clock(),
        kind: 'duplicate_receipt',
        ok: true,
        reason: null,
        receiptId,
        note: `渠道再次返回回执 ${receiptId}，按同一送达记录去重，未重复计数`,
      })
    }
  }

  /** 手动重试失败渠道：只补这一条渠道，其他渠道与渲染成果不受影响。 */
  retryChannel(batchId: string, channelCode: ChannelCode): void {
    const batch = this.getBatch(batchId)
    const delivery = batch.deliveries.find((item) => item.channelCode === channelCode)
    if (!delivery) {
      throw new Error('未找到对应渠道送达记录')
    }
    if (delivery.status === 'delivered') {
      throw new Error('该渠道已送达，无需重试')
    }
    this.pushDelivery(batch, delivery)
    this.recomputeStatus(batch)
    this.persist()
  }

  /**
   * 模拟渠道事后又推来一张回执：receiptId 与现有回执相同则只登记重复回执，
   * 对应「渠道返回重复回执时按同一送达记录去重」。
   */
  recordReceipt(batchId: string, channelCode: ChannelCode, receiptId: string): DeliveryAttempt {
    const batch = this.getBatch(batchId)
    const delivery = batch.deliveries.find((item) => item.channelCode === channelCode)
    if (!delivery) {
      throw new Error('未找到对应渠道送达记录')
    }
    const duplicate = delivery.receiptId !== null && delivery.receiptId === receiptId
    const attempt: DeliveryAttempt = {
      id: this.nextId('ATT'),
      at: this.clock(),
      kind: duplicate ? 'duplicate_receipt' : 'receipt',
      ok: true,
      reason: null,
      receiptId,
      note: duplicate
        ? `收到重复回执 ${receiptId}，按同一送达记录去重，送达时间与计数不变`
        : `收到渠道回执 ${receiptId}`,
    }
    if (!duplicate && delivery.receiptId === null) {
      delivery.receiptId = receiptId
      delivery.deliveredAt = attempt.at
      delivery.status = 'delivered'
    }
    delivery.attempts.push(attempt)
    this.recomputeStatus(batch)
    this.persist()
    return attempt
  }

  // ---------- 状态汇总与后台推进 ----------

  private recomputeStatus(batch: ReportBatch): void {
    const hasPendingSegment = batch.segments.some((segment) => segment.status === 'pending')
    if (hasPendingSegment) {
      batch.status = 'rendering'
      return
    }
    const hasPendingDelivery = batch.deliveries.some((delivery) => delivery.status === 'pending')
    if (hasPendingDelivery) {
      batch.status = 'pushing'
      return
    }
    const allRendered = batch.segments.every((segment) => segment.status === 'rendered')
    const allDelivered = batch.deliveries.every((delivery) => delivery.status === 'delivered')
    const anyProgress =
      batch.segments.some((segment) => segment.status === 'rendered') ||
      batch.deliveries.some((delivery) => delivery.status === 'delivered')
    if (allRendered && allDelivered) {
      batch.status = 'delivered'
    } else if (anyProgress) {
      // 部分失败：成功成果保留，等手动补齐，绝不回退到更早周期。
      batch.status = 'partial'
    } else {
      batch.status = 'failed'
    }
    if (batch.status === 'partial' || batch.status === 'delivered' || batch.status === 'failed') {
      batch.finishedAt = batch.finishedAt ?? this.clock()
    }
  }

  /**
   * 推进一步后台任务：每次只处理一个分段或一条渠道，处理完立即持久化。
   * 页面关闭只是定时器停了，状态已落盘；重新进入时 ensureRunner 从同一批次继续。
   */
  tick(): boolean {
    const batch = this.state.batches.find(
      (item) => item.status === 'rendering' || item.status === 'pushing',
    )
    if (!batch) {
      return false
    }
    const pendingSegment = batch.segments.find((segment) => segment.status === 'pending')
    if (pendingSegment) {
      this.renderSegment(batch, pendingSegment)
      this.recomputeStatus(batch)
      this.persist()
      return true
    }
    const pendingDelivery = batch.deliveries.find((delivery) => delivery.status === 'pending')
    if (pendingDelivery) {
      this.pushDelivery(batch, pendingDelivery)
      this.recomputeStatus(batch)
      this.persist()
      return true
    }
    this.recomputeStatus(batch)
    this.persist()
    return false
  }

  /** 启动后台推进器；重复调用安全，重新进入页面时从落盘状态续跑同一批次。 */
  ensureRunner(): void {
    if (!this.autoRun || this.timer !== null || typeof setInterval === 'undefined') {
      return
    }
    this.timer = setInterval(() => {
      const busy = this.tick()
      if (!busy && this.timer !== null) {
        clearInterval(this.timer)
        this.timer = null
      }
    }, TICK_MS)
  }

  stopRunner(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  hasInFlight(): boolean {
    return this.state.batches.some(
      (batch) => batch.status === 'rendering' || batch.status === 'pushing',
    )
  }

  formatTime(ts: number | null): string {
    return ts === null ? '—' : nowIso(ts)
  }
}
