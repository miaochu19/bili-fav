const textOutput = (description) => ({
  schema: {
    type: 'object',
    required: ['ok', 'data'],
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: '执行成功为 true；失败会抛错而不是返回 false' },
      data: { description },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

// ---------------------------------------------------------------- 参数校验

function validate(args, { properties, required }) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象')
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new Error(`缺少必填参数 ${key}`)
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`未知参数 ${key}`)
    const rule = properties[key]
    const typeOK = rule.type === 'integer'
      ? Number.isInteger(value)
      : rule.type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === rule.type
    if (!typeOK) throw new Error(`${key} 类型错误（需要 ${rule.type}）`)
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`${key} 不在支持的选项内：${rule.enum.join(' / ')}`)
    if (rule.minLength !== undefined && String(value).length < rule.minLength) throw new Error(`${key} 不能为空`)
    if (rule.minimum !== undefined && value < rule.minimum) throw new Error(`${key} 不能小于 ${rule.minimum}`)
    if (rule.maximum !== undefined && value > rule.maximum) throw new Error(`${key} 不能大于 ${rule.maximum}`)
  }
}

// DSH 只接受受限 JSON Schema 子集；数值范围在 validate 里执行。
export function dshSchemaProperties(spec) {
  return Object.fromEntries(Object.entries(spec).map(([key, rule]) => {
    const { minimum, maximum, minLength, ...supported } = rule
    return [key, supported]
  }))
}

const BV_INPUT = {
  type: 'string',
  minLength: 1,
  description: 'BV 号（如 BV1xxxxxxxxx）或包含 BV 号的 B 站链接',
}

const noFavs = '还没有 data/favs.json：先用 bili_library(action="refresh") 或 node cli/fav.mjs fetch --all'

// ---------------------------------------------------------------- 工具定义

export function createBiliTools({ getOps, timeoutMs = 30 * 60 * 1000, portable = false }) {
  const tools = []
  const register = ({ execute, ...tool }) => {
    tools.push({
      ...tool,
      async execute(args, exec) {
        validate(args, tool.parameters)
        return execute(args, exec)
      },
    })
  }
  const get = async (exec) => {
    exec?.signal?.throwIfAborted()
    const ops = await getOps()
    exec?.signal?.throwIfAborted()
    return ops
  }

  // ---- bili_library：收藏库（统计 / 刷新 / 工作清单）
  const libraryProps = {
    action: {
      type: 'string',
      enum: ['stats', 'refresh', 'plan'],
      description: 'stats=看总量/覆盖率（默认，离线）；refresh=抓收藏夹（联网，全量可能很慢）；plan=挑下一批待整理的视频',
    },
    incremental: { type: 'boolean', description: 'refresh 时只抓新增（按收藏时间倒序，撞到已知条目提前收手）' },
    folder: { type: 'string', description: 'refresh 时只抓一个收藏夹（id 或名称）' },
    n: { type: 'integer', minimum: 1, maximum: 50, description: 'plan 返回的候选数量，默认 10' },
    minMinutes: { type: 'number', minimum: 0, description: 'plan 的最短时长（分钟）' },
    maxMinutes: { type: 'number', minimum: 0, description: 'plan 的最长时长（分钟）' },
    recentDays: { type: 'number', minimum: 0, description: 'plan 只看最近 N 天收藏的' },
    topic: { type: 'string', description: 'plan 只挑某个主题（主题地图里的分类名）' },
  }
  register({
    name: 'bili_library',
    description: 'B站收藏库。默认 stats 返回总量/有效/时长/笔记覆盖率，不联网；plan 挑下一批待整理视频并预估下载与拼图成本；refresh 抓取收藏夹（联网、可能很慢，默认全量，建议 incremental=true）。',
    parameters: { type: 'object', properties: libraryProps, required: [], additionalProperties: false },
    output: textOutput('{action 对应：stats=统计对象；refresh=抓取摘要；plan=候选清单}'),
    timeoutMs,
    async execute(args, exec) {
      const ops = await get(exec)
      const action = args.action ?? 'stats'
      if (action === 'refresh') {
        const logs = []
        const data = await ops.refreshLibrary({
          incremental: args.incremental ?? false,
          folder: args.folder ?? null,
          onLog: (line) => logs.push(line),
        })
        return { ok: true, data: { ...data, logs } }
      }
      if (action === 'plan') {
        const data = await ops.worklistSummary({
          n: args.n ?? 10,
          minMinutes: args.minMinutes ?? 0,
          maxMinutes: args.maxMinutes ?? 0,
          recentDays: args.recentDays ?? 0,
          topic: args.topic ?? null,
        })
        if (!data) throw new Error(noFavs)
        return { ok: true, data }
      }
      const data = await ops.statsSummary()
      if (!data) throw new Error(noFavs)
      return { ok: true, data }
    },
  })

  // ---- bili_find：找视频
  const findProps = {
    query: { type: 'string', minLength: 1, description: '口语查询，例如「那个讲四层工作边界的视频」；引号短语与英文/型号是硬约束' },
    top: { type: 'integer', minimum: 1, maximum: 20, description: '返回前 N 条，默认 5' },
    pages: { type: 'integer', minimum: 1, maximum: 5, description: '站内每路翻页数，默认 1' },
    orders: { type: 'string', description: '站内排序组合，逗号分隔，默认 totalrank,pubdate' },
    up: { type: 'string', description: '指定 UP 名：先搜用户再搜其空间（精度最高）' },
    duration: { type: 'string', description: '时长窗（分钟），如 "5-30"' },
    since: { type: 'string', description: '发布时间下限，如 "2026-10-01"' },
    related: { type: 'string', description: '从种子 BV 的相关推荐扩展召回' },
    local: { type: 'boolean', description: '是否带上本地收藏先验，默认 true' },
    space: { type: 'boolean', description: '指定 up 时是否搜其空间，默认 true' },
    refresh: { type: 'boolean', description: '忽略 6 小时搜索缓存' },
  }
  register({
    name: 'bili_find',
    description: '找视频：统一搜本地收藏（含已有笔记）与 B 站站内结果，按可解释分数重排并标明来源路线。找不到时返回最接近的候选和各自缺什么；不要把它当语义搜索。',
    parameters: { type: 'object', properties: findProps, required: ['query'], additionalProperties: false },
    output: textOutput('{query, parsed, recall, stats, hits[], nearMiss[]}'),
    timeoutMs: 10 * 60 * 1000,
    async execute(args, exec) {
      if (!args.query.trim()) throw new Error('query 不能为空')
      const ops = await get(exec)
      const orders = typeof args.orders === 'string'
        ? args.orders.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      const data = await ops.findVideos({
        query: args.query,
        top: args.top ?? 5,
        pages: args.pages ?? 1,
        orders: orders?.length ? orders : undefined,
        up: args.up ?? null,
        duration: args.duration ?? null,
        since: args.since ?? null,
        related: args.related ?? null,
        local: args.local ?? true,
        space: args.space ?? true,
        refresh: args.refresh ?? false,
      })
      return { ok: true, data }
    },
  })

  // ---- bili_feed：刷 B 站（发现新视频）
  const feedProps = {
    topic: { type: 'string', description: '主题最新：站内搜索按发布时间倒序，如 "DSH 插件"' },
    rcmd: { type: 'integer', minimum: 0, maximum: 5, description: 'B 站个性化推荐流页数（8 条/页），默认 2；0=不要推荐流。走登录态，最贴近你平时看什么' },
    hot: { type: 'integer', minimum: 0, maximum: 3, description: '热门页数（20 条/页），默认 2；0=不要热门' },
    rank: { type: 'string', description: '排行榜分区：全站/动画/音乐/游戏/娱乐/知识/科技/生活/美食/鬼畜/影视/数码，也可传 rid 数字' },
    days: { type: 'number', minimum: 0, description: '只要最近 N 天发布的，默认 30；0=不限' },
    minMinutes: { type: 'number', minimum: 0, description: '最短时长（分钟）' },
    maxMinutes: { type: 'number', minimum: 0, description: '最长时长（分钟）' },
    top: { type: 'integer', minimum: 1, maximum: 50, description: '返回前 N 条，默认 10' },
    includeFaved: { type: 'boolean', description: '不排除已收藏（默认排除），默认 false' },
    minInterest: { type: 'number', minimum: 0, description: '兴趣分下限；默认无 topic 时 1、有 topic 时 0' },
    refresh: { type: 'boolean', description: '忽略 30 分钟缓存' },
  }
  register({
    name: 'bili_feed',
    description: '替你刷 B 站：个性化推荐 / 热门 / 排行榜 / 主题最新取候选，默认排除已收藏，再按你收藏标题里的口味排序，每条给"为什么推给你"。找不到想看的时候用这个，找已知视频用 bili_find。',
    parameters: { type: 'object', properties: feedProps, required: [], additionalProperties: false },
    output: textOutput('{filter, model, recall, items[]}'),
    timeoutMs: 10 * 60 * 1000,
    async execute(args, exec) {
      const ops = await get(exec)
      const data = await ops.feedVideos({
        topic: args.topic ?? null,
        rcmd: args.rcmd ?? 2,
        hot: args.hot ?? 2,
        rank: args.rank ?? null,
        days: args.days ?? 30,
        minMinutes: args.minMinutes ?? 0,
        maxMinutes: args.maxMinutes ?? 0,
        top: args.top ?? 10,
        includeFaved: args.includeFaved ?? false,
        minInterest: args.minInterest ?? null,
        refresh: args.refresh ?? false,
      })
      return { ok: true, data }
    },
  })

  // ---- bili_read：证据包
  const readProps = {
    target: BV_INPUT,
    commentsOnly: { type: 'boolean', description: '只看评论区（不取字幕/不转写/不生成拼图），默认 false' },
    comments: { type: 'string', description: '评论条数："5"、"150" 或 "all"；只看评论区时默认 150' },
    asr: { type: 'boolean', description: '没有可用文字时执行本地 whisper 转写' },
    refresh: { type: 'boolean', description: '重新取官方材料（会绕过缓存）' },
    offline: { type: 'boolean', description: '完全离线复用已有素材' },
    depth: { type: 'string', enum: ['auto', 'shallow', 'detailed'], description: '笔记深度预算，默认 auto' },
    danmaku: { type: 'boolean', description: '是否取弹幕峰值（只看评论区时默认不取）' },
    maxAsrMinutes: { type: 'number', minimum: 1, maximum: 240, description: '超过该时长不做本地转写，默认 60' },
  }
  register({
    name: 'bili_read',
    description: '为一条 B 站视频生成本地证据包：简介、字幕/本地转写、评论、弹幕峰值、拼图索引。只返回证据摘要与文件路径。写笔记前必须先跑一次。' + (portable
      ? '用 bili_evidence 读取阅读指南、带段号的文字证据、简介和评论。'
      : '用 read 工具读 READING.md 与带段号原文（记得先看简介与评论）。'),
    parameters: { type: 'object', properties: readProps, required: ['target'], additionalProperties: false },
    output: textOutput('{bvid,title,duration,basis,transcript,description,sheets,danmaku,comments,warnings,readingGuide,packet,next}'),
    timeoutMs,
    async execute(args, exec) {
      const ops = await get(exec)
      const commentsRaw = args.comments ?? (args.commentsOnly ? '150' : '5')
      const comments = /^(all|全部|-1|\*)$/i.test(String(commentsRaw).trim()) ? Infinity : Number(commentsRaw)
      if (!(comments === Infinity || Number.isInteger(comments) && comments >= 0 && comments <= 1000)) {
        throw new Error('comments 必须是 0–1000 或 "all"')
      }
      const logs = []
      const data = await ops.prepareVideo({
        bvid: args.target,
        commentsOnly: args.commentsOnly ?? false,
        comments,
        danmaku: args.danmaku ?? null,
        asr: args.asr ?? false,
        refresh: args.refresh ?? false,
        offline: args.offline ?? false,
        depth: args.depth ?? 'auto',
        maxAsrMinutes: args.maxAsrMinutes ?? 60,
        onLog: (line) => logs.push(line),
      })
      return { ok: true, data: { ...data, logs } }
    },
  })

  // ---- bili_note：写 / 质检 / 重建索引
  const noteProps = {
    action: { type: 'string', enum: ['write', 'verify', 'index'], description: 'write=写入笔记；verify=质检；index=重建 vault 索引' },
    target: BV_INPUT,
    body: { type: 'string', description: portable ? '写笔记所需的 Markdown 正文' : '笔记正文 Markdown；写笔记时与 bodyFile 二选一' },
    tags: { type: 'string', description: '标签，逗号分隔，如 "AI,DSH"' },
    rating: { type: 'integer', minimum: 1, maximum: 5, description: '1–5 星，只在你真要评级时给' },
    basis: { type: 'string', enum: ['transcript', 'comments_only', 'mixed'], description: '依据来源；只看评论区时必须是 comments_only' },
    kind: { type: 'string', enum: ['summary', 'visual_only', 'advertisement', 'invalid'], description: '笔记类型，默认 summary' },
    allowLong: { type: 'boolean', description: '明确允许超过片长对应的正文字数上限' },
    depth: { type: 'string', enum: ['auto', 'shallow', 'detailed'], description: '与 bili_read 的 depth 对应，默认沿用素材包' },
  }
  if (!portable) noteProps.bodyFile = { type: 'string', description: '正文文件路径；写笔记时与 body 二选一' }
  register({
    name: 'bili_note',
    description: '写/质检 B 站笔记（Obsidian vault）。write 需要先 bili_read 生成素材包，正文按偏好写（自由体、时间戳内嵌、不套话），评论依据会被自动加"未看片"标记并校验；verify 检查结构/时间戳越界/图片链接/字数；index 重建收藏夹总表与标签页。',
    parameters: { type: 'object', properties: noteProps, required: ['action'], additionalProperties: false },
    output: textOutput('{action 对应：write=relPath/warnings；verify=ok/errors/warnings/统计；index=重建结果}'),
    timeoutMs: 10 * 60 * 1000,
    async execute(args, exec) {
      const ops = await get(exec)
      const action = args.action
      if (action === 'index') {
        const data = await ops.rebuildIndexes()
        return { ok: true, data }
      }
      if (!args.target) throw new Error(`${action} 需要 target（BV 号）`)
      if (action === 'verify') {
        const data = await ops.verifyNote({ bvid: args.target })
        return { ok: true, data }
      }
      // write
      let body = args.body
      if (!portable && !body && args.bodyFile) {
        const { readFile } = await import('node:fs/promises')
        body = await readFile(args.bodyFile, 'utf8')
      }
      if (!body) throw new Error(portable ? '写笔记需要 body' : '写笔记需要 body 或 bodyFile')
      const tags = typeof args.tags === 'string' ? args.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []
      const data = await ops.writeNoteFromBody({
        bvid: args.target,
        body,
        tags,
        rating: args.rating ?? null,
        basis: args.basis ?? 'transcript',
        kind: args.kind ?? 'summary',
        allowLong: args.allowLong ?? false,
        depth: args.depth ?? 'auto',
      })
      return { ok: true, data }
    },
  })

  if (portable) {
    register({
      name: 'bili_evidence',
      description: '按 BV 号分页读取 bili_read 已准备好的文本证据。建议先读 guide，再读 transcript。评论是观众说法，不能当作视频原文。',
      parameters: {
        type: 'object',
        required: ['target', 'kind'],
        additionalProperties: false,
        properties: {
          target: BV_INPUT,
          kind: { type: 'string', enum: ['guide', 'transcript', 'description', 'comments'], description: '阅读指南、带段号的字幕或转写（旧证据包可能只有原文）、视频简介、观众评论' },
          offset: { type: 'integer', minimum: 0, description: '分页起点，首次省略，后续使用返回的 nextOffset' },
          limit: { type: 'integer', minimum: 2, maximum: 8000, description: '每页最多返回的字符数（UTF-16 码元），默认 4000' },
        },
      },
      timeoutMs: 30 * 1000,
      output: textOutput('{bvid,kind,text,offset,nextOffset,totalChars}；nextOffset 为 null 表示读完'),
      async execute(args, exec) {
        const ops = await get(exec)
        return { ok: true, data: await ops.readEvidence({ ...args, bvid: args.target }) }
      },
    })
  }
  return tools
}
