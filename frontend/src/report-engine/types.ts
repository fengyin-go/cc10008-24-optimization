/**
 * 报告批次领域模型。
 *
 * 设计要点（对应业务规则）：
 * - 批次按「模板 + 报告周期」幂等：重复点击沿用同一份在途批次，不再生成新快照。
 * - 渲染按分段（封面 + 每张图）落盘：单图失败只标记该分段，不回退整份报告/更早周期。
 * - 批次冻结模板快照（templateVersion/templateName）：模板改名只影响之后的新批次。
 * - 渠道送达逐条记录尝试：权限不足与网络超时分别归因；回执按 receiptId 去重。
 * - 附件 fileKey 纳入格式、压缩、批次与版本：格式/压缩变化产出独立文件，不复用旧缓存。
 * - 补发是独立批次，冻结原收件范围；原批次及其推送结果永不改写。
 */

export type ChannelCode = 'email' | 'im' | 'portal'

export type ChannelKind = '邮件渠道' | 'IM 渠道' | '门户渠道'

export type ExportFormat = 'pdf' | 'html' | 'xlsx'

export type CompressionKind = 'zip' | 'tar.gz' | 'none'

export type BatchKind = 'original' | 'reissue'

/** 批次总体状态：partial 表示部分分段/渠道失败，已成功的成果一律保留。 */
export type BatchStatus = 'rendering' | 'pushing' | 'partial' | 'delivered' | 'failed'

export type SegmentStatus = 'pending' | 'rendered' | 'failed'

/** 失败归因枚举：渠道权限不足与网络超时必须分别记录。 */
export type FailReason =
  | 'chart_refresh_failed'
  | 'channel_timeout'
  | 'channel_permission_denied'

export type DeliveryStatus = 'pending' | 'delivered' | 'failed'

export type AttemptKind = 'push' | 'receipt' | 'duplicate_receipt' | 'retry'

export interface Recipient {
  userId: string
  name: string
  email: string
}

export interface ChannelSpec {
  code: ChannelCode
  kind: ChannelKind
  targetName: string
  recipients: Recipient[]
}

export interface ReportTemplate {
  id: string
  code: string
  name: string
  /** 模板内容版本：改名即递增；旧批次持有自己的冻结版本，不随模板变化。 */
  version: number
  chartCount: number
  channels: ChannelSpec[]
  updatedAt: number
}

export interface ReportArtifact {
  /** 分段产出的附件文件键：纳入批次、分段、格式、压缩与模板版本，保证不串缓存。 */
  fileKey: string
  fileName: string
  format: ExportFormat
  compression: CompressionKind
  segmentId: string
  templateVersion: number
  generatedAt: number
  sizeBytes: number
}

export interface RenderSegment {
  id: string
  /** cover 为封面分段；其余为图表分段（chart:序号）。 */
  kind: 'cover' | 'chart'
  chartIndex: number | null
  title: string
  status: SegmentStatus
  renderedAt: number | null
  failReason: FailReason | null
  failNote: string | null
  artifact: ReportArtifact | null
}

export interface DeliveryAttempt {
  id: string
  at: number
  kind: AttemptKind
  ok: boolean
  reason: FailReason | null
  note: string
  /** 渠道回执号：同一 receiptId 再次返回只登记重复回执，不重复计送达。 */
  receiptId: string | null
}

export interface ChannelDelivery {
  id: string
  channelCode: ChannelCode
  channelKind: ChannelKind
  targetName: string
  /** 冻结的收件范围：补发只能沿用，不允许增删收件人。 */
  recipients: Recipient[]
  status: DeliveryStatus
  receiptId: string | null
  deliveredAt: number | null
  failReason: FailReason | null
  failNote: string | null
  /** 全部尝试（含失败与重复回执）：渠道最终成功后失败旁证仍然保留。 */
  attempts: DeliveryAttempt[]
}

export interface ReportBatch {
  id: string
  kind: BatchKind
  /** 幂等键：同一模板同一周期同一格式/压缩组合只允许一份在途批次。 */
  idempotencyKey: string
  templateId: string
  templateCode: string
  /** 冻结的模板快照：模板随后改名/改版，本批次展示与推送都保持原样。 */
  templateName: string
  templateVersion: number
  period: string
  format: ExportFormat
  compression: CompressionKind
  status: BatchStatus
  segments: RenderSegment[]
  deliveries: ChannelDelivery[]
  originBatchId: string | null
  /** 补发链上的批次 id（含自身），便于检索同一报告的多次送达。 */
  lineage: string[]
  createdAt: number
  generatedAt: number | null
  finishedAt: number | null
}

/** 故障注入规则：把“网络断开/权限不足/重复回执”等场景做成确定性可复现。 */
export interface FailureScenario {
  id: string
  batchId: string
  scope: 'segment' | 'channel'
  segmentId?: string
  channelCode?: ChannelCode
  reason?: Exclude<FailReason, 'chart_refresh_failed'>
  /** 剩余触发次数，运行时命中一次递减，归零后规则自动失效。 */
  remaining: number
  /** 模拟渠道对同一送达返回重复回执。 */
  duplicateReceipt?: boolean
  note: string
}

export interface ReportEngineState {
  templates: ReportTemplate[]
  batches: ReportBatch[]
  scenarios: FailureScenario[]
  seq: number
}
