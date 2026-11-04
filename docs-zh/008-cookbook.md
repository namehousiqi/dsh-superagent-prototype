# 008 扩展指南

本指南介绍如何扩展 dsh-superagent。它使用 [001 领域模型](001-domain.md)和 [002 授权](002-authorization.md)中的术语，以及 [007 架构](007-architecture.md)中的组件。

## 添加 Source

本示例实现名为 `webhook` 的 Source kind。它通过虚构的 CLI `hookq` 读取假想消息队列，并将消息转换为 Trigger。其他接口均属于 dsh-superagent。

实现有四项职责：转换事件、定义接收和授权规则、提供回复及上下文，以及维护轮询循环。以下编号步骤依次构建这些部分。

示例假设此 CLI 具有以下约定：

- `hookq pull --after <n> --json` 按最早优先打印位置 `n` 之后的消息：`{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`。每项包含 `id`、`conversation`、`thread`（线程首条消息的 id，首条消息自身没有该字段）、带 `id` 和 `bot` 的 `sender`、`mentions_me`、`text`、`at` 和 `url`。
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` 在某条消息下回复，每个 key 只发送一次。对话已删除时，标准错误输出 `{"error": {"code": 410, "message": "…"}}` 并失败。
- `hookq thread --conversation <id> --root <message id> --json` 按最早优先打印一个线程页；使用 `--after <cursor>` 读取后续页：`{"items": […], "next": "<cursor>"}`，最后一页不包含 `next`。

参照 `src/sources/github.ts`，将 kind 和插件入口放在 `src/sources/webhook.ts`。Source 变大时，可像飞书 Source 一样将转换、Channel 和轮询代码拆分为独立模块。

### 1. 将事件映射到领域

编写代码前先选择稳定映射。Trigger id、Thread id 和 Channel 地址会持久化，因此之后更改可能断开已有记录。

| 概念 | webhook 队列中的映射 |
| --- | --- |
| Trigger | 一条消息 |
| Thread | 一个对话中的消息及其回复：`<conversation>:<id of the first message>` |
| Actor | 发送者在队列上的 id，使用允许名单中的名称 |
| Channel 地址 | 对话和回复所针对的消息 |
| 接收范围 | 一个对话，在准入表中有独立行 |

### 2. 配置：schema、字段、事实和健康状态

模块导入以下步骤需要的内容：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
```

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // find, scope, channel, threadContext, policy and environment follow in the next steps.
}
```

- `kind` 是稳定的 Source id，出现在 Trigger 的 `source`、Thread 键前缀、`source:webhook` 设置块和 Source Policy 中。
- `schema` 校验已保存配置并提供默认值。操作人员保存实例前，注册表根据这些默认值创建启用实例。默认值应不接收任何消息；本例默认为没有对话。
- `fields` 无需自定义面板代码即可生成 Source 设置表单。`rows` 字段以第一列为键编辑条目；`advanced` 隐藏不常用设置。如果 Source 能将 id 解析为显示名称，实现 `refreshLabels`，将名称保存到 `KV.sources.labels(kind)`；带 `choose` 和 `refresh` 的列即可提供这些名称。
- 可选的 `facts(deployment)` 显示设置流程推导出的值，如 CLI 对应的账号。设置目前只检查 `SETUP_FIELDS` 中列出的 GitHub 和飞书字段，因此本例不提供 facts。
- `health` 声明 Source 的健康项，初始为 `starting`。注册时声明各名称，并拒绝与 `runtime`、`reply`、`worker` 或 effect 类型等条目冲突。使用 kind 名称，将 `sync:<id>` 留给 Policy 同步。`error` 会使状态脚本以 2 退出，并使每小时检查通知操作人员，因此只在可能需要人工操作时报告。

### 3. 将消息转换为 Trigger

转换前校验 CLI 响应：

```ts
/** One message as `hookq pull` and `hookq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** The answer of `hookq pull`, whose items are read one by one, and of `hookq thread`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** The Trigger of one queue message; the agent's own messages produce none. */
export function webhookTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key('webhook', message.id),
    source: 'webhook',
    threads: [{ source: 'webhook', id: thread }],
    actor: { source: 'webhook', id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: 'webhook', thread: `webhook:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **稳定 id。** 使用 `key` 从队列 id 派生 Trigger id。`Engine.receive` 对已存储 id 返回 `duplicate`，重复接受也只创建一个 Ticket，因此重新读取消息是安全的。要将编辑视为新事件，可像 GitHub 对评论使用 `updated_at` 一样，在 id 中包含编辑版本。
- **Thread。** 第一个 Thread 是主要 Thread，拥有 Eval。其他 Thread 提供 Correlation 上下文。Source 选择 id；其完整键为 `webhook:<id>`。
- **发送者。** `actor` 使用 Source 原生 id。机器人和 CI 设置 `human: false`。列出的机器人只能成为推断候选。CI 等空 actor id 使用“不在名单、未指向智能体”的准入单元格。只有消息确实指向智能体时才将 `addressed` 设置为 `mention` 或 `direct`；这会使允许名单中人的消息具有明确强度。绝不要为智能体自己的消息产生 Trigger。
- **回复目标和元数据。** `channel` 标识回复位置；`url` 链接来源消息。`channel.thread` 对消息分组以按序发送：Ticket 后发的消息须等待先前消息，直到先前消息失败三次。其他 Ticket 不需等待。Source 专属字段放在 `meta` 中，例如接收对话和 Thread 根。`meta` 和 `text` 均是不可信数据，不是授权。

智能体可通过 `orchestrator_read trigger/<id>` 和 `thread/<key>` 读取新 kind，获取消息文本、去向和相邻 Trigger。新 kind 不会自动获得内置技能、原始服务记录资源或拉取请求绑定。

文本搜索不需要额外代码。人们使用消息 id、URL 或 `#12` 等 Source 专属引用时，实现 `find(query)`，返回这些引用所识别的 Thread 键和搜索词：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

这里会使用查询中的队列消息 id（如 `m42`）搜索 Trigger。

### 4. Source 接收的内容：scope

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

Engine 通过 `SourceRegistry` 对每个传入 Trigger 调用 `scope`。范围外消息连同原因保存为已过滤，且不创建 Thread。应将消息传给 `receive`，而不是在轮询循环中静默丢弃，以便面板解释过滤原因。

`observed: true` 表示 Source 接收该范围内未指向智能体的消息，允许准入表对其作出决定。`row` 标识对应的准入行。

重新验证使用 Mandate 保存的元数据调用 `scope`，因此应只依赖 `meta` 和配置。恢复需要 `listened`，不需要 `observed`。没有 `scope` 时，kind 接收其产生的每个 Trigger，但不观察任何范围。

### 5. 回复：Channel

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **幂等发送。** Outbox 调用 `SourceRegistry.send`，后者调用 `channel.send`。Source 插件未加载时消息等待。远端服务收到消息后发送仍可能失败，因此重试不能重复发送。使用 `message.id` 作为幂等键：`hookq` 支持 `--key`；GitHub 保存隐藏评论标记；飞书接受幂等键。
- **永久失败与可重试失败。** 成功返回 `sent`；只有永久无法送达时才返回 `gone`，例如本例的 410。gone 消息保留为已丢弃且不会再次排队，显示在 `GET sources` 和 Source 页面。其他失败应抛出异常，让 Outbox 在 5 秒后重试，逐次翻倍至 300 秒。`CliError.code` 是 CLI 输出报告的代码。
- **允许的目标。** `allowed(address, config)` 只检查已保存地址和当前配置。所有必要事实都应放入地址；例如飞书记录是否为私聊。不再监听的目标会丢弃消息，而禁用 Source 会让消息等待。没有 `allowed` 时，Source 启用期间允许所有地址。
- **链接。** `link(address, links)` 返回面板通过 `SourceRegistry.link` 显示的 URL 和标签。

### 6. 供研判使用的 Thread 上下文

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // A queue thread is flat: its root, and the message a reply answers, are on its first page, as on GitHub.
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

主动研判需要 Trigger 周围的对话。`orchestrator_eval` 读取初始窗口；`orchestrator_eval_read` 展开页面、根消息或父消息。实现可选的 `threadContext` 接口以提供这些读取：

- `read(commands, trigger, part, cursor, config)` 返回 `ContextPart`。其 `messages` 使用 `ContextMessage`：`{id, from, at, text}`，以及适用的 `bot`、`deleted`、`reply_to`、`url`、`path`、`line` 字段。最后一页省略 `next`。`body` 是展示给研判 Session 的内容，本例中是同一组消息。可选 `status` 可描述特殊结果，如飞书的 `chat_neighbours`。`part` 为 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 从中找到 Trigger 自身的消息。
- `images(text)` 和 `image(…)` 用于消息携带图片的 kind，如飞书；本例省略。

没有 `threadContext` 的 kind 不向研判提供 Thread 上下文；Trigger 自身文本仍可读取。

如果消息回复较早的消息，添加 `repliesTo(trigger)`。它返回对应 Trigger id，使后续消息通知和 Worker Input 在已保存时显示被回复的消息。例如，`hookq` 提供 `reply_to`，且转换时将其保存为 `meta.replyTo`：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. 谁可以请求：Source 的 Policy 部分

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` 校验 Source Policy，包括 `allowed` 发送者 id。id 比较不区分大小写。准入表单独校验并由各 kind 共享。此 Policy 部分保存于 `policy.sources.webhook`，并参与计算 Policy 版本。
- `fields` 生成**评估 → 各来源**下的表单，以 `allowed` 开头。`explicit` 说明如何向智能体发送消息。可选的 `unnamed: {person, bot}` 为飞书 `ou_…` 等不透明 id 提供显示标签；本例的队列 id 是可读名称，因此省略。
- `rows(config)` 列出准入范围及可用单元格。每个行 id 必须与 `scope` 返回的 `row` 匹配。未指向智能体的消息对应的单元格，仅在 Source 观察这些消息的范围内可用。没有 `rows` 的 kind 使用默认单元格。
- 可选 `bots` 列出可成为推断候选的机器人，其条目形状与 `allowed` 相同。没有它时不准入机器人。
- 可选 `sync: {label, ready(part), run(host, part, signal)}` 在启动时和点击**立即同步**时刷新成员。飞书使用群成员。失败显示在 `sync:<id>` 下，一分钟后重试，逐次翻倍至一小时，直到成功。

### 8. Executor 的变量

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

即使 Source 已禁用，执行设置仍在准备命令旁显示声明的 `variables`。启用时，`values` 使用部署、配置和来源 Trigger 提供 Ticket 专属值。

准备命令读取环境变量；Worker 在指令中读取其值。使用 `DSH_SUPERAGENT_<KIND>_…` 前缀，对来自其他 Source 的 Ticket 返回空值，绝不包含凭据。

### 9. 插件入口及其循环

```ts
export const name = 'dsh-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

插件注入 `orchestrator`。第一个 effect 注册 kind，并在销毁时注销；第二个使用 `SourceContext` 运行轮询循环。销毁时中止循环并等待完成，应用停止或重启时也如此。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>('webhook')
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in each message, then move the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor, page.next)
  return { read: page.items.length, unreadable }
}
```


- **设置与开关。** 等待 `ctx.ready`；`ctx.configured()` 为 false 时不读取任何内容。每轮读取 `ctx.config(kind)`：Source 关闭时其值为 undefined。
- **游标。** 使用 `KV`（`src/kv.ts`）中的类型化条目将读取位置存入 `ctx.state`，例如 `webhook: {cursor: record<number>('webhook-cursor')}`。`tests/store.spec.ts` 要求键字面量只出现在该注册表。外部包可使用导出的 `record` 和 `family` 定义键。设置为 `undefined` 会删除记录；`ctx.atomic` 将写入组合在事务中。

  只有保存所有覆盖的 Trigger 后才推进游标。中断的轮次保持游标不变；稳定 id 使重放安全。对于时间戳游标，`src/sources/poll.ts` 的 `cursorAt(started)` 减去五秒，以容纳远端延迟写入。
- **Thread 元数据。** 收到 Trigger 后调用 `ctx.threads.describe(key, {label, url, facts})` 填充显示信息。`ctx.threads.patch(key, meta)` 委托给 `threads.patchMeta`，设置 Source 拥有的键，值为 `undefined` 时删除。两者都忽略不存在的 Thread，包括过滤掉的 Trigger 所属 Thread。
- **逐项错误。** 对格式错误的条目计数并继续，不使整批失败。`src/infra/commands.ts` 中的 `validItems(item, list, tally)` 支持该模式。独立轮询的 Thread 使用 `src/sources/poll.ts` 中的 `pollThreads`，它将每次失败记录为 `pollError`。其 `polled` 谓词保留活跃订阅，以及最后 Trigger 与 Ticket 结束时间较晚者之后两周的窗口。
- **健康状态。** 只通过 `ctx.report` 写入已声明条目。`health(state, code, values)` 提供 `setupPending`、`sourceOff`、`pollFailures` 等固定消息。报告 `error` 前统计连续失败次数。
- **中止。** 将 signal 传给 `ctx.commands.withSignal(signal)` 和 `delay`，并在各项之间检查，使停止或重启能立即结束循环。

本例不发送 Source 发起的通知。需要通知的 Source 调用 `ctx.notify`；Outbox 像其他回复一样发送它们。

本例也不将 Thread 与 Ticket 完成状态绑定。只有 Source 的 Thread 生命周期决定工作是否完成时才使用 `ctx.tickets.bindThread` 和 `threadClosed`，例如 GitHub 拉取请求。Ticket 何时结束仍由 Engine 决定。

### 10. 注册插件

在 `tsdown.config.ts` 中将模块构建为独立入口：

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

然后在 `package.json` 的 `exports` 中添加 `"./webhook-watch": "./lib/webhook-watch.js"`，导出构建文件；并像飞书一样，将插件以禁用状态添加到 bundle 的 `cordis.patch.yml` 中的 `insert` 列表：

```yaml
    - id: dsh-superagent-webhook
      name: dsh-superagent/webhook-watch
      disabled: true
```

在配置档案的 `cordis.patch.yml` 中使用 `id: dsh-superagent-webhook` 和 `disabled: false` 启用插件。构建并重启。新 Source 出现在来源设置及**评估 → 各来源**下。

将模块和测试加入 [007 架构](007-architecture.md)的模块表和测试表。`tests/docs.spec.ts` 检查两个索引是否完整。

### 11. 测试

按照 `tests/sources.spec.ts` 的模式创建 `tests/webhook.spec.ts`：临时目录中的真实 Store、带 `HealthBoard` 的 `SourceRegistry`、使用替身端口的 Engine，以及从 `sourceContextOf` 获取的 `SourceContext`。

通过 spy 监听 `Commands.run` 来模拟 CLI 调用。也要监听 `withSignal`，因为它通常返回新的 `Commands` 实例。

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // The registry claims the kind's health entries on the board, where the test reads them.
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The Source's own notices go to the outbox, which keeps their receipts and sends nothing here.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** The queue as `hookq` answers it. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor)).toBe(3)
  // An allowed sender who mentions the agent makes an explicit request.
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` 构建一个队列项。至少覆盖：

- 转换：稳定 id、Thread、actor、`human` 和 `addressed`，以及智能体自身消息不产生 Trigger；
- 一轮轮询：Trigger 只保存一次，范围外项为 `filtered`，之后推进游标，允许名单中发送者的提及评估为 `explicit`；
- 中断的轮询保持游标不变；
- `send`：`sent`，仅对 410 返回 `gone`，其他失败抛出异常，CLI 错误由 `commandError` 构造；
- Thread 上下文：一页消息及下一页游标，参照 `tests/registry.spec.ts` 通过 `SourceRegistry.threadContext` 读取 kind 的 Thread；
- 插件：`apply` 注册 kind，在等待设置时报告 `setupPending`，销毁函数注销 kind，逃出循环的失败成为 Source 健康状态而非未处理拒绝；
- Source 的 Policy 部分和准入行，参照 `tests/registry.spec.ts` 和 `tests/policy.spec.ts` 对飞书 Source 的检查。

### 检查清单

1. 映射 Trigger、Thread、actor、Channel 地址和接收范围。
2. 编写 kind：`schema`、`fields`、`health`，以及设置流程可推导时的 `facts`。
3. 将事件转换为具有稳定 id 的 Trigger，丢弃智能体自己的消息。
4. 仅根据 `meta` 在 `scope` 中决定 Source 接收什么。
5. 提供 Channel，其 `send` 对每条消息只发布一次，仅在对话永久无法接收时返回 `gone`。
6. 如果能读取 Thread，为研判提供其上下文。
7. 提供带 `allowed` 和准入行的 Policy 部分。
8. 注册执行环境变量。
9. 编写插件入口及循环：等待设置、遵循开关、在 `receive` 后推进游标、保留逐项错误、报告健康状态并在中止时停止；在 `KV` 中命名游标。
10. 添加构建入口、导出和 `cordis.patch.yml` 插入项，在 007 的表中列出模块及其测试。
11. 按 `tests/sources.spec.ts` 测试其他 Source 的方式测试它。
