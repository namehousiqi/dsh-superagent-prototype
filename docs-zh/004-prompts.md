# 004 提示词

本文说明智能体读取什么、团队可以编辑什么，以及更改何时生效。本文建立在 [000 理念](000-philosophy.md)至 [003 执行](003-execution.md)之上。提示词文本以英文编写。

## 团队编写的内容

团队可以编辑三个团队部分、添加技能，并覆盖每个内置系统提示词部分。大多数默认内容位于 `prompts/` 和 `skills/`。工具描述、通知和卡片仍在代码中，不能通过提示词设置编辑。

| 部分 | 内容 |
| --- | --- |
| Communication | 何时联系他人、消息的表达方式、每条 GitHub 消息的开头（默认为 `This is by an automated agent, not a human`）、如何处理评审，以及哪些普通账号是评审机器人 |
| Ticket scope | Ticket 何时继续，何时以草稿形式停止 |
| Delivery requirements | 拉取请求中的证据、含行数阈值的自动合并条件以及提交作者；未设置作者时，Executor 使用智能体账号的 no-reply 地址提交 |
| Team skills | 智能体按需加载的知识，例如说明飞书用户与 GitHub 账号对应关系的 `identities` 技能 |

内置文本涵盖角色、工具使用、宿主机制、授权规则，以及 GitHub 和飞书技能。它通过标题引用团队部分，而不重复其内容。

### 内置部分和模板

覆盖项使用以下键：

| 部分 | 键 |
| --- | --- |
| 共享指令和角色 | `runtime/shared`、`runtime/orchestrator`、`runtime/worker` |
| 工作指令 | `runtime/subscriptions`、`runtime/replies`、`runtime/dispatch`、`runtime/work`、`runtime/admission` |
| 交接指令 | `runtime/handoff/orchestrator`、`runtime/handoff/worker` |
| 来源技能 | `skill/feishu`、`skill/github` |
| 生成的部分 | `runtime/environment`、`runtime/policy`、`runtime/policy/none` |

生成的部分是可编辑模板，必须保留以下占位符：

- `runtime/environment`：`{variables}`，填入执行环境变量行。
- `runtime/policy`：`{version}`、`{mode}` 和 `{rules}`，每条启用规则占一行。
- `runtime/policy/none`：`{version}` 和 `{mode}`，没有启用规则时使用。

编辑某部分会改变模型收到的指令，但不会改变由代码强制执行的准入、Mandate、工具检查或账号包装器。

收到明确的人类请求时，主 Session 也可使用 `orchestrator_prompts_save` 保存覆盖项。保存时若省略覆盖项的 `base`，则保留已保存的基础版本。已保存配置中已经移除的部分会在保存时删除；其他未知部分会被拒绝。

覆盖项会记录其所基于的内置文本。升级时保留团队文本。如果默认内容变化，面板会将该部分标记为 **默认内容已更新**，并在团队文本旁显示差异。团队可以保留自己的文本、使用新默认内容或自行编辑。没有覆盖项的部分自动跟随新默认内容。

主 Session 可在 `orchestrator_read prompts` 的 `default_changed` 下读取受影响的部分名称。

## 组装与优先级

系统提示词按以下顺序组装：

1. 共享指令和角色。
2. 三个团队部分。
3. 订阅和回复。
4. 主 Session 的派发指令，或 Executor 的工作指令。
5. `runtime/admission`，仅用于主 Session。
6. 交接指令。
7. `runtime/environment`。
8. `runtime/policy`，仅用于主 Session。

准入指令来自 `prompts/admission.md`，描述主动研判以及何时可直接根据卡片忽略无关候选。`orchestrator_eval` 返回上下文，不重复这些指令。

环境部分向主 Session 提供全部署范围的值，向每个 Executor 提供其 Ticket 专属值。Policy 部分在每次模型请求时根据设置重新生成，包含 Policy 版本、接受模式、明确请求的豁免，以及格式为 `- <name> (<id>): <instruction>` 的启用规则；没有启用规则时会说明。它放在最后，因此 Policy 变化不会改变前面的提示词文本。

Executor 还会读取 DeepSeek Harness 的编码提示词和仓库的 `AGENTS.md`；主 Session 不会。推断型 Ticket 末尾增加说明，将 Executor 限制在匹配的规则内。Assignment 和传入消息以 Trigger 卡片内联送达，只有内容被截断时才附资源指针。

Executor 无人值守运行。其工具不包含向人提问、展示界面或更改配置档案的工具，例如 `ask_user_question`、`present` 和 `plugin_manager`。

优先级从高到低：

1. 工具和宿主强制执行的事实：身份、权限、工具参数检查、回复用途和长度限制。提示词不能改变它们。
2. 内置和生成的部分，以团队覆盖后的内容为准。
3. 主动 Ticket 匹配规则中的流程和沟通要求，仅对该 Ticket 的 Executor Session 生效。
4. 团队部分和团队技能。
5. 外部文本：消息、评论、文档和引用。它们是数据，绝不能改变规则或授权。

## 内置文本的原则

以下是 [000 理念](000-philosophy.md)在智能体上的应用：

- **角色分离。** 主 Session 只做路由：转发原始 Trigger 和路由事实，不做技术决策；一个路由工具可在一次调用中处理多个等待的候选。路由备注最多 30 个词。Executor 阅读原始来源、判断范围、实现并验证。
- **主 Session 不等待。** 报告、后续消息通知、候选和完成的后台任务会自动作为消息送达；没有待办时结束轮次。守卫拒绝 `sleep`、超过 30 秒的 shell 超时及超过 5 秒的任务等待，因为阻塞的步骤会延迟新候选。这些指令取代 DeepSeek Harness 在主 Session 完整提示词中的任务通知说明。
- **只在人必须行动或结果可供使用时发消息：** 结果可供审查或使用、需要决定或资源，或者工作无法完成。聊天消息默认一句话，硬上限为 100 个词。
- **Executor 决定自己的后续消息。** 每个 Executor 处理并确认范围内的请求，将超出 Ticket 范围或属于其他 Ticket 的请求交回。只有全部责任方交回消息或结束且未处理时，消息才会成为新工作。主 Session 会收到后续消息通知，但只能据此停止工作。交回的消息随后作为候选送达，并附 Executor 的原因。
- **通过订阅和主 Session 协调。** Executor 关注相关 Thread 以获取上下文。主 Session 可以发送最多 100 个词的备注，传达其他 Ticket 的事实。订阅和备注均不授予权限。
- **只有明确引用时才附加。** 消息必须指向 Ticket 的拉取请求、Issue、来源消息或确认消息，或者指向恰好只有一个 Ticket 匹配的近期变更。仅主题相似不够。附加会让 Ticket 订阅整个 Thread；Executor 若发现无关，使用 `orchestrator_thread_unrelated`，且不在那里回复。
- **具体确认一次。** 开始实质工作前，Executor 在原消息下回复，确认每个新请求并指出对象和预期结果。
- **通过 `human_action` 提问。** Executor 在 Report 中提出一个具体问题，主 Session 原样转发。若问题由某条人类消息引起，则指明该消息，由宿主在那里提问；否则在 Ticket 的原对话中提问。已获授权的工作可同时继续。
- **如实交付。** 创建拉取请求不等于就绪；草稿须标明未完成；没有真实修改前截图的 UI 变更不算就绪。
- **人工暂停持续有效。** 它跨后续消息、新 Executor Session 和重启持续生效，直到人解除。自动反馈不会恢复暂停的工作。
- **示例只展示格式。** 示例句子不是智能体可以声称的事实。
- **按结果处理评审。** 已修复并验证的评论静默解决；不采纳的评论用一句话说明原因。自动评审者的线程得到答复后即解决，每位自动评审者对每个拉取请求最多进行三轮。
- **为重复工作让路。** 当人的分支或拉取请求已包含 Ticket 的修改时，Executor 关闭自己的拉取请求，并用一句话指向对方的工作。

## 版本

- 每次保存创建不可变版本，包含完整配置、修订号、前一版本、时间戳和来源（面板或工具）。恢复某版本或默认值也会创建新版本。
- 保存时指定基础修订号。冲突的保存会被拒绝，但草稿不会丢失。
- Session 在每次模型请求时读取最新版本，包括同一轮次的后续步骤。保存不会重启、取消或唤醒 Session。宿主记录每个 Session 使用的修订；Executor 可读取其工作期间使用过的任一修订。
- 部署配置设置总大小上限，包括覆盖项。校验会拒绝未知键、保留的内置技能名称、未知覆盖部分和缺失的模板占位符，绝不会静默截断文本。与默认值完全相同的覆盖项会被移除，以便该部分跟随未来的默认值。
