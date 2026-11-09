---
description: "ctx.web 的 Tavily 搜索提供方：部署方如何挂载 Tavily 网页搜索，获得与查询相关的页面摘录、发布日期与按次解析的凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-tavily`，harness 可以通过 Tavily Search API 搜索网页，获得带与查询相关的页面摘录和发布日期的排序结果。当部署持有 Tavily API Key、并希望使用为智能体设计的搜索 API 时选择它。提供方从不请求 Tavily 的生成答案或原始页面内容，因此结果不携带 `content`，只产出可引用的来源。没有密钥时提供方未就绪，`dsh-tool-web` 会隐藏 `web_search`；面向模型的工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方。它以 `tavily` 搜索提供方身份注册；在 `@deepseek-ai/dsh-web` 行上设置 `searchProvider: tavily` 或设置 `$DSH_WEB_SEARCH_PROVIDER` 来选择它。未配置提供方 id 时，只有当它是唯一可用的搜索提供方时 `ctx.web` 才会选择它；无论是否配置了密钥，本提供方都算作可用。

### 何时选择

当部署持有 Tavily API Key，并希望获得已按查询挑选好页面摘录的排序结果时，选择此后端。每次搜索是一次 Tavily API 请求并消耗 Tavily 额度：`basic` 搜索每次 1 个，`advanced` 搜索每次 2 个。

### 最小配置

加载 web 服务与本提供方，并把密钥以 `TAVILY_API_KEY` 存入凭据存储或启动环境。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily
- name: '@deepseek-ai/dsh-web-search-tavily'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 字面 Tavily API Key；优先使用 `apiKeyEnv`，避免密钥进入配置。非空字面值优先于 `apiKeyEnv` |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；该服务不存在时从启动环境读取。不符合环境变量命名语法的名称会使插件加载失败 |
| `baseURL` | `https://api.tavily.com` | 端点基址，后接 `/search`。不是绝对 `http:` 或 `https:` URL 的值会使插件加载失败 |
| `searchDepth` | `basic` | 作为 Tavily `search_depth` 发送的深度：`basic` 或 `advanced` |
| `numResults` | 省略 | 请求未携带 `maxResults` 时作为 `max_results` 发送的结果数，取值 1 到 20 |
| `timeoutMs` | `30000` | 单次搜索的正整数时限（毫秒），从密钥解析到响应体读取 |

### 认证与就绪

每次搜索在运行时读取密钥，因此在凭据存储中保存或轮换的密钥无需重启即可用于下一次搜索。已挂载的 `ctx.credentials` 服务具有权威性，包括“不存在”；没有该服务时，提供方读取启动环境。密钥以 `Authorization: Bearer` 发送。提供方的 `ready()` 回答是否设置了字面密钥或引用已配置，不读取密钥值；本提供方被选中时，[`dsh-tool-web`](../tool-web/README.zh.md) 会对其回答 false 的每个请求隐藏 `web_search`。无法读取的凭据存储回答 false。

### 搜索返回什么

每项 Tavily 结果按 Tavily 的排序映射为 `WebSearchSource`：`url`、`title`、作为 `snippet` 的提取内容 `content`，以及作为 `publishedAt` 的 `published_date`。空白的标题、内容或日期会被省略而不是编造，因此结果可能只有 URL。请求的 `maxResults` 优先于 `numResults`，被限制在 Tavily 的上限 20 以内，并作为 `max_results` 发送；最终上限由 web 服务截断并标记。每个请求都发送 `include_answer: false` 与 `include_raw_content: false`，结果不携带 `content`。

### 失败与恢复

失败抛出带可路由 code 的 `WebError`。没有密钥的搜索在发送任何请求前以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。调用方取消为 `WEB_ABORTED`，超过 `timeoutMs` 为 `WEB_SEARCH_TIMEOUT`。HTTP 错误（`Tavily API error (HTTP <status>): <detail>`，detail 取自 Tavily 的 `detail.error`、`detail`、`error` 或 `message` 字段）、网络失败、凭据存储失败以及无法解析或格式错误的响应体均为 `WEB_PROVIDER_ERROR`。HTTP 重定向会在联系 `Location` 目标之前被拒绝。面向模型的 `web_search` 工具以自身的错误包装呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节说明提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

本提供方是 Tavily Search API 之上的薄适配层，遵循三条规则：

- **只用提取的摘录。** 来源的 `snippet` 是 Tavily 为该页面提取的与查询相关的 `content`；空白摘录使来源只保留 URL。
- **不使用生成答案。** 请求关闭 Tavily 的答案，因此省略 `content`，而不是传递模型可能信任的提供方文本。
- **按次解析凭据。** 每次搜索和就绪检查都会查询密钥来源，因此提供方从不保留过期密钥。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、凭据来源、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `TavilySearchProvider`：选项校验、请求分发、取消分类、响应校验与映射 |
| [`src/types.ts`](src/types.ts) | Tavily 协议类型：`TavilySearchRequest`、`TavilySearchResponse`、`TavilyResult` |

### 请求与映射流程

`search()` 将调用方信号与 `timeoutMs` 时限融合，解析密钥，再以 `redirect: 'error'` 把查询、搜索深度、可选的受限结果数以及关闭答案与原始内容的标志 POST 到 `{baseURL}/search`。时限信号的 reason 在每个阶段区分提供方自身超时与调用方取消。解析后的响应体按声明的协议类型校验并逐项映射；web 服务施加最终的 `maxResults` 上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从共享词汇出发，依次到服务、面向模型的工具与设计理由。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 搜索请求与结果词汇及错误码。
- [Web 包地图](../README.zh.md) — web 包族及各自角色。
- [dsh-web](../web/README.zh.md) — 本提供方注册进的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 渲染本提供方来源的面向模型 `web_search` 工具。
- [Web 能力接缝决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md) — 为什么搜索与获取共享一个提供方选择服务。
- [搜索就绪决策](../../../.agents/notes/implemented/architecture/2026-09-27-web-search-offered-by-provider-readiness.zh.md) — 为什么本提供方报告就绪状态，而由 `dsh-tool-web` 隐藏 `web_search`。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：它保留本提供方受 `maxResults` 限制的 URL、标题、页面摘录与发布日期，或在消费方的错误包装下保留其确切的 `Tavily search has no API key; store one under "<ref>" or set that environment variable`、`Tavily search aborted`、`Tavily search timed out after <ms> ms`、`Tavily search request failed: <error>`、`Tavily API error (HTTP <status>)`、`Tavily returned an unprocessable response body: <error>` 与 `Tavily returned a malformed response body` 失败。

#### KV Cache 影响

无直接失效；所述消费方负责任何请求前缀变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时本提供方不合适。它们是当前的包约束。

- **只暴露 `searchDepth` 与 `numResults`** — Tavily 的主题、时间范围与域名过滤、答案和原始内容等待提供方中立的服务字段（[接缝 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **每个请求最多 20 条结果** — 更大的 `maxResults` 以 20 发送，这是 Tavily API 的上限。
- **`available()` 不检查密钥** — 就绪检查是异步的，因此挂载多个搜索提供方且未设置 `searchProvider` 时，即使只有一个配置了密钥，选择也会报告 `WEB_PROVIDER_AMBIGUOUS`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是面向维护者的工作上下文：开放问题与未决方向。它明确不具权威性——已交付的行为、限制与理由见上文各节及链接的 Agent Notes。

#### 未来：更宽的 Tavily 控制面

Tavily 的主题、时间范围与域名过滤仍未暴露。暴露它们需要先有提供方中立的服务字段，这样包族会增加一个协调的控制项，而不是厂商专属参数。

</details>
