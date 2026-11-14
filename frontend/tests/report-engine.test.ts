/**
 * 报告批次引擎验收测试（纯 Node，无第三方依赖）：
 *   node --experimental-strip-types --no-warnings frontend/tests/report-engine.test.ts
 * 覆盖用户提出的全部 15 条规则。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ReportEngine } from '../src/report-engine/engine.ts'
import { MemoryEngineStore } from '../src/report-engine/storage.ts'
import type { ChannelCode, ReportBatch, ReportEngineState } from '../src/report-engine/types.ts'

let timeCursor = 1_700_000_000_000
const clock = () => timeCursor
function advance(ms: number): void {
  timeCursor += ms
}

function newEngine(initial?: ReportEngineState): ReportEngine {
  timeCursor = 1_700_000_000_000
  // 关闭自动定时器：测试只用手工 tick 推进，避免 setInterval 异步竞态。
  return new ReportEngine(new MemoryEngineStore(initial), clock, { autoRun: false })
}

/** 把在途批次完整跑到没有待处理项为止。 */
function drain(engine: ReportEngine, maxSteps = 200): void {
  let guard = 0
  while (engine.tick() && guard < maxSteps) {
    advance(500)
    guard += 1
  }
  assert.ok(guard < maxSteps, '引擎推进超过最大步数，可能存在死循环')
}

function monthly(engine: ReportEngine) {
  return engine.getTemplate('tpl-monthly')
}

test('规则1+2: 渲染按分段保留；第三个渠道断网后重试只补未完成渠道，不产生第二份快照', () => {
  const engine = newEngine()
  const first = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  const batchId = first.batch.id

  // 渲染完成前给第三个渠道（portal）注入一次网络超时。
  engine.addScenario({
    id: 'scn-timeout',
    batchId,
    scope: 'channel',
    channelCode: 'portal',
    reason: 'channel_timeout',
    remaining: 1,
    note: '模拟第三个渠道网络断开',
  })
  drain(engine)

  const afterBreak = engine.getBatch(batchId)
  assert.equal(afterBreak.status, 'partial')
  // 前两个渠道已送达，成果保留；只有第三个渠道失败。
  assert.deepEqual(
    afterBreak.deliveries.map((d) => [d.channelCode, d.status]),
    [
      ['email', 'delivered'],
      ['im', 'delivered'],
      ['portal', 'failed'],
    ],
  )
  // 20 张图 + 封面，共 21 个分段全部渲染完成，断网没有丢掉已渲染内容。
  assert.equal(afterBreak.segments.length, 21)
  assert.ok(afterBreak.segments.every((s) => s.status === 'rendered'))

  // 重复点击同一周期：沿用同一份在途/已结束批次，不再生成新快照。
  const repeat = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  assert.equal(repeat.reused, true)
  assert.equal(repeat.batch.id, batchId)
  assert.equal(engine.getState().batches.length, 1)

  // 只补齐失败渠道。
  engine.retryChannel(batchId, 'portal')
  const repaired = engine.getBatch(batchId)
  assert.equal(repaired.status, 'delivered')
  assert.deepEqual(repaired.deliveries.map((d) => d.status), ['delivered', 'delivered', 'delivered'])
  // 失败尝试仍然作为旁证保留在 portal 的 attempts 里。
  const portal = repaired.deliveries.find((d) => d.channelCode === 'portal')!
  assert.ok(portal.attempts.some((a) => a.reason === 'channel_timeout' && a.ok === false))
  assert.ok(portal.attempts.some((a) => a.ok === true))
})

test('规则3: 模板改名后旧批次保持原版本，新推送才使用新版本', () => {
  const engine = newEngine()
  const old = engine.startBatch(monthly(engine).id, '2026-09', 'pdf', 'zip')
  drain(engine)
  assert.equal(old.batch.templateName, '月度经营分析报告')
  assert.equal(old.batch.templateVersion, 3)

  engine.renameTemplate('tpl-monthly', '月度经营分析报告（改版）')
  const oldAgain = engine.getBatch(old.batch.id)
  assert.equal(oldAgain.templateName, '月度经营分析报告')
  assert.equal(oldAgain.templateVersion, 3)

  const next = engine.startBatch(monthly(engine).id, '2026-11', 'pdf', 'zip')
  assert.equal(next.batch.templateName, '月度经营分析报告（改版）')
  assert.equal(next.batch.templateVersion, 4)
})

test('规则4: 某张图刷新失败只标记该分段，整份报告不回退，可单独补渲染', () => {
  const engine = newEngine()
  const started = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  const batchId = started.batch.id
  const targetSegment = `${batchId}-seg-chart-7`
  engine.addScenario({
    id: 'scn-chart',
    batchId,
    scope: 'segment',
    segmentId: targetSegment,
    remaining: 1,
    note: '第 7 张图刷新失败',
  })
  drain(engine)
  const batch = engine.getBatch(batchId)
  const seg7 = batch.segments.find((s) => s.id === targetSegment)!
  assert.equal(seg7.status, 'failed')
  assert.equal(seg7.failReason, 'chart_refresh_failed')
  // 其他分段（含封面与图 1-6、8-20）依旧已渲染。
  assert.equal(batch.segments.filter((s) => s.status === 'rendered').length, 20)
  assert.equal(batch.status, 'partial')

  engine.retrySegment(batchId, targetSegment)
  const repaired = engine.getBatch(batchId)
  assert.equal(repaired.segments.find((s) => s.id === targetSegment)!.status, 'rendered')
  assert.ok(repaired.segments.every((s) => s.status === 'rendered'))
})

test('规则5: 渠道重复回执按同一送达记录去重，不重复计数', () => {
  const engine = newEngine()
  const started = engine.startBatch('tpl-quarterly', '2026Q3', 'pdf', 'none')
  drain(engine)
  const batchId = started.batch.id
  const im = engine.getBatch(batchId).deliveries[0]
  const receiptId = im.receiptId!
  const attemptsBefore = im.attempts.length
  const deliveredAtBefore = im.deliveredAt

  advance(10_000)
  const attempt = engine.recordReceipt(batchId, 'im', receiptId)
  assert.equal(attempt.kind, 'duplicate_receipt')
  const after = engine.getBatch(batchId).deliveries[0]
  assert.equal(after.attempts.length, attemptsBefore + 1)
  assert.equal(after.deliveredAt, deliveredAtBefore) // 送达时间不被重复回执改写
  assert.equal(after.receiptId, receiptId)
})

test('规则6: 附件压缩/格式变化生成独立文件，fileKey 不与旧缓存共用', () => {
  const engine = newEngine()
  const a = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  drain(engine)
  const b = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'tar.gz')
  // 幂等键包含压缩方式，因此是两个独立批次。
  assert.notEqual(b.batch.id, a.batch.id)
  drain(engine)
  const c = engine.startBatch(monthly(engine).id, '2026-10', 'html', 'tar.gz')
  drain(engine)

  const keys = new Set<string>()
  for (const batch of engine.getState().batches) {
    for (const segment of batch.segments) {
      assert.ok(segment.artifact, '每个渲染分段都应有附件')
      keys.add(segment.artifact!.fileKey)
    }
  }
  // 所有附件键全局唯一：格式/压缩/批次任一不同都不共用文件。
  const totalArtifacts = engine
    .getState()
    .batches.reduce((sum, batch) => sum + batch.segments.length, 0)
  assert.equal(keys.size, totalArtifacts)
})

test('规则7: 同一用户收到原报告与补发，两份快照的生成时间与模板版本均可见且独立', () => {
  const engine = newEngine()
  const original = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  drain(engine)
  advance(60_000)
  engine.renameTemplate('tpl-monthly', '月度经营分析报告（补发版）')
  const reissue = engine.reissue(original.batch.id)
  drain(engine)

  assert.equal(reissue.batch.kind, 'reissue')
  assert.notEqual(reissue.batch.id, original.batch.id)
  assert.equal(reissue.batch.originBatchId, original.batch.id)
  assert.equal(reissue.batch.period, '2026-10#补发1')
  assert.equal(reissue.batch.templateVersion, 4)
  assert.equal(original.batch.templateVersion, 3)
  assert.notEqual(reissue.batch.generatedAt, original.batch.generatedAt)
  assert.ok(reissue.batch.lineage.includes(original.batch.id))
  assert.ok(original.batch.lineage.includes(original.batch.id))
})

test('规则8: 渠道权限不足与网络超时分别记录为不同归因', () => {
  const engine = newEngine()
  const started = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  const batchId = started.batch.id
  engine.addScenario({ id: 's1', batchId, scope: 'channel', channelCode: 'im', reason: 'channel_permission_denied', remaining: 1, note: '权限不足' })
  engine.addScenario({ id: 's2', batchId, scope: 'channel', channelCode: 'portal', reason: 'channel_timeout', remaining: 1, note: '网络超时' })
  drain(engine)
  const batch = engine.getBatch(batchId)
  const im = batch.deliveries.find((d) => d.channelCode === 'im')!
  const portal = batch.deliveries.find((d) => d.channelCode === 'portal')!
  assert.equal(im.failReason, 'channel_permission_denied')
  assert.equal(portal.failReason, 'channel_timeout')
  assert.ok(im.attempts.some((a) => a.reason === 'channel_permission_denied'))
  assert.ok(portal.attempts.some((a) => a.reason === 'channel_timeout'))
})

test('规则9: 补发只能沿用原收件范围，不允许增删', () => {
  const engine = newEngine()
  const original = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  drain(engine)
  const reissue = engine.reissue(original.batch.id)
  drain(engine)
  for (const delivery of reissue.batch.deliveries) {
    const origin = original.batch.deliveries.find((d) => d.channelCode === delivery.channelCode)!
    assert.deepEqual(
      delivery.recipients.map((r) => r.userId).sort(),
      origin.recipients.map((r) => r.userId).sort(),
    )
  }
  // 原批次不被补发改写。
  const untouched = engine.getBatch(original.batch.id)
  assert.equal(untouched.kind, 'original')
  assert.equal(untouched.deliveries.length, 3)
})

test('规则10: 没有图表的报告仍生成封面说明附件，不留下空白文件', () => {
  const engine = newEngine()
  const started = engine.startBatch('tpl-weekly', '2026-W42', 'pdf', 'none')
  drain(engine)
  const batch = engine.getBatch(started.batch.id)
  assert.equal(batch.segments.length, 1)
  const cover = batch.segments[0]
  assert.equal(cover.kind, 'cover')
  assert.equal(cover.title, '封面说明（本周期无图表）')
  assert.equal(cover.status, 'rendered')
  assert.ok(cover.artifact && cover.artifact.sizeBytes > 0)
  assert.equal(batch.status, 'delivered')
})

test('规则11: 关闭页面（仅停止定时器）不取消后台快照，重新进入从同一批次继续', () => {
  const engine = newEngine()
  const started = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  // 只推进 3 步后“关闭页面”：定时器停止，但每次 tick 都已落盘。
  engine.tick(); advance(500)
  engine.tick(); advance(500)
  engine.tick(); advance(500)
  engine.stopRunner()
  const persisted = engine.getState()
  assert.equal(persisted.batches[0].status, 'rendering')

  // 用同一份持久化状态“重新进入页面”：新引擎实例从断点继续，批次 id 不变。
  const reentered = new ReportEngine(new MemoryEngineStore(persisted), clock, { autoRun: false })
  assert.equal(reentered.getState().batches[0].id, started.batch.id)
  const renderedBefore = reentered.getState().batches[0].segments.filter((s) => s.status === 'rendered').length
  assert.equal(renderedBefore, 3)
  drain(reentered)
  assert.equal(reentered.getBatch(started.batch.id).status, 'delivered')
})

test('规则12: 渠道全部成功后仍保留失败尝试旁证', () => {
  const engine = newEngine()
  const started = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  const batchId = started.batch.id
  engine.addScenario({ id: 's1', batchId, scope: 'channel', channelCode: 'email', reason: 'channel_timeout', remaining: 1, note: '首次超时' })
  drain(engine)
  assert.equal(engine.getBatch(batchId).status, 'partial')
  engine.retryChannel(batchId, 'email')
  const batch = engine.getBatch(batchId)
  assert.equal(batch.status, 'delivered')
  const email = batch.deliveries.find((d) => d.channelCode === 'email')!
  assert.ok(email.attempts.some((a) => a.ok === false && a.reason === 'channel_timeout'))
  assert.ok(email.attempts.some((a) => a.ok === true))
})

test('规则13+14: 批次可按渠道定位，也可按多字段关键字检索/搜索/查询/查找', () => {
  const engine = newEngine()
  const a = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  drain(engine)
  const b = engine.startBatch('tpl-quarterly', '2026Q4', 'html', 'none')
  drain(engine)

  // 按渠道编码定位。
  const byCode = engine.findByChannel('portal')
  assert.deepEqual(byCode.map((x) => x.id), [a.batch.id])
  // 按渠道目标名称定位。
  const byTarget = engine.findByChannel('营收专项')
  assert.deepEqual(byTarget.map((x) => x.id), [b.batch.id])
  // 搜索收件人姓名。
  const byRecipient = engine.searchBatches('周敏')
  assert.deepEqual(byRecipient.map((x) => x.id), [a.batch.id])
  // 搜索邮箱。
  const byEmail = engine.searchBatches('zhengkai@example.com')
  assert.deepEqual(byEmail.map((x) => x.id), [b.batch.id])
  // 搜索周期/模板名/批次号。
  assert.deepEqual(engine.searchBatches('2026Q4').map((x) => x.id), [b.batch.id])
  assert.deepEqual(engine.searchBatches(a.batch.id).map((x) => x.id), [a.batch.id])
  assert.deepEqual(engine.searchBatches('季度营收简报').map((x) => x.id), [b.batch.id])
})

test('规则15: 定位后查看与重试不改写原推送结果；补发是独立批次', () => {
  const engine = newEngine()
  const original = engine.startBatch(monthly(engine).id, '2026-10', 'pdf', 'zip')
  drain(engine)
  const snapshot: ReportBatch = JSON.parse(JSON.stringify(engine.getBatch(original.batch.id)))

  const located = engine.findByChannel('email')[0]
  engine.recordReceipt(located.id, 'email' as ChannelCode, located.deliveries[0].receiptId!)
  const reissue = engine.reissue(original.batch.id)
  drain(engine)

  const originAfter = engine.getBatch(original.batch.id)
  assert.equal(originAfter.id, snapshot.id)
  assert.equal(originAfter.templateVersion, snapshot.templateVersion)
  assert.equal(originAfter.period, snapshot.period)
  // 原批次的送达记录数量不被补发影响（重复回执只增加尝试，不改送达计数）。
  assert.equal(originAfter.deliveries.length, snapshot.deliveries.length)
  assert.equal(originAfter.deliveries.filter((d) => d.status === 'delivered').length, 3)
  assert.notEqual(reissue.batch.id, original.batch.id)
})

test('附加: 重复回执故障注入在首次推送成功时即登记去重记录', () => {
  const engine = newEngine()
  const started = engine.startBatch('tpl-quarterly', '2026Q4', 'pdf', 'none')
  // 不设 reason：送达成功，但渠道同时返回一张同号重复回执。
  engine.addScenario({
    id: 's-dup',
    batchId: started.batch.id,
    scope: 'channel',
    channelCode: 'im',
    remaining: 1,
    duplicateReceipt: true,
    note: '成功送达但渠道重复回执',
  })
  drain(engine)
  const im = engine.getBatch(started.batch.id).deliveries[0]
  assert.equal(im.status, 'delivered')
  assert.ok(im.attempts.some((a) => a.kind === 'duplicate_receipt'))
  assert.equal(im.attempts.filter((a) => a.kind === 'push').length, 1)
})
