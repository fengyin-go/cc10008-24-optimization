import type { ReportEngineState, ReportTemplate } from './types.ts'

/**
 * 种子数据：
 * - tpl-monthly：月度经营报告，20 张图、3 个渠道，对应“二十张图/第三个渠道断网”的场景。
 * - tpl-weekly：无图表周报，用于验证没有图表时仍生成封面说明、不产生空白文件。
 * - tpl-quarterly：单图季报，用于快速演示完整链路与重复回执。
 */
export function buildSeedState(now: number): ReportEngineState {
  const templates: ReportTemplate[] = [
    {
      id: 'tpl-monthly',
      code: 'REP-MONTH',
      name: '月度经营分析报告',
      version: 3,
      chartCount: 20,
      updatedAt: now - 1000 * 60 * 60 * 24 * 7,
      channels: [
        {
          code: 'email',
          kind: '邮件渠道',
          targetName: '管理层邮件组',
          recipients: [
            { userId: 'u-001', name: '周敏', email: 'zhoumin@example.com' },
            { userId: 'u-002', name: '李航', email: 'lihang@example.com' },
          ],
        },
        {
          code: 'im',
          kind: 'IM 渠道',
          targetName: '经营分析 IM 群',
          recipients: [
            { userId: 'u-003', name: '王珊', email: 'wangshan@example.com' },
            { userId: 'u-004', name: '陈牧', email: 'chenmu@example.com' },
          ],
        },
        {
          code: 'portal',
          kind: '门户渠道',
          targetName: '数据门户-月度专栏',
          recipients: [
            { userId: 'u-005', name: '赵宁', email: 'zhaoning@example.com' },
            { userId: 'u-006', name: '孙璐', email: 'sunlu@example.com' },
          ],
        },
      ],
    },
    {
      id: 'tpl-weekly',
      code: 'REP-WEEK',
      name: '无图表值班周报',
      version: 1,
      chartCount: 0,
      updatedAt: now - 1000 * 60 * 60 * 24 * 2,
      channels: [
        {
          code: 'email',
          kind: '邮件渠道',
          targetName: '值班邮件组',
          recipients: [{ userId: 'u-101', name: '值班长吴珂', email: 'wuke@example.com' }],
        },
        {
          code: 'portal',
          kind: '门户渠道',
          targetName: '数据门户-值班专栏',
          recipients: [{ userId: 'u-102', name: '值班员何静', email: 'hejing@example.com' }],
        },
      ],
    },
    {
      id: 'tpl-quarterly',
      code: 'REP-QUARTER',
      name: '季度营收简报',
      version: 2,
      chartCount: 1,
      updatedAt: now - 1000 * 60 * 60 * 24 * 14,
      channels: [
        {
          code: 'im',
          kind: 'IM 渠道',
          targetName: '营收专项 IM 群',
          recipients: [{ userId: 'u-201', name: '财务负责人郑凯', email: 'zhengkai@example.com' }],
        },
      ],
    },
  ]

  return { templates, batches: [], scenarios: [], seq: 0 }
}
