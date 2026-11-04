# 003 执行

本文追踪已接受的 Ticket 在执行、交付和恢复过程中的状态。本文建立在 [001 领域模型](001-domain.md)和 [002 授权](002-authorization.md)之上。

## Ticket 阶段

每个打开的 Ticket 根据其等待的对象确定一个阶段。表格从上至下读取，首个匹配行生效。

| 阶段 | 条件 | 面板标签 |
| --- | --- | --- |
| person / delivery | 向 Executor Session 发送 Input 失败；2 秒后重试，之后延迟翻倍，最长一分钟；成功、新 Assignment 或 Ticket 结束时清除 | 输入未送达 |
| person / answer | 存在 Attention | 等待回答 |
| person / review | 最新 Report 为 `ready` | 等待评审 |
| person / blocked, failed | 最新 Report 为 `blocked` 或 `failed`，且此后没有人类消息送达 | 受阻 · 失败 |
| working / queued | 没有 Assignment，或 Assignment 待启动 | 排队中 |
| idle | 最新 Report 为 `waiting`，或 Assignment 已结束 | 等待触发 |
| working | 其他所有情况 | 工作中 |

`person` 阶段表示 Ticket 没有人类输入就无法继续。新的人类消息会解除 `blocked` 或 `failed` Ticket 对 Executor 的等待，使其进入下一匹配阶段，通常为 `working`。

`idle` Ticket 已结束轮次且没有待回答问题。订阅 Thread 上的 Trigger 可以使其继续。

## Executor

每个 Ticket 获得一个名为 `worker-<ticket id>` 的 Executor Session，以及以 Ticket 短名称命名的目录。目录创建在配置的执行根目录下，默认为 `<stateDir>/work`。

Executor Session 以操作人员的操作系统用户身份无需批准执行命令。其 `dsh-superagent-worker` 预设包含工作所需工具，并在 5 秒后将前台 shell 命令转为后台任务，使 Worker 不必等待长命令结束即可在下一步接收新消息。

主 Session 使用 `dsh-superagent-router`，具有相同的 5 秒 shell 和任务等待限制，以及较小的路由工具集。Session 保留创建时选择的预设。Worker 子智能体使用 DeepSeek Harness 的 `standard` 预设。

### 后台工作和 Worker 槽位

轮次结束时若仍有 shell 任务或子智能体运行，Ticket 保留 Worker 槽位并保持工作中，不报告等待，主 Session 也不会收到等待报告。任务或子智能体完成后，会在同一槽位携结果唤醒 Executor。轮次结束且没有后台工作时，Executor 正常报告等待。

每个轮次后，后台工作最多有 30 分钟完成。到达上限时终止 shell 任务，Ticket 报告等待。报告包含 Executor 最后的话以及哪些任务被终止或子智能体仍在运行。子智能体可以继续。Executor 在下一轮读取被终止任务的结果。

交接给人时立即释放槽位，Report 保持有效。这适用于 `ready` Report 或提问之后（除非此后收到其他 Input），以及任何 `blocked` 或 `failed` Report 之后。

交接时子智能体停止。供审查的服务器等 shell 任务可持续运行至 Assignment 结束；它们不占槽位，也不受 30 分钟限制，包括后续轮次之后。任务完成不会唤醒 Executor；它在下一轮读取结果。

人也可以直接在 Executor Session 中发消息启动一轮，其后台工作遵循相同规则。

Assignment 结束时，其 shell 任务被终止，但不唤醒 Session。其子智能体被释放，它们唤起的任何完成轮次都会被丢弃。替代 Assignment 及等待的 Input 在关闭完成后启动。

在 DeepSeek Harness 进程内停止或重启插件也使用相同关闭流程。尚未进入 Session 历史的 Input 会保留。关闭时每个 Worker 的后台工作最多等待 10 秒；进程重启会直接结束该工作。忙碌时被中断的 Assignment 会带恢复说明重新启动。

Worker 子智能体（包括嵌套子智能体）使用 DeepSeek Harness 的 `standard` 预设和 Worker 权限。它们只保留 Worker 允许的工作工具，并在 Ticket 结束时失去这些工具。`standard` 下 shell 命令在 60 秒后转后台。子智能体结束时，其任务被终止。

### 准备 Ticket 目录

第一次 Assignment 前，如果 Ticket 目录不存在，准备命令会在执行根目录通过 `sh` 运行一次，最多运行十分钟。未配置准备命令时，Worker 在空目录中启动。

命令失败会使 Ticket 失败并记录输出。重试或人在 Ticket Thread 上发消息会再次尝试准备。典型命令使用 `git worktree` 创建检出。拉取请求的分支路径最后一段与 Ticket 短名称相同时，该拉取请求属于该 Ticket。

### 并发

Ticket 从启动开始（包括准备阶段），或从唤醒空闲 Executor 的消息发送开始占用 Worker 槽位。活跃轮次期间也持续占用槽位。

配置的并发上限适用于这些槽位，另为人类消息或状态请求提供一个额外槽位。普通槽位已满时，此类唤醒可使用额外槽位；有新槽位时也优先于新启动。因此新工作不能阻止人继续已有 Ticket。

其他 Input（如 CI 结果）等待普通槽位。启动在 `working / queued` 等待空闲槽位。启动并发运行，因此慢速准备命令只延迟自己的 Ticket。

### 执行变量

准备命令和 Executor 指令收到相同的执行变量。命令读取环境变量；Executor 在提示词中读取值和描述。它们均不包含凭据。

| 变量 | 注册方 | 值 |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET` | Executor | Ticket 目录、短名称和 id |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Executor 不可运行的命令 |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | Source 监听的仓库，`owner/name` |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`, `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | 智能体账号及其提交邮箱 |
| `DSH_SUPERAGENT_GITHUB_NUMBER`, `DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | 发起 Ticket 的 Issue 或拉取请求编号，以及为拉取请求时的 head ref |
| `DSH_SUPERAGENT_FEISHU_BOT`, `DSH_SUPERAGENT_FEISHU_CHAT` | 飞书 | 机器人及发起 Ticket 的群 |

Ticket 专属值来自其目录和来源 Trigger；其他值来自当前部署设置。只有面板可以修改执行环境设置；发送给主 Session 的文本不能修改配置的 shell 命令。

Worker 通过智能体账号的 `gh` 访问 GitHub，通过机器人的 `lark-cli` 访问飞书。按名称调用禁止命令时会失败。

这些包装器和目录只建立默认行为，不构成安全边界。Worker 仍可通过绝对路径执行程序。

## 合并

自动合并由 **Delivery requirements** 提示词控制。宿主没有专门针对合并的决策逻辑。

默认情况下，Executor 从不以智能体账号启用自动合并：GitHub 会将合并归属于启用自动合并的人。Delivery requirements 必须指定另一个账号的合并 CLI；没有时由人合并拉取请求。

默认指令只允许对为该 Ticket 创建的拉取请求启用自动合并，条件是它已就绪、所需批准覆盖 head 提交，且新增行数加删除行数少于 200 行。推送新修订之前，Executor 撤销自动合并。

无正文的评审（如批准）也会作为 Trigger 到达，并可唤醒等待评审的 Executor。这些指令约束智能体，不约束 GitHub 的合并规则。要强制批准，应在分支保护中要求批准并撤销过期批准。省略合并 CLI 或删除自动合并段落即可要求手动合并。

## Ticket 如何结束

- **没有拉取请求时就绪：** `ready` Report 使 Ticket 以完成状态结束。
- **无事可做：** Executor 发现没有需要人处理的工作，例如请求无法复现或已被取代时，报告 `dropped`。Ticket 结束且不发消息，除非匹配规则要求发送；之后人对其 Thread 发消息会恢复它。

### 拉取请求

Executor 报告后，Ticket 会关注其起源拉取请求。Executor 报告或 GitHub Source 发现从 Ticket 分支创建的各个拉取请求后，也会关注它们。重新打开的拉取请求会再次被关注。

当 Ticket 创建的拉取请求都不再打开时即完成。如果它没有创建任何拉取请求，则其关注的所有拉取请求都必须关闭。此后它以最后一次相关关闭的结果结束，并保留 Subscription，使后续人类评论可以恢复它。

恢复、重试或恢复运行后的工作尚未完成时，关闭不会结束 Ticket。如果 Executor 已确认或回答它所负责的后续消息，但在读取该消息后还未作出非 progress Report 或结束轮次，也要等待。之后的 `ready` Report 在满足相同拉取请求完成规则时结束 Ticket。

聊天 Channel 收到一条关于拉取请求结果的最终通知。GitHub 已在拉取请求上显示结果。移除 Ticket 对拉取请求的 Subscription，也会停止对该拉取请求的关注。

因此，“等待评审”表示已有拉取请求且 Report 为 `ready`。

### 后续消息和上下文 Thread

Executor 决定 Ticket 自身 Thread 上的人类后续消息：处理范围内请求，将超出范围或属于其他 Ticket 的请求交回。没有 Executor 再拥有消息时，它成为主 Session 的候选。除此之外，主 Session 只能应人的请求根据后续消息停止工作。

Input 在 Session 将其纳入某一步，且随后报告或结束轮次后才算已读。Ticket 结束时，未确认、未回答、未交回的未读消息返回 Eval，详见 [002 授权](002-authorization.md)。已读但未采取行动的消息（如感谢）不会返回。

仅供上下文关注的 Thread 仍发送消息，但不会让 Ticket 拥有人类后续消息，也不会恢复已结束 Ticket。这些消息可以独立评估。

只要活跃 Ticket 订阅，Source 就轮询订阅 Thread；此后还会在最后一条 Trigger 与订阅 Ticket 结束时间的较晚者之后持续两周。之后消息只能通过常规入口到达：GitHub 通知或飞书实时事件。

## 失败和恢复

### Executor 受阻或失败

Executor Session 报告 `blocked` 或 `failed`，或者启动失败或出错（记录为 `failed`）时，Ticket 不接收自动 Input。

模型提供商或网络的暂时性失败会先重试三次，退避时间递增，包括 HTTP 408、429、5xx，以及连接拒绝、重置或超时：启动会重新运行，轮次失败的 Worker 会收到继续工作的指示；准备命令失败不会自动重试。

失败后，CI 和机器人消息仍记录在 Ticket 上，但不送达，也不唤醒 Session。

工具仍可使用，因此人可以直接在 Session 中继续。

失败的启动不会自行再次尝试。

人的消息、之后既非 `blocked` 也非 `failed` 的 Report，或重试，都会解除等待。

该状态由保存的 Report 和 Input 推导，因此重启后保留。

### 重试

打开的 Ticket 处于 `person / delivery`、`person / blocked` 或 `person / failed` 时可重试：创建新 Assignment，重新启动 Worker 并接收等待的 Input，以此处理上述情况。

一旦人的消息送达受阻或失败 Ticket，Executor 已收到该消息，因此 Ticket 显示为工作中；若失败启动重新开始则显示排队中。此时不提供重试，除非消息发送失败。

重试结束当前 Assignment，并在同一 Executor Session、目录、分支和拉取请求中启动新 Assignment。

Executor 模型仅在创建 Session 时生效；已有 Session 保留原模型。

### 重启

运行中的 Assignment 以“宿主已重启”结束，按最早 Ticket 优先创建新 Assignment。恢复说明要求 Executor 在重复任何外部操作前检查目录、git 历史和 GitHub。

处于等待、就绪、受阻或失败的 Assignment 保持原样，除非该 Report 之后有 Input 送达，此时也会重新启动。

Session、目录、Subscription、待发送消息及下述已保存工作在重启后保留。每个 Executor Session 将哪些消息纳入历史的记录也会保留：步骤领取消息后、调用模型前将其纳入历史；被重启中断的轮次所纳入的消息，在之后发生 Report 或轮次结束后算作已读；步骤领取但在进入历史前被取消或错误中断的消息算作未读。

重试或重启会将送达旧 Assignment、但其 Executor Session 未接收的消息再次交给新 Assignment，这些消息可能因取消或中断的步骤而丢失。重启保留或崩溃持久化后仍在 Session 中等待的副本，会在新 Assignment 的第一条消息之前移除，确保新发送的是唯一副本。

### 已保存工作

dsh-superagent 在决定后要做的工作，例如向主 Session 转发候选、后续消息或报告、启动 Assignment 或发送 Input，都会先保存再执行。

转发或发送失败（例如无法连接 Session）时，2 秒后重试，之后延迟翻倍至最多一分钟；启动失败会使 Ticket 失败，上述暂时性失败除外。

某类工作只有在其中一项连续失败三次后，才在概览的系统问题中报告错误；Input 发送失败则显示在其 Ticket 上。

发往主 Session 的转发按序执行，通知也各自按序执行；失败项会阻塞同类后续项。

### Source 失败

GitHub Source 独立读取每个 Issue、拉取请求和 Thread：读取失败会将错误保留在该 Thread，下次轮询重新读取，并计入 Source 错误。默认连续三次轮询失败后报告；任一次成功轮询都会重置计数。

智能体失去私有仓库访问权限时 GitHub 也会返回 404，因此 404 会重试。

收到通知的 Issue 或拉取请求若持续读取失败，会在首次读取失败一天后丢弃；GitHub 报告它已删除时立即丢弃。此后它不再导致轮询失败，其 Thread 保留错误，Source 状态会列出它。

其读取位置保持不变，因此后续通知或 Thread 轮询可以读取先前失败遗漏的内容。

飞书事件消费者报告每次失败，订阅话题轮询则将每次失败保留在对应 Thread。

GitHub 列表或飞书页面中的格式错误项会被跳过，Source 状态记录数量。

### Channel 失败

外发消息作为已保存工作存储和发送，失败时从 5 秒开始退避重试，逐次翻倍至 300 秒。

一个 Ticket 发往同一对话的消息按排队顺序发送，确保确认先于后续答复或结果：当同一 Ticket 发往同一对话的更早消息尚未发出时，后续消息等待，直到更早消息连续失败三次并显示为问题。

其他 Ticket 的消息及不属于 Ticket 的消息不受其阻塞。

有失败尝试的消息会一直显示为系统问题，直到成功发送或撤回。

仅当 Source 不再监听对话，或 Source 回答该对话永远无法接收时，消息才被丢弃；Source 关闭时消息等待。

GitHub 上已删除的 Issue 或锁定的对话，以及飞书上撤回或无法找到的消息，Source 会作出无法接收的回答。

对已不存在评审评论的回复会改发到拉取请求对话。

丢弃的消息保留记录，包括丢弃时间、原因和所属 Ticket，因此绝不会再次排队；丢弃的确认显示为已丢弃，而非已发送。

### 暂停处理

暂停会停止派发、新 Eval、Eval 超时、Input 发送和回复；已开始的启动等待处理恢复。

Source 继续记录 Trigger，运行中的 Executor 轮次不会中断。

发给已结束 Ticket 的人类消息会等待：暂停后第一次处理时，如果当时的 Policy 仍认可其 Mandate，就恢复 Ticket。

进行中的 Eval 在暂停期间不会超时；其截止时间按暂停时长顺延。

### 无效配置

已保存的 Source 配置如果被其 kind 拒绝，会禁用该 Source 实例。
