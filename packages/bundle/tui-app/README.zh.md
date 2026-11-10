---
description: "基于 Web SessionController 的全屏终端工作区：可浏览的 transcript、安全的权限确认、已记录的 diff 与共享的会话指标。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

## 概述

`dsh-tui-app` 是 dsh 的终端 profile 层：一个以键盘为主、支持鼠标的全屏工作区，使用**与 Web 相同的 SessionController 和按会话选择的 preset**。在项目目录中运行 `dsh` 即可在该目录开始会话，运行 `dsh resume` 可重新打开已保存的会话。它只改变对话的显示方式，不改变模型请求、会话状态、压缩（compaction）、计划、目标或权限的执行方式。它不打开任何 HTTP 监听端口；没有终端时，它以逐行纯文本模式运行。

## 目录

- [使用本包](#use-this-package)
- [构建与测试](#build-and-test)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

屏幕把单行头部、可滚动的对话、位于两条分隔线之间的多行输入框和单行状态栏固定在各自区域。已结束的消息会被缓存，只绘制可见行。工具详情和推理（reasoning）在原位展开，已记录的文件变更带有编号的 hunk，提供方返回的推理始终保留；没有 `/reasoning` 命令，也没有隐藏推理的选项。以下各节按你遇到的顺序介绍屏幕的各个部分。

### 启动与恢复

```sh
dsh                                      # new session in this directory
dsh "fix the failing tests"               # opening prompt
dsh resume                               # searchable session picker
dsh resume --all                          # also show other directories
dsh resume --last                         # latest activity in this directory
dsh resume session-<uuid>                  # exact saved session
dsh resume session-<uuid> "continue here"  # resume, then send
dsh -r                                   # same picker
dsh -c                                   # continue latest session
dsh --model provider/model --effort high
dsh --preset standard                    # new sessions only
```

`dsh continue` 是 `dsh -c` 的完整写法。恢复会保留已保存的 preset、工作目录和已持久化的模型状态；`--preset` 与 resume 或 continue 同用时会被拒绝，而不是改变会话的工具平面；`--resume` 与 `--continue` 同用也会因相互矛盾而被拒绝。不是精确会话 ID 的恢复参数，只有在作为 ID 前缀或精确标题恰好匹配一个会话时才会被接受。

会话选择排除空白会话和委派的 subagent 会话，但包含人工 fork 出的会话。搜索匹配显示的标题、ID、目录和日期，并通过现有控制器搜索 API 查询已保存的消息内容；匹配结果限定在选择器当前的本目录或全部目录范围内，并沿用核心的结果数量上限。Tab 切换该范围。选中行的预览显示消息数和工具调用数、目录，以及首条提示词和最后一条回答的摘录；预览通过 `sessionQuery.readSession` 读取脱离运行的日志，不激活 Agent，终端至少有 18 行时预览堆叠在列表下方。单击选中一行；Enter 或 **Resume** 打开它。切换会话前，请先停止当前轮次，并发送或移除已暂存的附件。

### 屏幕与鼠标

界面使用终端的备用屏幕；退出后恢复普通 shell 屏幕。界面打开期间请使用应用自身的滚动和搜索，而不是 shell 回滚缓冲。最小支持尺寸为 **29 列 × 12 行**；更小的终端会显示调整尺寸提示，同时保留草稿。界面保留一列，以避免终端右下角自动换行。

界面启用带 SGR 坐标的按键事件鼠标上报（`1002`/`1006`），因此滚轮滚动对话而不是发送方向键，左键单击会到达屏幕上的控件，拖动选区由应用自行绘制；退出时把鼠标处理交还给终端。上报开启期间，单击和拖动归本应用处理；大多数终端在按住 Shift 时仍然可以选择文本，`/mouse off`（或启动时设置 `DSH_TUI_MOUSE=off`）把鼠标交还给终端。单击只作用于当前可见的目标；释放、拖动，以及带修饰键或非左键的单击不会执行任何操作。

界面打开期间独占终端：进程原本会打印到 stdout 或 stderr 的其他内容（Node 警告、插件诊断）改为追加到 `$DSH_HOME/logs/tui-output.log`，输入框上方的提示会在几秒内标出该文件，退出时打印一行指向它的说明。每次调整尺寸都会使待写输出和已绘制行缓存失效；下一个提交的帧会按新尺寸擦除并重绘备用屏幕，包括在 React 绘制前缩小后又放大回同一尺寸的情况。普通帧只更新发生变化的行，最高 60 fps。宽度稳定 80 ms 之前，对话保留原先的换行并按帧裁剪，之后只重新换行一次。未变化的屏幕行跳过 React 协调。

### 对话显示

每个条目都位于两格边距之后。用户提示词以小的中性 `›` 开头，回答以强调色 `●` 开头，两者都位于消息本身的第一行。收起的工具调用只占一行，分为三列：命令（状态符号、动词如 `Read`、`Edit` 或 `Run`，以及操作对象）、一段弱化的简短说明，以及在对话右边缘右对齐的耗时。说明是模型对该调用作用的描述（命令的 `description` 参数），从调用开始时就显示；没有描述的调用以几个词显示其结果，如 `+2 −1`、`14 matches` 或最后一行输出。失败或中断以语义颜色跟在说明之后，如 `Run authentication tests · exit 1`。已结束且收起的思考在相同的列中也只占一行，即 `◦ Thought` 和 `2 lines`，流中记录了时间时在右侧显示推理耗时。连续的单行调用和思考组成列表，中间没有空行，它们的说明从同一列开始，位于最宽命令之后两格，且最多从对话宽度的 60% 处开始。说明始终可见：终端变窄时，先用 `…` 截短命令，最短保留 16 格，并让说明左移到共享列之前；之后才截短说明。耗时始终保留。单击某一行打开带边框的卡片，单击卡片标题或下边框再将其收回；Ctrl+O、`/transcript` 和 `/diff` 会展开全部工具卡片。已结束的思考和斜杠命令展开为圆角边框，带明确的展开、收起控件。展开的命令工具显示 Description（如果提供）、Command 和 Result，包括后台命令；普通视图省略它们的原始 Arguments，原始视图仍包含原始参数。其他工具显示 Arguments 和 Result，完整输出可以通过滚动查看。普通结果文本使用消息前景色；标题、边框和元数据保持弱化，错误和警告保留语义颜色。代码块是封闭的方框，上边框标出语言并带有 **Copy**。推理在打开前保持折叠。折叠只改变视图，绝不改变已保存的消息或工具参数。各行、分隔线、卡片和状态栏占满除最后一列外的整个终端宽度；正文按同一宽度换行，没有单独的阅读宽度限制。

手动展开且已完成的工具输出，会在向下滚动越过其最后一行后收起，并保持当前阅读位置。向上滚动、流式更新和部分可见的输出不会使其收起。

对话的第一行标出你正在阅读其回答的提示词：已滚出视口上方的最近一条用户消息，以及它在全部提示词中的位置。单击它（或按 Alt+Up）把该消息带到顶部；随后这一行会标出更早的提示词，因此重复单击可以逐条向前回溯对话。Alt+Down 向后移动，越过最后一条提示词后回到实时尾部。视口上方没有提示词时不显示这一行。对话向上滚动时，下方会显示一个居中的按钮，标出视图下方还有多少行；单击它、按 Ctrl+End，或在草稿为空时按 End，都会回到实时尾部。

空对话显示欢迎鲸鱼：一段 60×15 个单元格的盲文点动画，下方是一个空行和欢迎文字。整组内容在对话区域中垂直居中，鲸鱼水平居中，欢迎文字作为一个左对齐的文本块水平居中。鲸鱼从第一帧起播放 6.4 秒的循环：两团点云相互穿过，聚成一头座头鲸，鲸鱼喷水、眨眼，然后再次散开。只有对话区域有 64 列（鲸鱼的 60 列加两侧各两列）以及 22 行（鲸鱼、空行和六行文字）时才显示鲸鱼；否则只居中显示欢迎文字。发送第一条消息后鲸鱼消失，执行 `/clear` 后以及切换到空会话时，鲸鱼从第一帧重新出现。对话中的斜杠命令使用单独的浅蓝色调。

最新一段推理仍在思考时，它的标签 `› Thinking… · 12s · 2 lines` 带有 Thinking 场景：一片 48×12 个单元格的盲文点星空，二十四个星座逐颗星绘出，每个 6.4 秒，周围没有边框。场景位于标签下方、缩进两格，完成的星座的拉丁名称显示在场景最后一行旁边；终端太窄放不下两者时，名称单独占一行。每段思考按其 id 选择起始星座，因此相邻的思考从不同的星座开始。打开标签后，推理文字缩进两格取代场景；再次收起时场景恢复。终端低于 26 行或比场景窄时，改为在标签所在行显示 Thinking 标志：一段 12×3 个单元格的动画，脉冲依次穿过十二个节点；标签和标志放不进同一行时，标签单独换行。推理结束、思考收起为一行时，场景消失。Waiting for model 标签在相同位置带有同一个场景。

这四段动画是 `assets/anim/` 中预先渲染的 gzip JSON 文件：`welcome-whale.json.gz`、`thinking-constellations.json.gz`、`thinking-synapse.json.gz` 和 `pruning-sieve.json.gz`，各保存一个每秒 10 帧的循环，每个盲文单元格一种主题色调，由共享的 100 ms 动画节拍推进。文件在其动画首次需要时读取并检查，之后在 TUI 运行期间一直保留。星座文件还为每一帧带有一条说明文字。无法读取的文件，或尺寸、帧数、色调、字形或说明文字与声明不符的文件，只向 `$DSH_HOME/logs/tui-output.log` 报告一次，其位置不绘制任何内容；标签和欢迎文字保留。浅色主题为每种色调提供各自的颜色，mono 用终端默认颜色绘制这些点。

Thinking 显示自第一个推理分片起经过的秒数；推理结束时 Thought 固定该时长，恢复会话时根据已记录的流时间戳重建。单击标签、场景或标志仍执行推理的展开、收起行为。`DSH_TUI_MOTION=off` 使欢迎鲸鱼停在完全成形的姿态，使 Thinking 场景停在一个已完成并显示名称的星座，使 Thinking 和修剪标志停在第一帧，并使标题旋转指示保持静止。

Laya 修剪上下文期间，对话之后会出现一行实时内容，位置与进行中的 Thinking 相同：该次修剪的实际阶段标签（`laya_context_pruner · pruning context`、`Starting Laya`、`Stopping Laya`、`DS4 · freeing cache memory` 或 `DS4 · restoring cache capacity`）位于修剪标志的中间一行，标志是一段 10×3 个单元格的盲文点动画，位于标签之后两格。标志中，一个扫描点读取点状屏障上的颗粒，保留的颗粒变绿并通过，丢弃的颗粒变红并碎裂。它只在 prune 阶段以及未报告阶段的修剪中以 4.8 秒的循环运动，每次开始修剪时从第一帧开始；管理模型的阶段静止显示第一帧。标志只是装饰：不反映修剪进度。修剪一结束，标签和标志立即消失，随后显示结果行。状态栏只显示阶段标签，不带旋转指示。

主题：`DSH_TUI_THEME=light` 或 `mono` 选择初始配色，`NO_COLOR` 选择单色。应用内的主题更改是本地展示状态，不修改模型设置。标准终端颜色遵循用户的终端配色；不会强制设置背景色。

### 输入框与键盘

| 按键 | 操作 |
| --- | --- |
| Enter | 发送；运行精确匹配的命令，或运行高亮的斜杠建议 |
| 轮次运行中按 Enter | 对其进行 steering（中途引导）：agent（智能体）在下一步读取该消息 |
| 轮次运行中按 Tab | 改为把草稿排队到下一轮（也可用 `/queue add text`） |
| 提示词为空时按 Enter | 立即发送待处理消息：正在运行的 shell 命令转入后台，否则中断当前工作；空闲时开始它们的轮次 |
| Ctrl+Enter | 在终端能区分该组合键时，提交草稿，然后像空提示词上的 Enter 一样立即发送 |
| Alt+Enter / Shift+Enter / Ctrl+J | 在终端能区分该组合键时插入换行 |
| 反斜杠后按 Enter | 通用的换行后备方式；删除末尾的反斜杠 |
| Left/Right、Home/End | 按字素移动；逻辑行边界 |
| Ctrl+Left/Right、Alt+Left/Right | 按词移动 |
| Ctrl+A/E/U/K/W | 行首/行尾；删除到行首/行尾；删除前一个词 |
| Up/Down | 在换行后的可视行间移动，到边缘后浏览提示词历史 |
| Ctrl+_ / Alt+U | 撤销 / 重做输入框编辑 |
| Ctrl+R | 搜索已提交的提示词历史；Enter 把最新的匹配项恢复到输入框以便编辑 |
| Ctrl+S | 暂存当前草稿，或与已暂存的草稿互换 |
| Ctrl+G / `/editor` | 在 `$VISUAL`/`$EDITOR` 中编辑当前草稿；返回后不自动发送 |
| Alt+V / `/paste-image` | 把本地剪贴板图片读入已暂存附件；绝不自动发送 |
| `/` 菜单中的 Tab / Up/Down / 滚轮 | 补全 / 选择模糊匹配的命令建议 |
| `/` 查询末尾的 Left/Right | 切换菜单标签：All、Agent、Skills、Terminal |
| Page Up/Down、Shift+Up/Down | 滚动对话，不改变草稿 |
| 左键单击提示词标题 / Alt+Up | 跳到第一行标出的提示词；重复操作逐条回溯 |
| Alt+Down | 跳到下一条提示词；越过最后一条后回到实时尾部 |
| Alt+G / 单击头部下方的目标 | 打开目标面板：完整目标、状态，以及 Edit（把 `/goal edit <objective>` 放入输入框）、Pause/Resume、Clear |
| 滚轮、Ctrl+滚轮 | 按三行 / 按页滚动对话或已打开的面板 |
| 在草稿上滚动滚轮 | 滚动草稿本身；输入内容时回到光标处 |
| 左键拖动 | 选择输入框上方已绘制的文本；释放时复制并报告字符数 |
| 在草稿中单击 / 拖动 | 把光标移到该处 / 选择草稿文本，释放时复制；Backspace 或 Delete 删除选区，输入或粘贴替换选区 |
| 在粘贴占位符上按 Backspace/Delete | 一次按键删除整个粘贴块 |
| 左键单击代码块上的 **Copy** | 复制原始代码块，而不是渲染后的行 |
| 左键单击工具行或思考标题 | 在原位展开或收起其详情 |
| 单击头部下方的计划或任务指示 | 打开任务面板 |
| 在空提示中按 `?`，或单击 `? keys` | 在输入框上方显示按键框；按 Esc 或下一个键隐藏它，该键随后照常生效 |
| 单击输入框上方的 `×` | 移除对应的排队消息或已暂存文件 |
| Ctrl+Home / Ctrl+End | 对话开头 / 恢复跟随实时尾部 |
| Ctrl+O | 进入/离开 transcript（文本记录）浏览 |
| transcript 中的 Up/Down | 选择上一个/下一个对话条目 |
| transcript 中的 Enter / Space | 展开/收起选中的条目 |
| transcript 中的 `r` | 在文档中切换原始工具参数/结果 |
| Ctrl+F | 搜索已渲染的对话行 |
| 搜索中按 Enter，然后 `n` / `N` | 结束查询编辑；下一个 / 上一个匹配 |
| Esc | 关闭按键框、清除选区、关闭斜杠菜单、关闭搜索或面板，或中断当前工作 |
| 单击状态栏中的 preset / `/permission` | 显示当前会话的 preset，并从实时权限目录中选择；只有与默认值不同时状态栏才标出该 preset |
| Ctrl+C | 复制当前选区、取消正在运行的工作或清空草稿；空闲且草稿为空时在 1.5 s 内按两次退出 |
| 草稿为空时按 Ctrl+D | 取消、保存并退出 |

编辑器的移动和删除遵循字素边界。键盘编码和宽度不确定的 Unicode 字符取决于终端。终端上报的按键重复事件会被忽略。排队消息、已暂存文件和短暂提示位于输入框上方分隔线之上。本地操作失败（例如命令缺少参数）时，错误连同命令的正确用法显示在那里，直到下一次按键；其他提示五秒后消失；发送提示词或命令时两者都会清除，且都不会进入对话。

### Steering 与排队

agent 工作期间用 Enter 发送的消息，会在下一步加入正在运行的轮次。steering 消息会等待正在运行的 shell 命令结束。在输入框为空时再次按 Enter 可以立即发送：正在运行的 shell 命令转入后台，agent 立即读取你的消息，命令结束时由完成通知告知 agent；没有这样的命令时，当前工作被中断，待处理输入在取消完成后发送。终端能区分 Ctrl+Enter 时，它在一次操作中完成提交并强制送达；否则按两次 Enter。Tab 或 `/queue add text` 把草稿保留到下一轮。用 Ctrl+C、Esc 或 `/stop` 中断会保留待处理输入并在下一轮开始它；再次中断则让剩余输入继续停放。显式的空 Enter 或 `/queue send` 总是请求送达，包括在先前中断之后。

### 粘贴与提示词历史

超过 4 行或 512 个字符的粘贴会折叠为 `[Pasted text #1 +42 lines]`。文本本身会被保留，并在提交时展开到提示词中，因此模型总是收到粘贴的内容；占位符只是输入框状态。一次 Backspace 或 Delete 删除整个占位符，再次粘贴相同内容会在原位展开以便编辑。编号在 TUI 进程内唯一，最近 20 次粘贴保持可展开。

括号粘贴有自己的输入通道：粘贴的换行、`/commands` 或 `y` **绝不会提交、执行或批准**。提示词中的空白会被保留；粘贴的 CRLF 规范化为 LF。准入失败时会恢复草稿以便编辑，并保留已暂存的附件。未成功的开场提示词会恢复到输入框以便编辑，而不是被静默重试。

提示词历史仅限于当前 TUI 进程（最近 100 次提交），不是新的持久化会话存储。撤销历史保留最近 100 次编辑。

### 斜杠命令

`/` 菜单有 All、Agent（会话 preset 的注册表命令）、Skills（用户可调用的 skill，即技能）和 Terminal（本应用处理的命令）几个标签，每个标签附带匹配数量；光标位于查询末尾时，Left 和 Right 切换标签。`/` 之后没有输入时，All 把命令列在 Agent、Skills 和 Terminal 标题下，Terminal 把命令归入 Session、Model & context、Input、View 和 Settings 各组，Up 和 Down 会跳过标题。输入内容时对命令名称和描述进行模糊匹配并排序，宽度达到 60 格时显示类别列。参数提示以弱化样式跟在命令名称之后。模糊匹配绝不改变命令的执行语义。名称冲突时注册表命令优先，但保留的 `/stop`、`/exit` 控制命令和已移除的推理开关除外；任何命令名称都优先于同名 skill。

| 命令 | 行为 |
| --- | --- |
| `/help` | 可滚动的命令和键盘参考 |
| `/status`、`/context` | 会话、模型、上下文估计、token 计数和实测耗时 |
| `/new [preset]`、`/resume [id\|--last\|--all]`、`/sessions` | 共享的会话创建/恢复和可搜索的选择器 |
| `/model [provider/model]`、`/effort [value\|default]` | 共享的模型校验/持久化；不带参数时打开选择器 |
| `/skills` | 打开当前会话用户可调用 skill 的可搜索选择器；选中后把 `/name ` 放入输入框 |
| `/<skill-name> [task]` | 当该行命名一个用户可调用的 skill 且没有同名命令时，作为提示词发送；与 Web 相同，由 `tool-skill` 在宿主侧注入 skill。skill 也会出现在 `/` 菜单中 |
| `/rename title`、`/fork` | 共享的标题持久化；在最后一个已完成轮次处 fork |
| `/queue`、`/queue add text`、`/queue send`、`/queue remove N`、`/queue steer N`、`/queue edit N text` | 查看/修改共享队列；`add` 把提示词保留到下一轮，`send` 等同于空 Enter；核心的编辑限制仍然适用 |
| `/steer message`、`/stop` | 共享的步骤边界准入（轮次期间 Enter 的行为）/ 取消 |
| `/attach path`、`/image path`、`/detach` | 暂存共享的文件回执/图片，或移除已暂存的附件 |
| `/transcript`、`/diff`、`/expand` | 浏览条目、查看已记录的变更、展开/收起全部工具 |
| `/permissions` | 只读的策略和待处理请求查看 |
| `/tasks`、`/jobs` | 只读的计划/目标/待办/任务/队列查看，任务行可单击 |
| `/theme [dark\|light\|mono]` | 只更改展示颜色；不带参数时打开选择器 |
| `/mouse [on\|off]` | 开启或关闭滚轮/单击上报；关闭后恢复终端选择 |
| `/copy [code\|raw]` | 复制最后一条 assistant Markdown；`code` 复制其中最近的围栏代码块 |
| `/paste-image`、`/editor` | 本地剪贴板图片暂存 / 外部草稿编辑 |
| `/layout [auto\|single\|split]` | 记录布局模式；目前所有模式都渲染为单列 |
| `/links [on\|off]` | 在模拟器支持时启用安全的终端 URL/文件超链接 |
| `/notify [off\|bell\|desktop]` | 仅在终端报告失去焦点时发出需要关注/轮次结束提醒 |
| `/title [on\|off]` | 动态的会话/状态标签页标题，退出时恢复 |
| `/clear`、`/cwd` | 只清空显示 / 显示记录的工作目录 |
| `/export path.md` | 导出包括推理在内的完整 transcript；拒绝覆盖已有文件 |
| `/exit` | 取消、刷写本进程拥有的会话、恢复终端并退出 |

`/compact`、`/goal`、`/plan`、`/permission` 和其他注册表命令使用与 Web 相同的作用域 `registry.execute(agent, line, attachments, signal)`。TUI 不会虚构当前 preset 中不存在的命令。在交互式终端中，`/skills` 打开上述选择器而不是注册表在对话中的列表，不带参数的 `/permission` 打开实时 preset 选择器。`/permissions` 是只读的 UI 查看器；它**不是**第二个策略设置器，也不替代注册表提供的 `/permission` 命令。

### 已记录的变更

`/diff` 显示**本会话中由工具报告的变更**，而不是当前 Git 工作树的 diff。展开的 hunk 在可用内容宽度达到 110 列时切换为成对的 **BEFORE / AFTER** 视图，窄于此时使用统一视图。两侧都保留换行后的内容和行号；不增加任何工作树读取或模型请求。非常大的替换使用带标注的非最小比较；完整内容会被保留。未知的工具结果仍可通过原始详情查看。语法高亮是轻量的词法高亮，不是完整的语言解析器。图片以附件标签表示，不在行内渲染。

### 复制、链接、图片与本地编辑

每个 assistant 代码块的上边框都有可单击的 **Copy**。复制目标引用原始消息和代码块序号，而不是换行或净化后的显示行。它保留缩进、制表符、Unicode、CRLF/LF 和末尾换行；绝不复制围栏、方框边线和 ANSI 颜色。流式输出中的代码块复制**单击那一刻**已有的内容。`/copy` 和 `/copy raw` 把最后一条非空的 assistant 回答作为原始 Markdown 复制；`/copy code` 复制最近的 assistant 代码块。两个命令都不包含隐藏的或提供方未提供的推理，也不会运行复制的文本。计划审阅和问题面板中的代码块同样带有 **Copy**，权限面板有一个 **[ Copy ]** 按钮，可以复制 shell 命令而不批准或执行它。

原生剪贴板适配器：Windows/WSL 使用 `powershell.exe`（Windows Forms），macOS 使用 `pbcopy`，Linux Wayland 使用 `wl-copy`，X11 使用 `xclip`/`xsel`。调用这些辅助程序时不会由 shell 解析消息内容。原生复制不可用时，只在 TTY 上尝试 OSC 52，包括经转义的 tmux 透传。原生复制成功显示 **Copied**；OSC 52 显示 **Sent**，因为终端可能拒绝写入剪贴板。通过 SSH 时只使用终端后备方式；不会触碰服务器的桌面剪贴板。DSH 不安装任何辅助程序。

`DSH_TUI_CLIPBOARD=auto|native|osc52|off` 控制文本复制。OSC 52 上限为 100,000 个 UTF-8 字节；更大的代码块请使用原生辅助程序或 `/export`。使用按钮需要开启鼠标上报；Shift+拖动或 `/mouse off` 允许模拟器自身的普通选择，具体取决于终端。

`Alt+V` / `/paste-image` 显式读取与 PNG 兼容的本地剪贴板图片：Windows/WSL 使用 Windows Forms，macOS 通过 `osascript` 使用 AppKit，Linux 使用 `wl-paste` 或 `xclip`。大小限制来自现有的 Web 图片准入设置。它暂存与 `/image` 相同的图片内容部分；它**不会**提交消息。输入框上方每个已暂存文件旁的 `×` 会移除它。通过 SSH 读取剪贴板图片被有意禁用；请在宿主上使用 `/image path`。图片在 TUI 中仍以标签显示，而不是行内像素。

`Ctrl+G` / `/editor` 把终端交给 `$VISUAL`，其次是 `$EDITOR`（后备：Windows 为 `notepad.exe`，其他系统为 `vi`）。含空格的路径需要加引号。常见的 Code、Cursor 和 Sublime 启动器会收到 `--wait`；其他 GUI 编辑器必须配置为等到文件关闭再返回。启动失败、非零退出、中断，或编辑后的草稿超过 8 MiB 时，保留原草稿。编辑后的文本只回到输入框；用户仍需自行发送。临时文件是私有的，完成后删除。这一本地 UI 操作不是 agent 的 shell 命令。

HTTP/HTTPS 链接和生成的本地文件引用使用 OSC 8。请用模拟器的链接手势（通常是 Ctrl+单击）打开它们，而不是通过 agent 工具。不支持的终端显示普通文本；关联的文件打开程序可能忽略行号片段。不会输出 `javascript:` 链接、原始的模型转义序列或隐式的 UNC 网络共享目标。`DSH_TUI_LINKS=off` 或 `TERM=dumb` 会禁用链接。

### 文本选择

在对话中拖动，并用滚轮或翻页键滚动，可以把选区扩展到屏幕外的行。释放时复制选中的文本，滚动期间保留高亮；Ctrl+C 再次复制，Esc 清除选区。选择期间，已渲染的文本在流式输出时保持稳定，并且不包含输入框和状态栏。

### 面板与提醒

帮助、上下文、任务、后台任务、目标、权限和 preset 选择器，以及会话预览，都在页面内覆盖对话打开；它们从不分割屏幕。Esc 返回对话。Page Up/Down、Up/Down、Home/End 和滚轮滚动已打开的帮助、上下文、任务、后台任务或目标面板；在选择器中，Up/Down 移动选中项，输入内容会筛选行。`/layout` 和 `DSH_TUI_LAYOUT=auto|single|split` 会记录布局模式，但目前所有模式都渲染为这种单列视图。

`DSH_TUI_NOTIFY=off|bell|desktop` 默认为 bell；`DSH_TUI_TITLE=off` 禁用标题更改。这些是展示设置，不是持久化的会话状态。只有在终端报告失去焦点时，新的权限或问题请求，以及从运行到空闲的转换才会触发提醒。**Turn ended** 不表示任务成功。桌面提醒使用需显式开启的 OSC 9，并需要模拟器支持；没有焦点上报或通知支持时，不保证发出任何提醒。标签页标题使用净化后的会话名称和 `working` / `attention` / `ready` 状态，退出时请求恢复标题栈。轮次运行期间，一个由盲文点组成的小圆圈（`⣾⣽⣻⢿⡿⣟⣯⣷`）每 100 ms 在 `DSH` 前转动一次。这两项功能都不会改变模型提示词，也不会向外部通知服务发布数据。

### 权限与交互式问题

权限面板显示工具、所属会话、工作目录、原因和可用的完整参数，详情之后空一行是选项及其按键说明，只有详情过长需要滚动时它们才固定在底部；当前选项以中性色的方括号标出。后代 subagent 的请求保留其真实所属会话。每个新请求默认选中 **Reject**。

`y` 选中 **Allow once**；Left、Right 或 Tab 在两个选项之间切换；**Enter** 确认选择。单击某个选项会选中它，单击按键说明中的 **Enter confirm** 会确认选择，遵循相同的防护。复制显示的命令不会选择或确认权限。`n` 或 Esc 拒绝。Page Up/Down 滚动详情。确认和 `n` 会忽略按键重复事件以及新请求出现后的前 250 ms，两键批准手势也避免了在没有显式重复元数据的终端中因按住 `y` 而自动批准。

这些是核心已有的 `allowed-once` / `rejected` 结果。**没有虚构的“本会话允许”**，没有新增的自动允许模式，也不会绕过共享策略。核心的 `never` 策略表示拒绝，而不是不受限制的访问。

问题和计划审阅面板显示完整的 Markdown 和选项说明。Up/Down 在选项间移动；Space 切换高亮选项；Tab 切换到自定义文本，直接输入也会开始自定义文本；Enter 确认，同样受 250 ms 防护。单选问题发送高亮选项或自定义文本中获得焦点的一方；多选问题把勾选的选项与自定义文本一起保留。多个问题保留现有的回答字段。Page Up/Down 滚动详情。Esc 通过现有 waterfall（瀑布式事件）取消。存在待处理请求时隐藏输入框，但不丢弃其草稿。

### Smart approval

`/auto-approve smart` 选择共享的同模型审阅器；`/auto-approve manual` 恢复普通的工作区审批。`/auto-approve status` 报告当前生效的模式，`/auto-approve history` 显示已记录的决定。状态栏报告审阅器活动；`/permissions` 显示权威结果，包括回退到人工和取消。本包以默认限制挂载审阅器，保持 `run_code` 仅限人工审批，并把 `plugin_manager` 列入 `escalatingTools`；会话在显式切换前保持手动审批。确切范围、额外 token 用量和单次调用升权语义见 [Smart approval](../../interaction/smart-approval/README.zh.md)。计划审阅仍然是交互式的。

### 预置对话

当组合注册了来自 [dsh-prechat](../../context/prechat/README.zh.md) 的 `/prechat` 时，它在该插件 `routes` 配置列出的路由上接受粘贴的 `USER:` / `ASSISTANT:` 对话对或 `.txt` 路径，并在打开新对话前预览它们。多行的 `/prechat` 草稿在按 Enter 时作为命令运行，而不是作为提示词发送。头部下方的指示行统计当前会话导入的消息数。

### 后台任务

单击状态栏中的任务数量或运行 `/jobs`，然后单击某个任务即可查看其当前状态和保留的输出。每个任务占两行：带语义颜色的状态符号、任务的作用（模型为启动它的命令给出的描述，没有时为命令本身）以及运行中或最终的耗时，然后是灰色的命令及其进度或结束原因。正在运行的任务排在前面，随后是已结束的任务，最近结束的在前。`/tasks` 提供同样可单击的行。输出实时跟随，但不消耗 agent 的读取游标；关闭面板只释放观察者。显示区保留最近 128 Ki 个 UTF-16 码元，并标出缺失的更早输出。

在已注册的 shell 命令运行期间按 Enter 会让命令保持附着；命令结束时 agent 读取你的消息。之后的空 Enter 把命令转入后台，使 agent 立即读取你的消息；任务继续运行，其现有的完成通知让 agent 收取结果。在 `job_output` 等待期间按 Enter 会立即释放该等待。Tab 和 `/queue add` 仍然排队到下一轮。显式中断仍会取消前台工作。状态栏只统计正在运行的任务，任务结束后不再显示；已结束的任务仍列在面板中。

### 上下文、活动与性能

状态栏只占一行；终端变窄时先收紧分隔符，然后 `? keys` 控件、模型、预填充和解码速度、后台任务和工作计时器先于上下文进度条、token 数和百分比被省略，非默认的权限 preset 最后才被省略。详细数值仍在 `/context` 中。轮次运行期间，它显示工作计时器：从最近一条被准入的人工消息开始的墙钟时间，包含模型调用、工具、修剪和审批等待。

- 上下文压力是**近似的**投影 token 数与窗口之比，在 `/context` 中标为 `~`，来自共享投影；它不是重新计算的请求大小。
- token 用量使用共享的提供方计数器。输出已包含推理 token；缓存计数器不会被重复计算。
- 状态栏显示**最近 10 次模型回复**的 `prefill N · decode N tok/s`，包括重放的历史：以 token 总数除以墙钟时间总和，因此较长的回复权重更大。每次回复的计时取自其日志事件。预填充是未缓存的输入 token 数除以从 `step/start` 到第一个流式 token 的时间；解码是输出 token 数（含推理）除以从第一个 token 到提交消息的时间。`/context` 显示同样的两个数值，其下是会话平均值。
- 会话解码速度是基于所有带有可用核心计时和用量的步骤计算的 `1000 × decodeTokens / decodeMs`，TTFT 是 `ttftMs / ttftSteps`；两者只显示在 `/context` 中。分母缺失或无效时不显示速率，提示词完全命中缓存的回复不计入预填充数值。

本包挂载与 Web 相同的只读 `session-stats` 插件，使这些测量能够到达控制流。头部下方的目标、计划和任务指示以及任务数量读取现有投影。已持久化但未启用的目标显示为 `paused · /goal resume`，而不是运行中。界面绝不会为了驱动徽标而启动目标 Round。

### 没有终端时

非 TTY 模式保持逐行、纯文本。每个非空行提交一个提示词或命令，开场提示词执行前会缓冲输入，EOF 时保存会话。交互式审批以拒绝方式失败；问题可以交给其他已组合的回答方。在脚本中请使用显式的会话和模型 ID，而不是选择器。这里和导出中同样包含提供方返回的推理。

-----

<a id="build-and-test"></a>
## 构建与测试

使用根目录 `package.json` 声明的 Node 版本和固定的 pnpm（`engines.node` 和 `packageManager`）。不要误用全局安装的旧版 `dsh`。

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-tui-app run test:terminal
pnpm --filter @deepseek-ai/dsh-tui-app run test:ink
pnpm run build
pnpm --filter @deepseek-ai/dsh-tui-app run test:memory
pnpm run dsh --profile tui
pnpm run dsh --profile tui resume
```

已安装的 TUI 以生产模式打包 React、其协调器和 Ink，与 shell 的 `NODE_ENV` 无关。这样可以防止 React 开发模式的组件计时在长对话中不断累积。其他插件和子进程的环境保持不变。直接运行源码的渲染器测试仍可使用 React 的开发诊断。

固定版本的 Ink 补丁为负责调整尺寸的一方添加了显式且不触发绘制的 `invalidate()` 操作，并把文本测量缓存和换行缓存各自限制为 4,096 项；被淘汰的文本会重新计算，不改变显示。`test:memory` 检查已安装的包，并让 4,000 个变化的帧流经以相同配置构建的渲染器，每 1,000 帧检查一次保留的堆和诊断条目。它需要最新的构建产物，且不联系模型。

从另一个工作区运行已构建的 CLI：

```sh
cd /path/to/workspace
node /path/to/deepseek-harness/apps/cli/lib/bin.js --profile tui
```

`test:terminal` 测试真实的纯渲染器、编辑器、布局、diff 和指标代码、服务适配器以及 App 输入路由。App 测试使用**显式的、仅供测试的 React/Ink 编排替身**：它们验证生成的行和操作，而不是原生 React 调度、Yoga 布局或 PTY 行为。这些替身绝不会进入生产包。`test:ink` 单独导入**真实的 React 和 Ink**，检查它们对生成行的绘制。其 xterm 模拟器覆盖快速连续调整尺寸、缩小再放大后的不变帧、待写的流式写入和选区高亮。它需要已安装的依赖，不能替代在用户终端模拟器中的冒烟测试。

`preview:snapshots` 导出确定性的 fixture（测试前置数据）行，而不是实时提供方的截图。TypeScript 测试加载器也接受 `DSH_TEST_TYPESCRIPT` 和 `DSH_TEST_COMMANDER` 路径，以适应受限环境；普通测试解析已安装的依赖。共享控制器的集成测试：

```sh
pnpm exec vitest run packages/api/session-controller/tests
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 共享服务与准入

[`cordis.patch.yml`](cordis.patch.yml) 层插入启动提供方和 runner、与载体无关的 Web 业务服务（会话和任务控制器、工作区、文件和会话引用、`session-stats`）、以 `standard` 为默认值的 preset 注册表，以及 Smart approval 行。它禁用全局挂载的 agent 平面行（工具、skill、计划、压缩、subagent、工作流），因为与 Web 完全相同，这些由每个会话记录的 preset 选择。不挂载 webserver、浏览器运行时或浏览器 UI；调用在进程内完成，不是另一个 LLM（大语言模型）客户端。

`backend.ts` 把提示词准入以及创建、恢复、模型、队列和 fork 操作委托给共享控制器。`index.ts` 适配现有的命令注册表、投影以及审批和问题 waterfall。待处理队列读取自共享的 `inbox` 投影，后台任务读取自 Job Controller 的 `job.list` 名册流，与 Web 客户端使用的来源相同。`queue.ts` 选择共享的 `queue`/`steer` 准入模式，并在中断后带唤醒重新投递最后一条停放的收件箱消息（即控制器队列 Steer 执行的移除与重新投递），使 Agent 开始其保留输入所等待的轮次；它从不构造消息。preset 拥有系统提示词、工具、压缩、修剪、计划和目标。任何模型输入都不会从终端渲染的文本重建。

### Transcript 渲染

`transcript.ts` 协调流式增量和持久事件，不会重复压缩或修剪产生的替换副本。工具事件保留开始、结束和中断状态。`document.ts` 缓存条目的行；`viewport.ts` 把滚动位置锚定到条目 ID，使视口上方的流式输出不会把读者拉走。增长中的消息复用已完成行的渲染结果，流式 token 按帧重绘而不是每个 token 重绘一次，因此长回答不会占用终端读取键盘所需的时间。工具折叠、原始视图、搜索和显示清空都只是本地展示状态。控制字符、转义字符和双向字符在显示时被净化，原始提交的提示词不会被改写。

### 源码地图

| 文件 | 职责 |
| --- | --- |
| `backend.ts`、`index.ts`、`startup.ts` | 共享服务、生命周期、订阅、路由、回答方和命令行选项 |
| `app.tsx`、`components.tsx` | 焦点和输入编排以及可见的 Ink 行 |
| `screen.ts`、`animation.ts`、`metrics.ts`、`theme.ts` | 布局、三段预渲染盲文动画的加载器、只读指示器和语义颜色 |
| `document.ts`、`markdown-layout.ts`、`syntax.ts`、`diff.ts`、`diff-layout.ts`、`tool-format.ts` | transcript、Markdown、代码、工具详情和自适应的已记录变更 |
| `actions.ts`、`code-blocks.ts`、`panes.ts`、`links.ts`、`selection.ts` | 语义复制目标、精确的围栏内容、命中测试、安全超链接和拖动选择 |
| `clipboard.ts`、`local-process.ts`、`external-editor.ts`、`terminal-signals.ts` | 显式的本地操作系统适配器、有界子进程、草稿编辑和提醒信号 |
| `terminal-guard.ts`、`terminal.ts` | 独占终端：转移外部的 stdout/stderr 写入，并把尺寸调整交给 App 而不是 Ink；显示净化 |
| `session-browser.ts`、`browser-view.ts`、`sessions.ts` | 不激活会话的共享搜索和查看、可取消的预览 UI 以及会话候选项 |
| `rich-text.ts`、`layout.ts`、`viewport.ts`、`mouse.ts` | 单元格和字素宽度、换行、稳定的滚动锚点和鼠标上报 |
| `editor.ts`、`editor-history.ts`、`paste.ts`、`commands.ts` | 提示词编辑、撤销、粘贴占位符和命令发现 |
| `store.ts`、`transcript.ts`、`interaction.ts`、`plain.ts`、`queue.ts`、`job-observer.ts`、`permission-audit.ts` | 本地 UI 状态、事件回放、待处理 UI、非 TTY 模式、队列投递、任务输出和审批记录 |

本包不发布单独的运行时不变量配套文档：持久的会话状态归控制器所有，终端状态只展示权威服务，文档缓存是由布局和输入测试检查的可丢弃投影。设计决策记录在[终端原生 TUI Agent Note](../../../.agents/notes/implemented/feature/2026-09-18-terminal-native-tui.zh.md) 中。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读以下页面，了解终端背后的共享服务以及塑造它的决策。

- [dsh-web-app](../web-app/README.zh.md)——终端与之共享控制器和 preset 的浏览器界面。
- [dsh-api-session-controller](../../api/session-controller/README.zh.md)——提示词准入、队列和会话操作。
- [Smart approval](../../interaction/smart-approval/README.zh.md)——`/auto-approve smart` 背后的审阅器。
- [终端原生 TUI Agent Note](../../../.agents/notes/implemented/feature/2026-09-18-terminal-native-tui.zh.md)——本包的设计决策。

终端交互参考（不是依赖）：

- Codex CLI: https://developers.openai.com/codex/cli/features
- Claude Code interactive mode: https://code.claude.com/docs/en/interactive-mode
- Gemini CLI keyboard shortcuts: https://geminicli.com/docs/reference/keyboard-shortcuts/
- Ink 7.1.1 API: https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md

-----

<a id="model-experience"></a>
## 模型体验

### 部署 persona 后备

#### 模型看到什么

本包把基础 `system-prompt` 行的 `personaPrefix` 和 `personaSuffix` 设为下面两个分节，并插值 `{{model}}` 和 `{{cwd}}`；每个随附的 preset（`standard`、`ptc`、`minimal`、`cordis`）都挂载一个 `persona` 行，为其会话遮蔽这两个分节，因此只有在会话的 preset 未组合 persona 行时，这些分节才会到达模型。

##### Persona 前缀

```markdown
You are a coding agent powered by the {{model}} model.
```

##### Persona 后缀

```markdown
Your working directory is {{cwd}}.
```

#### Token 影响

使用随附 preset 的会话没有影响；否则每个请求的系统提示词中，在第一方指引前后各多一个短句。

#### KV Cache 影响

渲染后的分节在模型和工作目录不变时保持不变，因此留在缓存前缀之内；只有模型或工作目录变化时才会重新渲染。

### 终端提示词

#### 模型看到什么

输入框以 `queue` 或 `steer` 准入模式通过共享的 SessionController 发送草稿，因此模型收到的用户消息与 Web 发送的相同；`[Pasted text #1 +42 lines]` 这样的折叠粘贴占位符会在提交前展开为粘贴的文本，绝不会到达模型，终端的渲染、折叠、主题、搜索和选择都不会向请求添加任何内容。

#### Token 影响

等于提交的文本和已暂存的附件；显示提供方返回的推理不会请求额外的提供方内容，也不会改变配置的推理强度。

#### KV Cache 影响

与 Web 相同，准入在已有历史之后追加用户消息，steering 在下一个步骤边界加入；终端绝不改写、重排或重建更早的消息。

### Smart approval 行

#### 模型看到什么

本包以默认限制和 `escalatingTools: [plugin_manager]` 挂载 `smart-approval`；会话选择 `/auto-approve smart` 后，审阅器发送的请求见 [Smart approval README](../../interaction/smart-approval/README.zh.md)。

#### Token 影响

会话保持手动审批时没有影响；选择 Smart 后，每次符合条件的升权请求产生一个有界的审阅请求。

#### KV Cache 影响

审阅请求独立于会话自身的请求，不改变会话的缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明终端不提供哪些功能，以及哪些行为取决于模拟器或宿主。它们是本包当前的约束，不是通用的 CLI 对比或任务待办。

- **没有仅限浏览器的功能**——不复刻插件面板、行内图片渲染、工作区树和浏览器终端；图片以附件标签显示。
- **没有新的编辑或审阅层**——本包不实现 shell 语言、Git 审阅服务、权限策略、Vim 模式或屏幕阅读器模式。
- **只有单列布局**——`/layout split` 和 `DSH_TUI_LAYOUT=split` 会被接受并记录，但工具详情、选择器和预览始终在页面内打开。
- **会话搜索不报告截断**——内容搜索沿用控制器的结果数量上限，达到上限时选择器不显示任何提示；如果预期的会话没有出现，请缩小查询范围。
- **草稿和历史仅限当前进程**——已发送的会话持久化在共享存储中；未发送的草稿、暂存的草稿和提示词历史（最近 100 次提交）在进程退出时丢失。
- **依赖模拟器的信号**——OSC 8 链接、OSC 52 剪贴板写入、焦点上报、桌面通知和带修饰键的 Enter 取决于模拟器设置；剪贴板和图片适配器需要相应的操作系统辅助程序。
- **没有原生端到端验证**——Windows 和 macOS 的适配器 argv 与 UI 交互由隔离测试覆盖，而不是在这些系统上进行端到端运行。
- **未逐字节测试出站一致性**——与 Web 的真实出站 LLM 流量是否一致，必须在相同的提供方和会话配置下检查；共享源码本身不是逐字节的端到端测试。
- **预填充速度是估算值**——核心没有提供独立的预填充计时器，因此到第一个 token 的时间还包括请求准备、排队、传输以及请求前的修剪；在 Laya 修剪或请求启动较慢之后该数值偏低，在本地服务器上最接近服务器自身的预填充速率。
- **动画尺寸固定**——`assets/anim/` 中的四段动画在本包之外按固定尺寸渲染；欢迎鲸鱼需要 64 列、22 行的对话区域，Thinking 场景需要 26 行的终端，两者都不会为较小的终端缩放；新的图案或色调需要新的文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
