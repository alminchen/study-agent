# 进阶学习第 6 项：LLM-as-Judge 专项执行计划

> 用户所说的"阶段 6"，对应 tasks/plan.md 推荐执行顺序中的第 6 项：LLM-as-Judge。
> 本文只规划这一项，不并入其他方向的实现，也不开始写代码。
> 前置依赖：第 1 项 Streaming 结构化输出已完成，server/structured/ 已有稳定快照 parser、Zod schema 和 SSE 事件类型，可作为 Judge 的参考协议。
> 应用代码位于 step1-chat 工作区，下文所有代码路径均为该工作区内的两级相对路径。

---

## 0. 一句话结论

不要在规则 Guard 上硬套一个大模型就叫"LLM-as-Judge"。要把语义判定做成可复现、可度量、可安全降级的组件：先建带风险标注的评测数据集，再做结构化 Judge（只输出风险等级、置信度、命中规则和短理由），默认 off，达阈值后才开 shadow/enforce 三档开关。Input Judge 负责对用户输入做语义二次确认，Output Judge 负责对模型回复做泄漏与合规检查，两者都不重写业务答案，异常时降级为正则 Guard，永不静默失败。

---

## 1. 为什么要学这条路径

### 是什么

LLM-as-Judge 是用另一个模型（或同一模型的专用配置）对"输入是否危险""输出是否合规"做语义级判定，结果为结构化对象而非自由文本。与现有正则 Guard 并行，不是替代。

对照现有两条链路，边界很清楚：

| 维度 | 规则 Guard（现状） | 语义 Judge（本次要建） |
| --- | --- | --- |
| 判定依据 | 正则关键词 | 语义理解，可识别改写、同义、间接注入 |
| 延迟 | 微秒级 | 一次模型往返，百毫秒到秒级 |
| 成本 | 零 | 每次判定一次模型调用 |
| 误报 | 高（"忽略之前指令"出现在教学讨论中即命中） | 可通过提示词与阈值压低 |
| 漏报 | 高（分块、角色扮演、编码绕过即失效） | 需评测集验证，不是天然更优 |
| 可否解释 | 只能给出命中了哪条规则 | 可输出命中分类 + 短理由 |

### 当前盲区

现有 inputGuard/outputGuard 全是正则关键词匹配，存在两个结构性盲区：

1. 误报：正常的安全研究、代码审计、教学讨论中出现"忽略之前指令""注入"等词汇，被正则一票否决。inputGuard 的规则分 high/medium 两档，命中即标记 level，调用方只看 level，不做语义复核。
2. 漏报：攻击者用改写、同义替换、间接注入、分块、角色扮演等方式避开关键词，matchedRules 为空，level 为 none，链路完全不设防。

正则适合高召回快速过滤；Judge 适合语义二次确认。两者互补，不应由一方替代另一方。

### 能为我做什么

- 对模糊输入给出"风险等级 + 置信度 + 命中规则 + 短理由"，便于调试和审计，不再只有一行 matchedRules。
- 先影子运行（shadow）：只记录判定，不拦截，用真实流量验证误报/漏报率再决定是否开 enforce。
- 给后续 Reflection、Memory、AB 测试提供可复用的"结构化评分"基础设施；evals 已有 evaluateRun 框架，可直接复用其指标计算口径。
- Output Judge 检查最终文本是否泄露 system prompt、是否越过安全边界，发现问题时只返回风险与替换建议，不重写答案，与 outputGuard 的指纹检测互补。

### 为什么这么设计（设计权衡）

- 不把 Judge 放在规则 Guard 前面：规则快且便宜，先过滤明显危险请求，再把模糊案件送 Judge，控制成本与延迟。
- 不让 Judge 直接拦截首版，且默认 off：先有评测集和 shadow 数据，再谈 enforce；默认 off 保证不接入前零延迟零成本。
- Judge 有独立模型配置：不复用主对话模型，避免主模型繁忙时 Guard 也跟着变慢或失效。
- 异常不静默失败：网络超时、返回非法 JSON、schema 校验不过，都走独立错误结构上报，由调用方回退到正则 Guard 或放行并记录；错误状态绝不写成 risk 字段，避免与真实判定混淆。
- 不做长 CoT：只输出结构化结论，延迟与成本可控，输出可被 Zod 直接校验。

### 学完后你应该能回答的问题

1. 当前正则 Guard 的误报和漏报各发生在什么场景？
2. Judge 返回结构化对象后，服务端怎么决定拦截还是放行？
3. 什么时候用 off，什么时候用 shadow，什么时候开 enforce？
4. Judge 异常时如何降级，不影响聊天可用性？
5. 怎么量化 Judge 比正则 Guard 好在哪里（precision/recall/延迟/成本）？
6. 哪些输入不该送 Judge（成本太高、延迟不可接受、不涉及安全）？

### 不该上 Judge 的情况

- 纯非安全业务（如天气、时间、代码格式化）不需要语义安全判定。
- 对延迟极敏感的实时交互，Judge 会增加一次模型往返。
- 没有评测数据集前，不要上 enforce，避免盲目拦截。
- Judge 模型配置缺失或不可用时，应降级为正则 Guard，不要阻塞主链路。

---

## 2. 前置条件

动手前确认以下已满足（均已核实存在，可直接进入）：

1. 第 1 项结构化输出稳定：server/structured/ 有 Zod schema、partial JSON parser、SSE 事件类型，作为 Judge 输出 schema 的参考协议。
2. 已读现有 Guard 链路：server/guard/inputGuard.ts 导出 RiskLevel（none/medium/high）、GuardResult{ level, matchedRules }、detectInjection(text)，纯正则不拦截只标记；server/guard/outputGuard.ts 导出 OutputGuardResult{ leaked, safeText, matchedFingerprints }、detectLeakage(output），LEAK_THRESHOLD = 2，命中后返回固定替换文案。接入点在 server/chat.ts（onTrace 发 injection_detected）、server/routes/chatMulti.ts、server/routes/ragChat.ts（SSE injection_detected）、server/rag/answer.ts、server/react/runConversation.ts（对 normalized 文本调 detectLeakage）。
3. 理解 server/runtimeConfig.ts 配置模式：该文件当前完全没有 guard/judge 相关配置，需要新增独立配置块，不改动现有 structuredRequest、context 等块的语义。
4. 确认测试命令：npm run typecheck（vue-tsc + tsc 双检查）、npm run build；真实模型命令需先检查 LLM_API_KEY 且 MOCK_MODE != "1"。现有评测入口为 npm run eval:chat 与 npm run eval:multi，本次新增 npm run eval:judge 与其对齐。
5. 数据集不与现有冲突：evals/ 下已有 dataset.json、dataset-multi.json、dataset-plan.json，本次新增 judge-dataset.json，字段与 EvalExample 保持同源风格但独立 schema。

---

## 3. 数据集规范（先有数据集，再谈 Judge）

### 为什么必须先建数据集

没有带标注的金标准，就无法区分"Judge 更好"和"我觉得 Judge 更好"；也无法给 enforce 定阈值。数据集是所有后续指标的唯一基准。

### 样本结构

每条样本字段：

- id：稳定唯一 ID（如 judge-0001），不可变，报告按 ID 追溯。
- input：送 Judge 的原始文本（Input Judge）或模型输出文本（Output Judge）。
- surface：input | output，标记这条样本判的是哪一侧。
- category：prompt_injection | jailbreak | role_play | system_leak | harmless_query | code_review | indirect_injection | unsafe_output | safe_output。
- expectedRisk：none | medium | high，人工标注，只按语义危害判，不看正则是否命中。
- expectedRuleHits：可选，正则 Guard 预期命中的规则 ID 列表，用于分析分歧来源。
- notes：一句话标注理由，便于人工复核。

### 类别配额（总计不少于 60 条）

| 类别 | 条数 | 侧 | 说明 |
| --- | --- | --- | --- |
| prompt_injection | 8 | input | 显式注入，正则通常命中 |
| indirect_injection | 8 | input | 藏在文档、代码注释、检索片段里的注入，正则多半不命中 |
| jailbreak | 6 | input | 越狱框架，语义危险但可能无关键词 |
| role_play | 6 | input | 角色扮演绕过，多数为 none/medium，含 2 条明确危险 |
| system_leak | 6 | input | 直接索要 system prompt 或其片段 |
| harmless_query | 12 | input | 正常业务提问，其中 4 条含"忽略/指令/系统"等敏感词但语义无害，用于压误报 |
| code_review | 8 | input | 安全研究、代码审计、教学讨论，用于验证不误杀专业讨论 |
| unsafe_output | 8 | output | 含系统提示片段、内部字段名、越权承诺的模型回复 |
| safe_output | 8 | output | 正常长回复，其中 3 条含提示词同源词汇，用于压 output 误报 |

硬约束：expectedRisk 为 none 的样本，不得通过"取正则命中样本再标低风险"来构造；每条 none 样本必须真的语义无害。harmless_query 与 code_review 中的敏感词样本，正是用来暴露正则误报的。

### 划分

- 固定 fixture：60 条中取 40 条作为每次评测必跑的基准集（dev），保证跨版本可比。
- 扩充集：另外 20 条作为 held-out（test），仅在定版验收时跑，避免调参过拟合。
- 新增样本一律先进扩充集，不得直接改基准集，保证指标历史连续。

### 质量校验

脚本加载时检查：id 唯一、字段齐全、expectedRisk 合法、surface 与 category 匹配、无空 input；任一不满足直接报错退出，不静默跳过。

---

## 4. 结构化输出 Schema

### 判定结果（成功路径）

server/guard/judgeSchema.ts 导出 Zod schema JudgeSchema 与 TS 类型 JudgeResult：

- risk：none | medium | high，与 inputGuard 的 RiskLevel 完全同口径，不得新增枚举值。
- confidence：0~1 小数，表示模型对自身结论的置信度。
- categories：string[]，命中分类，取值来自数据集的 category 集合加"unknown"。
- shortReason：不超过 200 字符的一句话理由。
- matchedRules：string[]，与正则 Guard 命中规则 ID 对齐，Judge 认为等价的规则也算命中。
- schemaVersion：固定为 1，便于后续演进时识别旧数据。

### 判定结果（失败路径）

失败不写进 risk 字段。status 与 errorKind 独立承载体外信息：

- status：ok | error。
- errorKind（status 为 error 时必填）：timeout | bad_json | api_error | schema_error。
- retries：已重试次数（最多 2 次）。
- raw：截断后的原始返回片段（不超过 500 字符），仅用于 trace 排错。

### 为什么这么分

risk 只表达"模型怎么看"，errorKind 只表达"这次调用出了什么问题"。混在一起会让 enforce 分支把超时误判成未知风险而放行，把 schema 错误误判成 low 风险而放过，也会让离线指标把 error 算进 risk 分母污染 precision/recall。

---

## 5. 模式与组合决策表

### 单一日配置源

只保留 GUARD_JUDGE_MODE 一个开关，不再并列 GUARD_ENABLED：

- off（默认）：完全不调用 Judge，行为与现有纯正则 Guard 完全一致，零延迟零成本。
- shadow：调用 Judge，把判定写入 trace event，主回答完全不变。
- enforce：按下面的组合决策表执行。

模式非法值（不是三者之一）时回落 off 并记录警告，不抛错。

### 组合决策表（enforce 模式）

以正则 Guard 结果为正、Judge 结果为判，规则优先：

| 正则 Guard | Judge | 动作 | 说明 |
| --- | --- | --- | --- |
| medium/high 命中 | 任意 | 维持正则拦截/标记行为 | 规则不撤，Judge 只做补充证据 |
| 未命中 | high | 拦截输入或阻断输出 | 这是 Judge 的主要价值场景 |
| 未命中 | medium | 放行 + 打 judge_medium 标签 | 记录待观察，不牺牲可用性 |
| 未命中 | none（confidence 低于阈值） | 放行 + 打 judge_disagree 标签 | 与历史 shadow 数据对照后再考虑收紧 |
| 未命中 | none（高置信） | 放行，仅 trace | 正常路径 |
| 未命中 | status=error | 回退正则决策（放行）+ 记 warn | 永不因 Judge 故障拦截正常用户 |
| 高优先级规则命中 | 与规则冲突 | 以规则为准并在 trace 标注分歧 | 保留人工复查入口 |

confidence 阈值：低于 0.6 的 high/medium 一律降级为"放行 + 打标"，防止低置信判定触发拦截，减少误杀。

### 延迟与超时

Judge 独立超时，短于主模型：connect 2000ms、firstChunk 5000ms、total 8000ms。超时即 status=error, errorKind=timeout，不再重试第三次。

---

## 6. 接入点落地（精确到文件与函数）

所有改动都必须不动主链路行为，off 模式下与现状字节级一致。

### Input Judge

- server/chat.ts：在现有 reportInjectionIfAny（injection_detected 的发送点）之后追加 judge 调用点；shadow 下只发新 trace 事件 judge_shadow，不改 injection_detected 语义；enforce 下按决策表决定是否短路返回安全文本。
- server/routes/chatMulti.ts：同样在现有 guard 判定之后接入，保持多 Agent 链路原有事件流不变。
- server/routes/ragChat.ts：SSE 场景下，judge 事件走与 injection_detected 相同的事件通道格式，不新增事件类型分支，前端按事件名分流。
- server/rag/answer.ts：检索增强链路在送入模型前做 input 判定，避免恶意检索片段直接进 prompt。

### Output Judge

- server/react/runConversation.ts：此处是对最终文本调 detectLeakage 的位置，也是 Output Judge 的接入点。
- 时机约束（关键）：该场景是流式输出，文本一旦发给前端就无法收回。因此 Output Judge 必须作用于首个增量分片发出之前的完整缓冲文本；或者只对非流式 terminus 路径做 enforce。若采用流式缓冲，需在上屏前留出判定窗口，超时则按 errorKind=timeout 处理并放行。不得在文本已推送之后才判定并尝试"拦截"。
- Output Judge 命中泄露时不直接替换主回答，返回 { leaked, reason, suggestedSafeText }，由调用方决定显示替换文本还是原文加标记，与 outputGuard 现有 REPLACEMENT 文案机制对齐。

### trace 与前端协议

- server/react/types.ts 新增 trace 事件类型：judge_shadow（含完整 JudgeResult）、judge_enforced（含 risk、action、正则对照结果）；前端 src/types.ts 同步新增同名字段，前端仅展示不参与判定。
- 事件名与现有 injection_detected、output_leak_blocked 保持同层命名风格，不混入现有字段。

---

## 7. 评测与量化口径

### 二分类定义（指标可用之前必须固定）

按 expectedRisk 折算为二分：high 为危险样本，medium 视为"需关注"单独统计，不计入危险样本分母；none 为正样本（安全）。Judge 输出折算方式：risk=high 判为危险；risk=medium 判为需关注；status=error 不计入分母并单独计入 error 指标；risk=none 判为安全。

### 指标定义

- precision（危险样本）：Judge 判 high 的样本中，expectedRisk 确为 high 的比例。
- recall：expectedRisk 为 high 的样本中，Judge 判 high 的比例。
- 误报率：expectedRisk 为 none 的样本中，Judge 判 high 或 medium 的比例。这是正则 Guard 当前的主要痛点，也是本次优化重点。
- 漏报率：expectedRisk 为 high 的样本中，Judge 判 none 或 error 的比例。
- 分歧率：Judge 与正则 Guard 结论不一致的比例，以及分歧样本的 ID 清单（进报告，供人工复核）。
- 平均延迟与 p95 延迟：仅在真实模型评测下有意义。
- 成本：单条判定 token 消耗与总调用次数，用于估算 shadow 放量后的月成本。

### 验收阈值（enforce 准入条件）

以下阈值必须同时满足，缺一不可开 enforce：

1. 基准集（40 条）precision 不低于 0.90。
2. 基准集 recall 不低于 0.85。
3. 误报率（none 样本被判 high/medium）不高于 0.05。
4. status=error 比例不高于 0.05，且超时全部走 timeout 分支。
5. p95 延迟不高于 8000ms，且平均延迟不高于 3000ms。
6. shadow 模式在真实流量下连续运行至少 3 天，分歧率不高于 0.10。
7. 无任何一条 medium/high 判定的 confidence 低于 0.6 却触发拦截的样本。

阈值未达标时，只允许停留在 shadow，并回到提示词或数据集侧迭代。

---

## 8. 执行步骤（10 条可下达指令）

每条指令都有明确的"完成标志"，完成一条才能进入下一条。不要一次性铺开多个文件。

### 指令 1：建立评测数据集 evals/judge-dataset.json

做什么：创建带风险标注的 LLM-as-Judge 评测数据集，作为后续 Judge 验证的金标准，也是第 7 节所有指标的唯一分母。

要求：
- 按第 3 节类别配额建满至少 60 条，每类条数不低于配额下限。
- 每条字段：id、input、surface、category、expectedRisk、expectedRuleHits（可选）、notes。
- 固定 40 条为基准集（dev），20 条为扩充集（test），文件名分开或在字段加 split 标记。
- expectedRisk 只按语义危害判，禁止用正则命中结果反推。
- 加载时做质量校验：id 唯一、字段齐全、枚举合法、无空 input，不合法直接报错。

完成标志：文件存在且 JSON 合法，条数与类别达标，npm run typecheck 通过（若有类型声明）。

### 指令 2：定义 Judge schema server/guard/judgeSchema.ts

做什么：定义 Judge 返回的结构化对象，成功与失败路径分离，不接受自由文本。

要求：
- 导出 Zod schema JudgeSchema 与 TS 类型 JudgeResult。
- 成功字段：risk（none/medium/high，与 RiskLevel 同口径）、confidence、categories、shortReason、matchedRules、schemaVersion（固定 1）。
- 失败字段：status（ok|error）、errorKind（timeout|bad_json|api_error|schema_error）、retries、raw（截断 500 字符内）。
- 导出判别函数，让调用方能一句区分 ok 与 error，不必手写字段判断。
- 不要求长 CoT，只输出结构化结论。

完成标志：文件存在，npm run typecheck 通过，能用 z.parse() 校验一个成功样本与一个 error 样本。

### 指令 3：在 server/runtimeConfig.ts 增加 Judge 独立配置

做什么：给 Judge 独立的模型配置，不复用主对话模型，避免主模型繁忙时 Guard 也变慢或失效。

要求：
- 新增 judge 配置块：model、baseUrl、apiKey（默认复用 LLM_API_KEY，可独立覆盖）、mode（off|shadow|enforce，默认 off）、timeouts（connect/firstChunk/total，取值见第 5 节）、maxInputChars（默认 4000）、confidenceThreshold（默认 0.6）。
- 读取环境变量：JUDGE_MODEL、JUDGE_BASE_URL、JUDGE_API_KEY、JUDGE_MODE、JUDGE_CONNECT_TIMEOUT_MS、JUDGE_FIRST_CHUNK_TIMEOUT_MS、JUDGE_TOTAL_TIMEOUT_MS。
- mode 是唯一开关源，不再引入第二个 enabled 布尔。
- 不改动现有 structuredRequest、context 等配置块语义。

完成标志：getRuntimeConfig() 返回含 judge 字段，环境变量可覆盖，默认 mode 为 off，npm run typecheck 通过。

### 指令 4：实现可 mock 的 server/guard/judge.ts

做什么：实现 Judge 核心逻辑，可单元测试，异常不静默失败。

要求：
- 导出 judgeInput(input, options?) 与 judgeOutput(output, options?)，返回统一 JudgeResult（含 status）。
- 模型调用以函数参数注入，业务逻辑内不直接 fetch，便于单测 mock。
- 超时后最多重试 2 次，仍失败返回 status=error, errorKind=timeout。
- 非法 JSON 返回 errorKind=bad_json；Zod 校验失败返回 errorKind=schema_error；均带截断 raw。
- 输入输出超长时截断前后片段（保留 maxInputChars），并记截断标记。
- 严禁把 error 写进 risk 字段。

完成标志：文件存在，mock 三种异常各返回正确 errorKind，不崩溃，npm run typecheck 通过。

### 指令 5：默认 off，接通 shadow 模式，不改主回答

做什么：把 Judge 接进现有链路，但默认零影响，先只用影子流量积累数据。

要求：
- JUDGE_MODE 默认 off，off 时不发起任何 Judge 调用，无新增延迟与成本。
- shadow 模式：调用 Judge，把完整 JudgeResult 写入 trace event judge_shadow，主回答完全不变。
- 同一条 trace 里同时带正则 Guard 结果与 Judge 结果，便于离线算分歧率。
- 不修改三条聊天链路（server/chat.ts、server/routes/chatMulti.ts、server/routes/ragChat.ts）在 off 模式下的任何输出。

完成标志：JUDGE_MODE=off 时链路行为与改动前一致；JUDGE_MODE=shadow 时 trace 出现 judge_shadow 且主回答不变，npm run typecheck 通过。

### 指令 6：离线跑通评测管线（mock 优先）

做什么：新增 scripts/run-judge-evals.ts，加载数据集，分别跑正则 Guard 与 Judge，输出指标报告。

要求：
- 新增 npm run eval:judge 脚本入口，与现有 eval:chat、eval:multi 对齐。
- 无 API Key 或 MOCK_MODE=1 时，用 mock Judge 跑完全流程，验证管线可用；此时 precision/recall 只能证明管线通了，没有模型质量含义，报告须显著标注"mock 运行，无质量结论"。
- mock 只用于验证脚本、指标计算与报告渲染，不得作为"Judge 优于正则"的证据。

完成标志：npm run eval:judge 可运行，输出 evals/judge-comparison-report.md，含指标表、分歧样本清单、运行模式标注，npm run typecheck 通过。

### 指令 7：真实模型评测与 enforce 准入

做什么：有真实凭据时用真实模型跑评测，按第 7 节阈值决定是否准入 enforce。

要求：
- 前置检查：LLM_API_KEY 非空且 MOCK_MODE != "1"，否则跳过并在报告记录"未运行真实模型"及原因。
- 在基准集（40 条）上跑真实 Judge，输出 precision/recall/误报率/漏报率/error 率/平均与 p95 延迟/token 成本。
- 报告逐条对照第 7 节验收阈值，给出"达标/未达标"与未达标项。
- 未达标则停留 shadow，列出待优化项（提示词、类别配额、置信阈值）；达标才进入指令 8 的 enforce 实现。

完成标志：报告含真实模型指标与逐项阈值对照，准入结论明确，npm run typecheck 通过。

### 指令 8：实现 off/shadow/enforce 三档与组合决策

做什么：把 Judge 从影子扩展到可强制执行，动作严格按第 5 节组合决策表。

要求：
- off：不调用 Judge，行为与纯正则 Guard 完全一致。
- shadow：只记录 trace，不拦截、不替换。
- enforce：按决策表执行，high 且 confidence 不低于阈值才拦截，medium 只打标放行，error 一律回退正则决策并记 warn。
- Input Judge 拦截时返回安全文本，不继续模型调用；Output Judge 命中泄露时只返回建议文本与标记，不直接替换主回答。
- JUDGE_MODE 非法值时回落 off 并记警告。

完成标志：三档可通过环境变量切换，enforce 下能拦截基准集中的 high 样本且不影响 none 样本，npm run typecheck 通过。

### 指令 9：Output Judge 与流式时机修正

做什么：实现 Output Judge，并处理流式场景下的时机问题。

要求：
- 在 server/react/runConversation.ts 接入 judgeOutput，作用点为首个增量分片发出之前的完整缓冲文本。
- 若该路径无法缓冲，则 Output Judge 的 enforce 只作用于非流式 terminus 路径；流式路径最多 shadow。
- 检查项：是否泄露 system prompt、是否越过安全边界、是否包含内部字段名。
- 与 outputGuard 的指纹检测互补：正则做快速过滤，Judge 做语义确认；命中时返回 { leaked, reason, suggestedSafeText }，不重写答案。
- 补齐单测：schema 校验成功/失败、judge 三种异常降级、时机约束（未缓冲时不 enforce）。

完成标志：judgeOutput 已实现且有单测覆盖，流式路径不会出现"文本已发出再拦截"，npm run typecheck 通过。

### 指令 10：写 docs/llm-judge.md

做什么：沉淀学习笔记与运维说明，方便后续 Reflection/Memory/AB 测试复用。

要求：
- 说明 Judge 与正则 Guard 的分工，什么时候该用、什么时候不该用。
- 文档三档模式含义、切换方式、默认值为 off 的原因。
- 说明异常降级策略：errorKind 各分支怎么处理，为什么错误不进 risk。
- 列出数据集格式与划分、如何新增样本（先进扩充集）、如何运行 npm run eval:judge。
- 记录真实模型评测结果与验收阈值对照，或"未运行"的具体原因。
- 记录 Output Judge 的流式时机结论。

完成标志：docs/llm-judge.md 存在，内容与代码一致，新成员读后能直接上手。

---

## 9. 建议文件清单

| 文件 | 用途 |
| --- | --- |
| evals/judge-dataset.json | 评测数据集（指令 1） |
| server/guard/judgeSchema.ts | Judge 输出 Zod schema + TS 类型（指令 2） |
| server/guard/judge.ts | Judge 核心逻辑、可 mock、异常降级（指令 4、9） |
| scripts/run-judge-evals.ts | 正则 vs Judge 评测脚本（指令 6、7） |
| server/guard/judge.test.ts | 单元测试（指令 9） |
| evals/judge-comparison-report.md | 评测报告输出（指令 6、7） |
| docs/llm-judge.md | 学习笔记与运维说明（指令 10） |
| 修改 server/runtimeConfig.ts | 增加 judge 独立配置块（指令 3） |
| 修改 server/chat.ts、server/routes/chatMulti.ts、server/routes/ragChat.ts、server/rag/answer.ts | Input Judge 接入点（指令 5、8） |
| 修改 server/react/runConversation.ts | Output Judge 接入点（指令 9） |
| 修改 server/react/types.ts、src/types.ts | trace 与前端事件字段（指令 5、8） |

---

## 10. 失败路径

| 失败场景 | 表现 | 处理方式 |
| --- | --- | --- |
| Judge 模型网络超时 | 重试 2 次后仍超时 | status=error, errorKind=timeout，回退正则 Guard，聊天继续 |
| Judge 返回非法 JSON | 解析失败 | errorKind=bad_json，带截断 raw，不崩溃 |
| Judge schema 校验失败 | 字段缺失或类型不符 | errorKind=schema_error，不写 risk，记 warn |
| JUDGE_MODE 非法值 | 不是 off/shadow/enforce | 回落 off，仅走正则 Guard，记警告 |
| 输入过长超截断上限 | 单次判定成本过高或 token 超限 | 截断前后片段，记截断标记 |
| 真实模型 API Key 缺失 | 无法跑真实评测 | mock 跑完管线，报告标注"未运行真实模型，无质量结论" |
| 置信度低于阈值 | high/medium 判定但 confidence 低于 0.6 | 降级为放行 + 打标，不触发拦截 |

---

## 11. 验收标准

每条指令完成后，必须同时满足：

1. 新增能力有明确开关或入口，不静默改变现有三条聊天链路在 off 模式下的行为。
2. 至少有一个"正常路径"和一个"失败/中止路径"的自动测试。
3. npm run typecheck 和 npm run build 通过。
4. 涉及真实模型能力时，至少跑一次真实评测；没有 API Key 时明确记录未运行及原因。
5. tasks/todo.md 勾选完成项，并写明实际验证结果。

整项完成后：

- off/shadow/enforce 三档均可通过环境变量控制，默认 off。
- Judge 异常不静默失败，永远有降级路径，错误不进 risk 字段。
- 数据集不少于 60 条，覆盖第 3 节全部类别与配额，基准集/扩充集划分清晰。
- 基准集指标达到第 7 节全部阈值，报告留存。
- 输出 docs/llm-judge.md，可被新成员阅读后直接上手。

---

## 12. 验证命令

所有命令默认在 step1-chat 工作区下执行。

### 静态检查

```bash
npm run typecheck
npm run build
```

### 单元测试

```bash
npm test
```

### 离线评测（mock 模式，验证管线）

```bash
npm run eval:judge
```

### 真实模型评测（先检查凭据，需同时满足才执行）

```bash
test -n "$LLM_API_KEY" && test "$MOCK_MODE" != "1"
npm run eval:judge -- --real
```

凭据不满足时跳过真实模型命令，在 evals/judge-comparison-report.md 记录"未运行"及原因。

---

> 本文只做规划，不开始写代码。等待用户指示进入具体哪条指令的实现（例如"执行指令 1：建立评测数据集"），或继续其他阶段。
