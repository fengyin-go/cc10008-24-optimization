import { useMemo, useState } from 'react'

import { useReportEngine } from '@/report-engine/useReportEngine'
import type {
  BatchStatus,
  ChannelCode,
  CompressionKind,
  ExportFormat,
  FailReason,
  ReportBatch,
} from '@/report-engine/types'

const STATUS_LABEL: Record<BatchStatus, string> = {
  rendering: '渲染中',
  pushing: '推送中',
  partial: '部分失败（成果保留）',
  delivered: '全部送达',
  failed: '整批失败',
}

const REASON_LABEL: Record<FailReason, string> = {
  chart_refresh_failed: '图表刷新失败',
  channel_timeout: '网络超时',
  channel_permission_denied: '渠道权限不足',
}

const FORMATS: ExportFormat[] = ['pdf', 'html', 'xlsx']
const COMPRESSIONS: CompressionKind[] = ['none', 'zip', 'tar.gz']
const COMPRESSION_LABEL: Record<CompressionKind, string> = {
  none: '不压缩',
  zip: 'ZIP',
  'tar.gz': 'TAR.GZ',
}

type TabKey = 'batches' | 'templates' | 'scenarios'

export default function ReportBatchView() {
  const { engine, state } = useReportEngine()
  const [tab, setTab] = useState<TabKey>('batches')
  const [keyword, setKeyword] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [errorText, setErrorText] = useState('')

  // 启动表单
  const [templateId, setTemplateId] = useState(state.templates[0]?.id ?? '')
  const [period, setPeriod] = useState('2026-10')
  const [format, setFormat] = useState<ExportFormat>('pdf')
  const [compression, setCompression] = useState<CompressionKind>('zip')

  const filtered = useMemo(() => {
    let rows = keyword.trim() ? engine.searchBatches(keyword) : engine.listBatches()
    if (channelFilter.trim()) {
      rows = rows.filter((batch) =>
        batch.deliveries.some(
          (delivery) =>
            delivery.channelCode === channelFilter || delivery.targetName.includes(channelFilter),
        ),
      )
    }
    return rows
  }, [engine, state.batches, keyword, channelFilter])

  const detail = detailId ? state.batches.find((batch) => batch.id === detailId) ?? null : null

  const stats = useMemo(
    () => ({
      total: state.batches.length,
      inFlight: state.batches.filter((batch) => batch.status === 'rendering' || batch.status === 'pushing').length,
      partial: state.batches.filter((batch) => batch.status === 'partial').length,
      delivered: state.batches.filter((batch) => batch.status === 'delivered').length,
    }),
    [state.batches],
  )

  function flash(message: string, isError = false): void {
    if (isError) {
      setErrorText(message)
      setNotice('')
    } else {
      setNotice(message)
      setErrorText('')
    }
  }

  function handleStart(): void {
    if (!templateId || !period.trim()) {
      flash('请选择模板并填写报告周期', true)
      return
    }
    const result = engine.startBatch(templateId, period.trim(), format, compression)
    flash(result.message)
  }

  return (
    <section className="page" data-module="report-batch">
      <header className="page-head">
        <div>
          <h2>报告批次中心</h2>
          <p className="page-desc">
            按报告周期切分渲染与推送成果：分段落盘、失败可补齐、幂等不重快照、补发独立留痕，全部状态持久化在浏览器本地。
          </p>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">批次总数</span>
          <strong className="stat-value">{stats.total}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">在途批次（关页面也继续）</span>
          <strong className="stat-value">{stats.inFlight}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">部分失败待补齐</span>
          <strong className="stat-value">{stats.partial}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">全部送达</span>
          <strong className="stat-value">{stats.delivered}</strong>
        </article>
      </div>

      <nav className="tab-bar">
        {([
          ['batches', '批次与快照'],
          ['templates', '模板版本'],
          ['scenarios', '故障注入'],
        ] as [TabKey, string][]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab-item ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {notice && <p className="ok-text">{notice}</p>}
      {errorText && <p className="error-text">{errorText}</p>}

      {tab === 'batches' && (
        <>
          <form
            className="filter-bar"
            onSubmit={(event) => {
              event.preventDefault()
            }}
          >
            <label className="filter-item">
              <span>模板</span>
              <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                {state.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}（{template.code} v{template.version}）
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-item">
              <span>报告周期</span>
              <input value={period} placeholder="如 2026-10" onChange={(event) => setPeriod(event.target.value)} />
            </label>
            <label className="filter-item">
              <span>导出格式</span>
              <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
                {FORMATS.map((item) => (
                  <option key={item} value={item}>
                    {item.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-item">
              <span>附件压缩</span>
              <select
                value={compression}
                onChange={(event) => setCompression(event.target.value as CompressionKind)}
              >
                {COMPRESSIONS.map((item) => (
                  <option key={item} value={item}>
                    {COMPRESSION_LABEL[item]}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" type="button" onClick={handleStart}>
              生成并推送（重复点击幂等）
            </button>
          </form>

          <form
            className="filter-bar"
            onSubmit={(event) => {
              event.preventDefault()
            }}
          >
            <label className="filter-item grow">
              <span>检索 / 搜索 / 查询 / 查找（批次号、周期、模板、渠道目标名称、收件人）</span>
              <input value={keyword} placeholder="输入任意关键字" onChange={(event) => setKeyword(event.target.value)} />
            </label>
            <label className="filter-item">
              <span>按渠道定位</span>
              <select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}>
                <option value="">全部渠道</option>
                <option value="email">邮件渠道 / 管理层邮件组</option>
                <option value="im">IM 渠道</option>
                <option value="portal">门户渠道</option>
              </select>
            </label>
            <button className="btn ghost" type="button" onClick={() => { setKeyword(''); setChannelFilter('') }}>
              重置条件
            </button>
          </form>

          <table className="data-table">
            <thead>
              <tr>
                <th>批次号</th>
                <th>类型</th>
                <th>模板（冻结版本）</th>
                <th>报告周期</th>
                <th>格式/压缩</th>
                <th>分段进度</th>
                <th>渠道进度</th>
                <th>状态</th>
                <th>生成时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((batch) => {
                const rendered = batch.segments.filter((segment) => segment.status === 'rendered').length
                const failedSeg = batch.segments.filter((segment) => segment.status === 'failed').length
                const delivered = batch.deliveries.filter((delivery) => delivery.status === 'delivered').length
                return (
                  <tr key={batch.id}>
                    <td>{batch.id}</td>
                    <td>{batch.kind === 'reissue' ? `补发（源 ${batch.originBatchId}）` : '原始推送'}</td>
                    <td>
                      {batch.templateName}
                      <span className="version-tag">v{batch.templateVersion}</span>
                    </td>
                    <td>{batch.period}</td>
                    <td>
                      {batch.format.toUpperCase()} / {COMPRESSION_LABEL[batch.compression]}
                    </td>
                    <td>
                      {rendered}/{batch.segments.length} 已渲染
                      {failedSeg > 0 && <span className="warn-tag">{failedSeg} 失败</span>}
                    </td>
                    <td>
                      {delivered}/{batch.deliveries.length} 已送达
                    </td>
                    <td>
                      <span className={`status-pill status-${batch.status}`}>{STATUS_LABEL[batch.status]}</span>
                    </td>
                    <td>{engine.formatTime(batch.generatedAt)}</td>
                    <td className="row-actions">
                      <button type="button" className="link" onClick={() => setDetailId(batch.id)}>
                        查看批次
                      </button>
                      {batch.kind === 'original' && (
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            const result = engine.reissue(batch.id)
                            flash(result.message)
                          }}
                        >
                          补发（沿用原收件范围）
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={10}>
                    暂无匹配批次，可在上方选择模板与周期后生成
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {tab === 'templates' && <TemplatePanel onError={(message) => flash(message, true)} onOk={(message) => flash(message)} />}

      {tab === 'scenarios' && <ScenarioPanel onError={(message) => flash(message, true)} onOk={(message) => flash(message)} />}

      {detail && (
        <BatchDetail
          batch={detail}
          onClose={() => setDetailId(null)}
          onError={(message) => flash(message, true)}
          onOk={(message) => flash(message)}
        />
      )}
    </section>
  )
}

function TemplatePanel(props: { onOk: (message: string) => void; onError: (message: string) => void }) {
  const { engine, state } = useReportEngine()
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  return (
    <div className="panel-stack">
      <p className="hint-text">
        改名只会递增模板自身版本并作用于之后的新推送；已生成批次持有冻结的模板名与版本，旧报告与原推送结果保持原样。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>模板编号</th>
            <th>当前名称</th>
            <th>当前版本</th>
            <th>图表数</th>
            <th>渠道数</th>
            <th>改名（新版本）</th>
          </tr>
        </thead>
        <tbody>
          {state.templates.map((template) => (
            <tr key={template.id}>
              <td>{template.code}</td>
              <td>{template.name}</td>
              <td>
                <span className="version-tag">v{template.version}</span>
              </td>
              <td>{template.chartCount}</td>
              <td>{template.channels.length}</td>
              <td>
                <div className="inline-form">
                  <input
                    value={drafts[template.id] ?? ''}
                    placeholder="输入新名称"
                    onChange={(event) => setDrafts((prev) => ({ ...prev, [template.id]: event.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      try {
                        const updated = engine.renameTemplate(template.id, drafts[template.id] ?? '')
                        props.onOk(`模板已改名为「${updated.name}」并升级到 v${updated.version}，仅影响之后的新批次`)
                        setDrafts((prev) => ({ ...prev, [template.id]: '' }))
                      } catch (error) {
                        props.onError(error instanceof Error ? error.message : '改名失败')
                      }
                    }}
                  >
                    保存改名
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScenarioPanel(props: { onOk: (message: string) => void; onError: (message: string) => void }) {
  const { engine, state } = useReportEngine()
  const [batchId, setBatchId] = useState(state.batches[0]?.id ?? '')
  const [scope, setScope] = useState<'segment' | 'channel'>('channel')
  const [channelCode, setChannelCode] = useState<ChannelCode>('portal')
  const [reason, setReason] = useState<'channel_timeout' | 'channel_permission_denied'>('channel_timeout')
  const [segmentId, setSegmentId] = useState('')
  const [duplicateReceipt, setDuplicateReceipt] = useState(false)
  const [remaining, setRemaining] = useState(1)

  const targetBatch = state.batches.find((batch) => batch.id === batchId) ?? null

  function add(): void {
    if (!targetBatch) {
      props.onError('请先创建批次再注入故障')
      return
    }
    if (scope === 'segment') {
      const seg = segmentId.trim() || targetBatch.segments.find((item) => item.kind === 'chart')?.id
      if (!seg) {
        props.onError('未找到可注入的图表分段')
        return
      }
      const created = engine.addScenario({
        batchId: targetBatch.id,
        scope: 'segment',
        segmentId: seg,
        remaining,
        note: `分段 ${seg} 刷新失败`,
      })
      props.onOk(`已注入分段故障 ${created.id}：下一次渲染该分段将只标记它失败`)
      return
    }
    const created = engine.addScenario({
      batchId: targetBatch.id,
      scope: 'channel',
      channelCode,
      reason,
      duplicateReceipt,
      remaining,
      note: `${channelCode} 渠道${REASON_LABEL[reason]}${duplicateReceipt ? '并返回重复回执' : ''}`,
    })
    props.onOk(`已注入渠道故障 ${created.id}：${created.note}`)
  }

  return (
    <div className="panel-stack">
      <p className="hint-text">
        故障规则在引擎处理对应分段/渠道时命中并自动失效；网络超时与权限不足分别归因，可叠加重复回执验证去重。
      </p>
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <label className="filter-item">
          <span>目标批次</span>
          <select value={batchId} onChange={(event) => setBatchId(event.target.value)}>
            {state.batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.id} · {batch.templateName} · {batch.period}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-item">
          <span>故障范围</span>
          <select value={scope} onChange={(event) => setScope(event.target.value as 'segment' | 'channel')}>
            <option value="channel">渠道故障</option>
            <option value="segment">图表分段刷新失败</option>
          </select>
        </label>
        {scope === 'channel' ? (
          <>
            <label className="filter-item">
              <span>渠道</span>
              <select value={channelCode} onChange={(event) => setChannelCode(event.target.value as ChannelCode)}>
                <option value="email">邮件渠道</option>
                <option value="im">IM 渠道</option>
                <option value="portal">门户渠道（第三个渠道）</option>
              </select>
            </label>
            <label className="filter-item">
              <span>归因</span>
              <select
                value={reason}
                onChange={(event) =>
                  setReason(event.target.value as 'channel_timeout' | 'channel_permission_denied')
                }
              >
                <option value="channel_timeout">网络超时</option>
                <option value="channel_permission_denied">渠道权限不足</option>
              </select>
            </label>
            <label className="filter-item check">
              <span>同时模拟重复回执</span>
              <input
                type="checkbox"
                checked={duplicateReceipt}
                onChange={(event) => setDuplicateReceipt(event.target.checked)}
              />
            </label>
          </>
        ) : (
          <label className="filter-item grow">
            <span>分段 id（留空默认第一张图）</span>
            <input
              value={segmentId}
              placeholder={targetBatch?.segments.find((item) => item.kind === 'chart')?.id ?? ''}
              onChange={(event) => setSegmentId(event.target.value)}
            />
          </label>
        )}
        <label className="filter-item">
          <span>触发次数</span>
          <input
            type="number"
            min={1}
            max={5}
            value={remaining}
            onChange={(event) => setRemaining(Number(event.target.value) || 1)}
          />
        </label>
        <button className="btn primary" type="submit">
          注入故障
        </button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            <th>规则号</th>
            <th>批次</th>
            <th>范围</th>
            <th>目标</th>
            <th>归因/说明</th>
            <th>剩余次数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.scenarios.map((scenario) => (
            <tr key={scenario.id}>
              <td>{scenario.id}</td>
              <td>{scenario.batchId}</td>
              <td>{scenario.scope === 'channel' ? '渠道' : '分段'}</td>
              <td>{scenario.channelCode ?? scenario.segmentId}</td>
              <td>
                {scenario.reason ? REASON_LABEL[scenario.reason] : '图表刷新失败'}
                {scenario.duplicateReceipt ? ' + 重复回执' : ''}
              </td>
              <td>{scenario.remaining}</td>
              <td className="row-actions">
                <button type="button" className="link" onClick={() => engine.removeScenario(scenario.id)}>
                  撤销规则
                </button>
              </td>
            </tr>
          ))}
          {state.scenarios.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={7}>
                暂无故障规则
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function BatchDetail(props: {
  batch: ReportBatch
  onClose: () => void
  onOk: (message: string) => void
  onError: (message: string) => void
}) {
  const { engine, state } = useReportEngine()
  // 详情数据跟随引擎状态实时刷新（重试、补发、回执到达都会反映出来）。
  const batch = state.batches.find((item) => item.id === props.batch.id) ?? props.batch

  return (
    <div className="drawer-mask" onClick={props.onClose}>
      <div className="drawer" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h3>
              批次 {batch.id} · {batch.templateName}
              <span className="version-tag">冻结版本 v{batch.templateVersion}</span>
            </h3>
            <p className="page-desc">
              {batch.kind === 'reissue' ? `补发批次，来源 ${batch.originBatchId}` : '原始推送批次'} · 周期 {batch.period} ·
              生成时间 {engine.formatTime(batch.generatedAt)} · 结束时间 {engine.formatTime(batch.finishedAt)} ·
              当前状态 {STATUS_LABEL[batch.status]}
            </p>
          </div>
          <button type="button" className="btn ghost" onClick={props.onClose}>
            关闭
          </button>
        </header>

        <h4>渲染分段（{batch.segments.length} 个，单图失败不回退整份报告）</h4>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>分段</th>
              <th>状态</th>
              <th>失败归因</th>
              <th>附件文件键 / 文件名</th>
              <th>渲染时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {batch.segments.map((segment) => (
              <tr key={segment.id}>
                <td>
                  {segment.title}
                  <span className="muted-text">（{segment.id}）</span>
                </td>
                <td>
                  <span className={`status-pill seg-${segment.status}`}>
                    {segment.status === 'rendered' ? '已渲染' : segment.status === 'failed' ? '失败（仅该分段）' : '待渲染'}
                  </span>
                </td>
                <td>{segment.failReason ? REASON_LABEL[segment.failReason] : '—'}</td>
                <td>
                  {segment.artifact ? (
                    <>
                      <code className="file-key">{segment.artifact.fileKey}</code>
                      <br />
                      <span className="muted-text">
                        {segment.artifact.fileName} · {segment.artifact.sizeBytes} B
                      </span>
                    </>
                  ) : (
                    <span className="muted-text">尚未产出附件</span>
                  )}
                </td>
                <td>{engine.formatTime(segment.renderedAt)}</td>
                <td className="row-actions">
                  {segment.status === 'failed' && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        try {
                          engine.retrySegment(batch.id, segment.id)
                          props.onOk(`分段 ${segment.title} 已补渲染，其他分段未受影响`)
                        } catch (error) {
                          props.onError(error instanceof Error ? error.message : '补渲染失败')
                        }
                      }}
                    >
                      补渲染该分段
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h4>渠道送达（权限不足与网络超时分别留痕，失败尝试长期保留）</h4>
        {batch.deliveries.map((delivery) => (
          <div key={delivery.id} className="delivery-card">
            <div className="delivery-head">
              <strong>
                {delivery.channelKind} · {delivery.targetName}（{delivery.channelCode}）
              </strong>
              <span className={`status-pill dlv-${delivery.status}`}>
                {delivery.status === 'delivered' ? '已送达' : delivery.status === 'failed' ? '失败' : '待推送'}
              </span>
              {delivery.failReason && <span className="warn-tag">{REASON_LABEL[delivery.failReason]}</span>}
            </div>
            <p className="muted-text">
              收件范围（冻结）：
              {delivery.recipients.map((recipient) => `${recipient.name}(${recipient.email})`).join('、')}
            </p>
            {delivery.receiptId && <p className="muted-text">送达回执：{delivery.receiptId}，送达时间 {engine.formatTime(delivery.deliveredAt)}</p>}
            {delivery.failNote && <p className="error-text">{delivery.failNote}</p>}
            <div className="row-actions">
              {delivery.status === 'failed' && (
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    try {
                      engine.retryChannel(batch.id, delivery.channelCode)
                      props.onOk(`已只补齐渠道 ${delivery.targetName}，其他渠道不变`)
                    } catch (error) {
                      props.onError(error instanceof Error ? error.message : '渠道重试失败')
                    }
                  }}
                >
                  只补齐该渠道
                </button>
              )}
              <button
                type="button"
                className="link"
                onClick={() => {
                  const receiptId = delivery.receiptId ?? `RC-MANUAL-${delivery.channelCode}`
                  const attempt = engine.recordReceipt(batch.id, delivery.channelCode, receiptId)
                  props.onOk(attempt.note)
                }}
              >
                模拟渠道回执{delivery.receiptId ? '（同号重复，验证去重）' : ''}
              </button>
            </div>
            <ul className="attempt-list">
              {delivery.attempts.map((attempt) => (
                <li key={attempt.id} className={attempt.ok ? '' : 'attempt-bad'}>
                  <span className="muted-text">{engine.formatTime(attempt.at)}</span>
                  <span>
                    {attempt.kind === 'duplicate_receipt' ? '重复回执去重' : attempt.kind === 'receipt' ? '渠道回执' : attempt.kind === 'retry' ? '失败重试' : '推送尝试'}
                  </span>
                  <span className={attempt.ok ? 'ok-text' : 'error-text'}>{attempt.ok ? '成功' : '失败'}</span>
                  <span>{attempt.note}</span>
                </li>
              ))}
              {delivery.attempts.length === 0 && <li className="muted-text">尚无尝试记录</li>}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
