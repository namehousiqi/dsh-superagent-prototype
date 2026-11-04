# dsh-superagent

> **本项目是仅供参考的研究原型，并非 DeepSeek 官方产品。** 这些代码源于团队日常开发工作，其中大量工程工作由编码智能体完成。请将其视为研究代码，而非可直接投入生产的软件。代码可能仍存在缺陷，编码风格和工程实践也可能不一致。在自己的环境中使用之前，请先审查并根据实际情况调整。
>
> 本项目经过了公开发布所需的调整，因此与内部版本及文章 *Exploring Super-agent Design: Towards a More Autonomous Agent System* 中描述的实现并不完全相同。文章讨论的部分设计是未来发展方向，尚未在此原型中实现。

dsh-superagent 是一个面向单个 GitHub 仓库的主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) bundle 的形式提供。它监听 GitHub，并可选接入飞书。当获准的人员向智能体请求工作时，它会创建工作项，在独立的智能体 Session 和目录中执行，并在原对话中回复，例如提供拉取请求。Web 面板展示需要人工处理的事项。

它也是一种与智能体协作的方式：**尽量少占用人的注意力，尽量多创造价值。** 能够为整个团队行动的智能体也可能浪费整个团队的注意力，因此它只在有人请求或团队编写的规则允许时行动，只在有人必须采取行动或可以使用结果时发言。[000 理念](docs-zh/000-philosophy.md)解释了这一原则及其对操作人员的要求。

## 安装设置

设置步骤较多，因此由智能体与你一起完成。向你的编码智能体提出以下请求：

> 阅读本仓库中的 SETUP.md，并与我一起设置 dsh-superagent。

它每次只提出一个简短问题，集中展示一次完整计划，然后完成安装和配置。它遵循的说明见 [SETUP.md](SETUP.md)。

## 文档

请按编号顺序阅读；每篇文档只依赖之前的文档。

- [000 理念](docs-zh/000-philosophy.md)
- [001 领域模型](docs-zh/001-domain.md)
- [002 授权](docs-zh/002-authorization.md)
- [003 执行](docs-zh/003-execution.md)
- [004 提示词](docs-zh/004-prompts.md)
- [005 面板](docs-zh/005-panel.md)
- [006 部署](docs-zh/006-deployment.md)：手动安装、配置、升级和故障排查
- [007 架构](docs-zh/007-architecture.md)
- [008 扩展指南](docs-zh/008-cookbook.md)：添加 Source

## 开发

`pnpm check` 依次运行类型检查、测试和构建。

## 许可证

[MIT](LICENSE)
