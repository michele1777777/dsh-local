---
description: "ctx.web 的 Exa 搜索提供方：部署方如何挂载 Exa 网页搜索，获得高亮 snippet、发布日期与按次解析的凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-exa`，harness 可以通过 Exa 搜索网页，获得带高亮 snippet 与发布日期的结果。当部署持有 Exa API Key、并希望使用 Exa 的关键词或神经搜索时选择它。Exa 不返回生成答案，因此结果不携带 `content`，只产出可引用的来源。没有非空白高亮的结果会被丢弃，因此一次调用返回的来源可能少于请求数量。没有密钥时提供方未就绪，`dsh-tool-web` 会隐藏 `web_search`；面向模型的工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方。它以 `exa` 搜索提供方身份注册；在 `@deepseek-ai/dsh-web` 行上设置 `searchProvider: exa` 或设置 `$DSH_WEB_SEARCH_PROVIDER` 来选择它。未配置提供方 id 时，只有当它是唯一可用的搜索提供方时 `ctx.web` 才会选择它；无论是否配置了密钥，本提供方都算作可用。

### 何时选择

当部署持有 Exa API Key，并希望使用 Exa 的关键词或神经搜索、获得每项结果的高亮 snippet 与发布日期时，选择此后端。每次搜索是一次 Exa API 请求，可能产生 Exa 计费。

### 最小配置

加载 web 服务与本提供方，并把密钥以 `EXA_API_KEY` 存入凭据存储或启动环境。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa
- name: '@deepseek-ai/dsh-web-search-exa'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 省略 | 字面 Exa API Key；优先使用 `apiKeyEnv`，避免密钥进入配置。非空字面值优先于 `apiKeyEnv` |
| `apiKeyEnv` | `EXA_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；该服务不存在时从启动环境读取。不符合环境变量命名语法的名称会使插件加载失败 |
| `baseURL` | `https://api.exa.ai` | 端点基址，后接 `/search`。不是绝对 `http:` 或 `https:` URL 的值会使插件加载失败 |
| `searchType` | `auto` | 作为 Exa `type` 发送的检索模式：`auto`、`keyword` 或 `neural` |
| `numResults` | 省略 | 请求未携带 `maxResults` 时发送的正整数结果数 |
| `highlightsPerResult` | `1` | 每项结果请求的正整数高亮句数（Exa 的 `highlightsPerUrl`） |
| `timeoutMs` | `30000` | 单次搜索的正整数时限（毫秒），从密钥解析到响应体读取 |

### 认证与就绪

每次搜索在运行时读取密钥，因此在凭据存储中保存或轮换的密钥无需重启即可用于下一次搜索。已挂载的 `ctx.credentials` 服务具有权威性，包括“不存在”；没有该服务时，提供方读取启动环境。密钥以 `Authorization: Bearer` 发送。提供方的 `ready()` 回答是否设置了字面密钥或引用已配置，不读取密钥值；本提供方被选中时，[`dsh-tool-web`](../tool-web/README.zh.md) 会对其回答 false 的每个请求隐藏 `web_search`。无法读取的凭据存储回答 false。

### 搜索返回什么

每项 Exa 结果映射为 `WebSearchSource`：`url`、`title`、作为 `snippet` 的第一条非空白高亮，以及作为 `publishedAt` 的 `publishedDate`；没有高亮的结果没有可移植 snippet，会被丢弃。请求的 `maxResults` 优先于 `numResults`，并作为成本与延迟优化发送给 Exa；最终上限由 web 服务截断并标记。结果不携带 `content`。

### 失败与恢复

失败抛出带可路由 code 的 `WebError`。没有密钥的搜索在发送任何请求前以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。调用方取消为 `WEB_ABORTED`，超过 `timeoutMs` 为 `WEB_SEARCH_TIMEOUT`。HTTP 错误（`Exa API error (HTTP <status>): <detail>`）、网络失败、凭据存储失败以及无法解析或格式错误的响应体均为 `WEB_PROVIDER_ERROR`。HTTP 重定向会在联系 `Location` 目标之前被拒绝。面向模型的 `web_search` 工具以自身的错误包装呈现失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节说明提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

本提供方是 Exa API 之上的薄适配层，遵循三条规则：

- **只用可移植 snippet。** 来源只从真实高亮获得 `snippet`；没有 snippet 的结果会被丢弃，而不是填入编造的文本。
- **不编造答案。** Exa 不返回生成答案，因此省略 `content`。
- **按次解析凭据。** 每次搜索和就绪检查都会查询密钥来源，因此提供方从不保留过期密钥。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、凭据来源、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `ExaSearchProvider`：选项校验、请求分发、取消分类、响应校验与映射 |
| [`src/types.ts`](src/types.ts) | Exa 协议类型：`ExaSearchRequest`、`ExaSearchResponse`、`ExaResult` |

### 请求与映射流程

`search()` 将调用方信号与 `timeoutMs` 时限融合，解析密钥，再以 `redirect: 'error'` 把查询、检索模式、高亮请求与可选结果数 POST 到 `{baseURL}/search`。时限信号的 reason 在每个阶段区分提供方自身超时与调用方取消。解析后的响应体按声明的协议类型校验，逐项映射，没有 snippet 的条目被丢弃；web 服务施加最终的 `maxResults` 上限。

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

间接地，通过 `dsh-tool-web`：它保留本提供方受 `maxResults` 限制的 URL、标题、第一条高亮与发布日期，或在消费方的错误包装下保留其确切的 `Exa search has no API key; store one under "<ref>" or set that environment variable`、`Exa search aborted`、`Exa search timed out after <ms> ms`、`Exa search request failed: <error>`、`Exa API error (HTTP <status>)`、`Exa returned an unprocessable response body: <error>` 与 `Exa returned a malformed response body` 失败。

#### KV Cache 影响

无直接失效；所述消费方负责任何请求前缀变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时本提供方不合适。它们是当前的包约束。

- **没有非空白高亮的结果会被整体丢弃** — 没有可映射的可移植 snippet，因此返回的来源可能少于请求数量。
- **只暴露 `searchType`、`numResults` 与 `highlightsPerResult`** — Exa 的其他控制项（livecrawl、category、域名与日期过滤、全文 contents）等待提供方中立的服务字段（[接缝 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **`available()` 不检查密钥** — 就绪检查是异步的，因此挂载多个搜索提供方且未设置 `searchProvider` 时，即使只有一个配置了密钥，选择也会报告 `WEB_PROVIDER_AMBIGUOUS`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是面向维护者的工作上下文：开放问题与未决方向。它明确不具权威性——已交付的行为、限制与理由见上文各节及链接的 Agent Notes。

#### 未来：更宽的 Exa 控制面

Exa 的 livecrawl、category、域名与日期过滤以及全文 contents 仍未暴露。暴露它们需要先有提供方中立的服务字段，这样包族会增加一个协调的控制项，而不是厂商专属参数。

</details>
