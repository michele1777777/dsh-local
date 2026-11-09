---
description: "本发行版的本地优先 host 层：带摘要孪生路由的 OpenAI 兼容本地模型示例路由、可选的 Laya 修剪、预备对话，以及 Exa 和 Tavily 搜索。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-local-base

[English](README.md) | 中文

## 概述

`dsh-local-base` 将 dsh 连接到运行在你自己硬件上的模型。它紧接在 [`dsh-base`](../base/README.zh.md) 之后叠加，为 OpenAI 兼容本地服务器添加示例路由并为每个路由配一个摘要路由，还提供可选的 [Laya](../../compaction/compaction-laya-pruner/README.zh.md) 上下文修剪、[预备对话](../../context/prechat/README.zh.md)，以及 [Exa](../../web/web-search-exa/README.zh.md) 和 [Tavily](../../web/web-search-tavily/README.zh.md) 搜索提供方。服务器地址和密钥来自环境变量，因此该 bundle 不包含任何特定于机器的值。DeepSeek 路由以及 `dsh-base` 的其他默认设置仍然可用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

内置的 `tui` profile 已经列出该 bundle。要将它加入其他基于 base 的 profile，请在该 profile 的 `package.json` 中把它紧接着列在 `@deepseek-ai/dsh-base` 之后：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-local-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-local-web", "@deepseek-ai/dsh-local-presets"]
    }
  }
}
```

该文件位于 `$DSH_HOME/profiles/<name>/package.json`。组合 Web 应用 agent preset 的 profile（`web`、`tui`）还要在应用 bundle 之后列出 [`dsh-local-presets`](../local-presets/README.zh.md)；Web profile 在它之前加入 [`dsh-local-web`](../local-web/README.zh.md)。

<a id="environment-variables"></a>
### 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_LOCAL_LLM_URL` | `http://127.0.0.1:8080/v1` | 所有本地路由共用的 OpenAI 兼容服务器的基础 URL，通过每个路由的 `baseURLEnv` 读取 |
| `DSH_LOCAL_LLM_API_KEY` | 无 | 发送给该服务器的密钥；服务器不检查密钥时，设置任意非空值 |
| `DSH_LAYA` | 未设置 | `resident` 或 `managed` 启用基于决策服务的修剪；未设置时关闭修剪，但包含修剪改写的已存会话仍可恢复 |
| `LAYA_URL` | `http://127.0.0.1:8766` | `resident` 模式以及没有托管端点的路由所用的常驻决策服务 |

未设置密钥变量的路由仍会列出；在设置该变量之前，它的请求会以缺少密钥的错误失败。

<a id="local-model-routes"></a>
### 本地模型路由

| 路由 | 模型 | 推理 | 输入 | 思考参数的传输格式 |
|---|---|---|---|---|
| `qwen-flash` | `qwen3.8-next-flash` | `xhigh`（`off`、`low`、`medium`、`xhigh`） | 文本、图像 | `chat_template_kwargs` |
| `qwen-27b` | `qwen3.8-27b` | `xhigh`（`off`、`low`、`medium`、`xhigh`） | 文本、图像 | `chat_template_kwargs` |
| `ds4-v4-flash` | `deepseek-v4-flash` | `high`（`off`、`high`、`max`） | 文本 | DeepSeek `thinking` 对象 |
| `ds4-v41-flash` | `deepseek-v4.1-flash` | `high`（`off`、`high`、`max`） | 文本、图像 | DeepSeek `thinking` 对象 |

每个路由都有一个同模型的 `<route>-summary` 孪生路由：关闭推理、只接受文本输入、输出预算为 32768 个 token。每个路由都声明 184320 个 token 的上下文窗口和 36000 个 token 的输出预算，因此压缩在窗口约 80% 处开始。请让 `contextWindow` 与服务器加载的窗口一致。所有路由都启用 [`sessionCache`](../../llm/llm-pi-ai/README.zh.md)，因此请求会携带由会话派生的 `prompt_cache_key`，并在监听器要求时携带 `preserve_context`；对拒绝这些字段的服务器请关闭它。图像输入要求服务器启动时加载匹配的图像编码器。

通过对 `llm-pi-ai` 行的 profile 或 home patch 替换或扩展这些路由。该 patch 会替换整行 `config`，因此请重复列出要保留的路由：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-model:
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1
        apiKeyEnv: DSH_LOCAL_LLM_API_KEY
        models:
          - id: my-model
            contextWindow: 131072
            maxTokens: 16384
```

为每个新的对话路由配一个摘要孪生路由，并在 `compaction-basic` 上加入一条 `modelPolicies` 记录，具体见下文。

### 摘要路由

该 bundle 替换 host 的 `compaction-basic` 行：在窗口 80% 处自动压缩，不留余量，保留 16% 的上下文，摘要预算为 32768 个 token。它禁用 host 的 `tool-result-pruner`，因此工具输出不会按大小截断。它的 `modelPolicies` 将每个本地路由的摘要发送到该路由的 `-summary` 孪生路由，后者访问同一个服务器进程和模型。其他路由与 `dsh-base` 中一样，用自己的模型生成摘要。ACP 和 headless profile 使用这一 host 行；Web 和 TUI 会话使用 [`dsh-local-presets`](../local-presets/README.zh.md) 中的等效行。

之所以需要孪生路由，是因为摘要请求沿用对话路由的推理级别，而 `compaction-basic` 没有推理设置。以 `xhigh` 撰写的摘要可能把全部输出预算用于思考而不返回文本，导致压缩失败。

### Laya 修剪

`DSH_LAYA=resident` 将每次修剪发送到 `LAYA_URL` 的决策服务；任何实现了[决策服务协议](../../compaction/compaction-laya-pruner/README.zh.md#decision-service-protocol)的服务都可以使用，包括 Laya。`DSH_LAYA=managed` 将 `ds4-v41-flash`、`qwen-flash` 和 `qwen-27b` 的修剪发送到 `<DSH_LOCAL_LLM_URL>/laya/compact`，由支持该端点的模型服务器在从自身缓存借出的内存中运行临时决策 worker；其他路由仍使用常驻服务。修剪在压缩阈值处运行并保留原文行；压力仍然存在时，摘要压缩照常运行。[本地优先指南](../../../docs/user/guide/local-first.zh.md#decision-model-pruning)说明了如何连接决策服务。

### 预备对话、搜索和 Auto 审查

- **`/prechat`** 将以 `USER:` / `ASSISTANT:` 轮次写成的对话导入为新聊天的开头。它对 `ds4-v41-flash` / `deepseek-v4.1-flash` 启用；在 `prechat` 行上设置 `routes` 可允许其他路由。
- **Exa 和 Tavily** 注册为网页搜索提供方。在 profile 或 home patch 的 `web` 行上用 `searchProvider` 选择其一，并按其 README 的说明提供密钥。
- **Auto** 是实验性的权限预设，由 LLM 审查器授权每次工具调用。它不属于本 bundle；请按照[其 README](../../experimental/auto-review/README.zh.md) 将 `@deepseek-ai/dsh-experimental-auto-review` 加入 profile。使用本地路由时，在 profile 或 home patch 中加入以下内容，让本地读取跳过审查，并以关闭推理的方式运行审查：

```yaml
- id: auto-review
  config:
    trustedTools: [read, read_image, glob, grep]
    reasoningEffort: 'off'
    logFile: !!js dshHomePath('auto-review.jsonl')
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该 bundle 是一个在 `dsh-base` 之后应用的 [`cordis.patch.yml`](cordis.patch.yml)。它按 id 修补 `llm-pi-ai` 和 `compaction-basic` 行（这会替换它们的 `config`），禁用 `tool-result-pruner`，并在根层插入 `prechat`、`laya-pruner`、`web-search-exa` 和 `web-search-tavily` 行。每个路由通过 `baseURLEnv` 和 `apiKeyEnv` 指定服务器地址和密钥，由 `llm-pi-ai` 从启动环境和凭据存储中读取；Laya 模式和端点是基于 `process.env` 的 `!!js` 表达式，在 profile 加载时求值。修改变量在下次启动时生效。

`DSH_LAYA` 选择修剪时，`laya-pruner` 行为不使用 agent preset 的 profile 运行 host 侧修剪；否则它以 `mode: projection` 保持挂载，用于重建已存会话中的改写。[`dsh-local-presets`](../local-presets/README.zh.md) 将修剪移入 standard preset，并把这一行切换为 `mode: projection`。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 路由、压缩策略和插入的行 |
| [`tests/local-base.spec.ts`](tests/local-base.spec.ts) | 路由配对、环境变量默认值，以及组合在 `dsh-base` 之上的行 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [本地优先发行版指南](../../../docs/user/guide/local-first.zh.md)——安装、profile 以及使用决策模型修剪上下文。
- [`dsh-local-presets`](../local-presets/README.zh.md)——带 Laya 和摘要路由的 standard preset。
- [`dsh-local-web`](../local-web/README.zh.md)——Laya 和预备对话的 Web 面板。
- [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md)——所有路由字段，包括 `compat` 和 `sessionCache`。
- [`dsh-compaction-basic`](../../compaction/compaction-basic/README.zh.md)——阈值和 `modelPolicies`。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过插入的各行所属的包以及所选路由体现。路由决定由哪个模型处理对话、由哪个模型撰写摘要；插入的包各自负责其提示词和工具。

#### KV Cache 影响

该 bundle 不添加请求前缀。会话缓存键让本地服务器在多次请求之间复用一个会话的 KV 前缀，而 Laya 修剪会使第一处修改行之后的前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有一个提供方字典**——之后对 `llm-pi-ai` 的 patch 会替换全部路由；Cordis patch 无法向字典中单独添加一个路由。
- **每个服务器一个模型**——所有路由共用 `DSH_LOCAL_LLM_URL`；选择服务器未加载的模型对应的路由会在服务器端失败。
- **示例值**——上下文窗口、输出预算和推理级别与参考服务器一致；其他服务器需要各自的值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

保持此处与 [`dsh-local-presets`](../local-presets/README.zh.md) 中的 `modelPolicies` 一致；bundle 测试会比较两者。

</details>
