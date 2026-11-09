# dsh-local

[English](README.md) | 中文

dsh-local 是 DSH 的本地优先发行版，基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建。它由个人独立维护，与 DeepSeek 无隶属关系，也未获其认可。

<a id="about-this-distribution"></a>
## 关于本发行版

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架），构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动。dsh-local 保留其代码，并增加了交互式终端应用、面向自有硬件上所运行模型的 profile 层、基于决策模型的上下文修剪，以及 Exa 和 Tavily 网页搜索。[在本地模型上运行](docs/user/guide/local-first.zh.md)说明了安装与配置。其余部分与上游一致，上游文档位于 [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)。

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代，dsh-local 随之更新。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>
## 运行

<a id="run-from-source"></a>
### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/michele1777777/dsh-local.git
cd dsh-local
pnpm install
pnpm run build
pnpm dsh
```

`pnpm dsh` 打开终端应用，`pnpm dsh web` 打开 Web UI；两者都直接使用已构建产物，不会重新构建。要从任意目录启动 `dsh`，请在 Linux 上运行一次 `bash scripts/install-dsh-linux.sh`，或参阅[在 Windows 上](docs/user/guide/local-first.zh.md#on-windows)。[本地模型指南](docs/user/guide/local-first.zh.md)说明如何连接模型服务器，[Web UI 指南](docs/user/guide/index.zh.md)从 Web UI 运行后的状态开始。

## 社区与支持

- 通过 [GitHub Issues](https://github.com/michele1777777/dsh-local/issues) 提交 dsh-local 的 bug 报告和建议。
- 在 DeepSeek Harness 上游也会出现的问题，请通过其 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

如需引用该 harness，请引用 DeepSeek Harness：

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)，与上游一致。

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
