# 在本地模型上运行 DeepSeek Harness

[English](local-first.md) | 中文

本发行版为 DeepSeek Harness 增加一个终端应用和一组本地优先的 profile 层。借助它们，`dsh` 通过 OpenAI 兼容服务器与你自己硬件上运行的模型通信，在生成摘要之前先用决策模型（如 Laya）修剪旧的上下文，并通过 Exa 或 Tavily 搜索网页。DeepSeek API 路由以及上游的所有默认设置仍然可用。

## 本发行版增加的内容

| 层 | 作用 |
|---|---|
| [`dsh-tui-app`](../../../packages/bundle/tui-app/README.zh.md) | 交互式终端应用，与 Web UI 使用相同的会话和 agent preset |
| [`dsh-local-base`](../../../packages/bundle/local-base/README.zh.md) | 带摘要孪生路由的本地模型路由、压缩策略、Laya 修剪、`/prechat`，以及 Exa 和 Tavily 搜索提供方 |
| [`dsh-local-presets`](../../../packages/bundle/local-presets/README.zh.md) | 为本地模型加入 Laya 修剪和摘要路由的 `standard` agent preset |
| [`dsh-local-web`](../../../packages/bundle/local-web/README.zh.md) | Laya 和 `/prechat` 的 Web 面板，以及 Smart 权限预设 |

`tui` profile 组合 `dsh-base`、`dsh-local-base`、`dsh-tui-app` 和 `dsh-local-presets`。`web`、`acp` 和 `headless` profile 保持上游组合，直到你按照[将这些层加入其他 profile](#add-the-layers-to-other-profiles) 添加本地层。

## 前提条件

- Node.js 和 pnpm，版本见[开发指南](../../development.zh.md)。
- 一个运行示例模型之一的 OpenAI 兼容服务器，例如 `llama.cpp`、vLLM 或 TabbyAPI。服务器可以运行在另一台机器上。
- 可选：一个用于上下文修剪的[决策服务](#decision-model-pruning)，或者一个实现托管修剪端点的模型服务器。

## 启动终端应用

1. 构建检出的仓库：

   ```sh
   pnpm install
   pnpm run build
   ```

2. 让 dsh 指向你的模型服务器。服务器监听 `http://127.0.0.1:8080/v1` 时可省略 `DSH_LOCAL_LLM_URL`。请把这些 export 写入 shell 配置文件（如 `~/.bashrc`），使每个新终端都带有它们：

   ```sh
   export DSH_LOCAL_LLM_URL=http://192.0.2.10:8080/v1
   export DSH_LOCAL_LLM_API_KEY=local
   ```

   `DSH_LOCAL_LLM_API_KEY` 作为 bearer 密钥发送；服务器不检查密钥时，设置任意非空值即可。终端应用和 Web UI 也会从凭据存储中读取它，因此你可以不 export，而是在 Web UI 的 **设置 → 模型** 中保存一次 `DSH_LOCAL_LLM_API_KEY`；headless profile 只读取环境变量。dsh 拒绝在 `.env` 文件中设置 `DSH_*` 名称，因为克隆项目中的 `.env` 不能决定你的请求发往何处。

3. 启动终端应用，并用 `/model` 选择一个本地路由：

   ```sh
   pnpm dsh --profile tui
   ```

   要让新会话默认使用本地路由，在 `$DSH_HOME/profiles/tui/cordis.patch.yml` 中加入以下内容（`$DSH_HOME` 默认为 `~/.dsh`）：

   ```yaml
   - id: agent-default-model
     name: '@deepseek-ai/dsh-agent-default-model'
     config:
       provider: ds4-v41-flash
       model: deepseek-v4.1-flash
   ```

<a id="on-windows"></a>
### 在 Windows 上

在 PowerShell 中执行相同的步骤，最好在 Windows Terminal 中运行，它能正确处理该应用的颜色和鼠标输入。不同之处如下：

- **环境变量**：`setx` 会为当前用户保存变量，对之后打开的终端生效。

  ```powershell
  setx DSH_LOCAL_LLM_URL "http://192.0.2.10:8080/v1"
  setx DSH_LOCAL_LLM_API_KEY "local"
  ```

- **Harness 主目录**：`$DSH_HOME` 默认为 `%USERPROFILE%\.dsh`；profile 和主目录 patch 都位于其中。
- **全局命令**：要从任意目录启动 `dsh`，请在 `PATH` 中的某个目录下保存一个 `dsh.cmd` 文件，并写入你的检出路径：

  ```bat
  @node C:\path\to\dsh-local\apps\cli\lib\bin.js %*
  ```

- **工具**：agent 的 shell 工具在 Windows 上运行 PowerShell 而非 bash。终端应用通过 PowerShell 复制内容，并在 `Ctrl+G` 时打开 `notepad.exe`，除非 `VISUAL` 或 `EDITOR` 指定了其他编辑器。

## 本地模型路由

| 路由 | 模型 id | 推理级别 | 输入 |
|---|---|---|---|
| `qwen-flash` | `qwen3.8-next-flash` | `off`、`low`、`medium`、`xhigh` | 文本、图像 |
| `qwen-27b` | `qwen3.8-27b` | `off`、`low`、`medium`、`xhigh` | 文本、图像 |
| `ds4-v4-flash` | `deepseek-v4-flash` | `off`、`high`、`max` | 文本 |
| `ds4-v41-flash` | `deepseek-v4.1-flash` | `off`、`high`、`max` | 文本、图像 |

所有路由共用 `DSH_LOCAL_LLM_URL`，因此由服务器当前加载的模型作答。每个路由都有一个关闭推理的 `-summary` 孪生路由，负责为它撰写压缩摘要。以高推理级别撰写的摘要可能把全部输出预算用于思考而不返回文本；孪生路由可以避免这种失败。[`dsh-local-base` README](../../../packages/bundle/local-base/README.zh.md#local-model-routes) 列出了上下文窗口和输出预算，并说明如何用你自己的模型替换这些路由。

<a id="decision-model-pruning"></a>
## 使用决策模型修剪上下文

在撰写摘要之前，dsh 可以询问决策模型：哪些较早的工具输出和消息应保留、缩短或丢弃。修剪保留原文，而不是改写它。当上下文达到窗口的 80% 时运行修剪；之后上下文压力仍然存在时，摘要压缩照常运行，而服务失败或无法访问不会改变任何内容。

### 连接决策服务

dsh 将每次修剪发送到一个 HTTP 服务，本身不加载任何模型。任何实现了[决策服务协议](../../../packages/compaction/compaction-laya-pruner/README.zh.md#decision-service-protocol)的服务都可以使用：微调的分类器、用作评判的语言模型，或固定规则。该协议是一个包含对话和 token 预算的 `POST /compact` 请求，响应为每一项给出 `KEEP`、`TRUNCATE` 或 `DROP` 决策。

本发行版是基于 Laya 开发的。Laya 是从 `convaiinnovations/laya`（mmBERT-base）微调而来的分类器，会为每一项的每一行打分。它的权重没有发布。Laya 仓库中的 `laya_serve.py` 服务为带有 Laya 项级和行级输出头的检查点实现了该协议；其他模型需要自己的服务。

请在启动 dsh 之前启动该服务，并只在 `127.0.0.1` 或受信任的私有网络上运行：该协议没有身份验证。

### 启用修剪

| `DSH_LAYA` | 行为 |
|---|---|
| 未设置 | 关闭修剪，只进行摘要压缩 |
| `resident` | 每次修剪都发送到 `LAYA_URL`（默认 `http://127.0.0.1:8766`）的决策服务 |
| `managed` | `ds4-v41-flash`、`qwen-flash` 和 `qwen-27b` 的修剪发送到 `<DSH_LOCAL_LLM_URL>/laya/compact`；其他路由使用 `LAYA_URL` |

在 `managed` 模式下，实现 `/v1/laya/compact` 的模型服务器（不属于本发行版，需要经过修改的服务器）会在从自身缓存借出的内存中运行一个临时决策 worker，并在之后恢复这部分内存，因此两次修剪之间没有常驻服务占用显存。[修剪器 README](../../../packages/compaction/compaction-laya-pruner/README.zh.md) 说明了两种端点类型、进度阶段和回退行为。

## 使用 Exa 或 Tavily 进行网页搜索

两个提供方都由 `dsh-local-base` 挂载。在 `$DSH_HOME/cordis.patch.yml` 中选择其中一个，并导出它的密钥：

```yaml
- id: web
  config:
    searchProvider: exa
    fetchProvider: http
```

```sh
export EXA_API_KEY=...
```

使用 Tavily 时，设置 `searchProvider: tavily` 和 `TAVILY_API_KEY`。没有密钥时，不会提供 `web_search` 工具。[Exa](../../../packages/web/web-search-exa/README.zh.md) 和 [Tavily](../../../packages/web/web-search-tavily/README.zh.md) 的 README 列出了各自的选项。

<a id="add-the-layers-to-other-profiles"></a>
## 将这些层加入其他 profile

编辑 `$DSH_HOME/profiles/<name>/package.json` 中的 `bundles` 列表。顺序很重要：每一层都会修补前面各层插入的行。

| Profile | Bundles |
|---|---|
| `web` | `dsh-base`、`dsh-local-base`、`dsh-web-app`、`dsh-local-web`、`dsh-local-presets` |
| `acp` | `dsh-base`、`dsh-local-base`、`dsh-acp-app` |
| `headless` | `dsh-base`、`dsh-local-base`、`dsh-headless` |

每一项都是完整的包名，例如 `@deepseek-ai/dsh-local-base`。无需启动应用即可检查结果：

```sh
pnpm dsh --profile web --dump-config
```

## 环境变量

| 变量 | 默认值 | 使用方 |
|---|---|---|
| `DSH_LOCAL_LLM_URL` | `http://127.0.0.1:8080/v1` | 所有本地路由和托管修剪端点 |
| `DSH_LOCAL_LLM_API_KEY` | 无 | 所有本地路由 |
| `DSH_LAYA` | 未设置 | 修剪模式：`resident` 或 `managed` |
| `LAYA_URL` | `http://127.0.0.1:8766` | 常驻决策服务 |
| `EXA_API_KEY` | 无 | Exa 搜索 |
| `TAVILY_API_KEY` | 无 | Tavily 搜索 |

变量在 profile 加载时读取；修改后请重启 `dsh`。
