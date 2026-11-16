// ============================================================
// 动态知识库：任务状态机与线协议（全链路共享的「词汇表」）
// ============================================================
//
// 干什么：定义一条上传任务从提交到可检索的全部状态、失败停点、
//         以及上传请求体的形状。任务表、worker、路由、前端都引用这里的类型。
//
// 为什么单独成文件：非 UI 层、非 IO 层，是全链路共用的契约。
// 所有模块都引它，改协议只改这一处，不会出现「任务表字段和前端对不上」。
//
// 所属学习计划：`dynamic-kb-learning-plan.md`（任务表 + 后台循环的最简实现）。
//
// 状态机：queued -> chunking -> chunked -> embedding -> searchable | failed
// 每个状态都是「任务表现实里的一行」：
//   queued      上传刚落盘原件，在排队，等后台循环「认领」；
//   chunking    已被 worker 认领、正在切片（认领即改状态，天然防重入）；
//   chunked     切片完成、块已写入块表，但还没有向量——「块预览」专用中间态；
//   embedding   正在向量化入库（worker 认领 chunked 任务后置位）；
//   searchable  全部块已入库，可被检索命中；提问只扫这一层的数据；
//   failed      停在某一层；必须带 stage 标明停点，重试从该层续跑。
//
// 硬规则：同一文档再次上传用同一个 docId（由 uploader 按「分类 + 文件名」复用），
// 入库时先清该「分类 + docId」的旧块再写新块——库里永远只有最新一版。

// ------------------------------------------------------------
// 任务当前状态
// ------------------------------------------------------------
// 作用：worker 按它「取活」（只挑 queued / chunked），
//       前端按它展示进度（转圈 / 成功 / 失败）。
// 一个任务同时只处于一个状态，状态推进只能单向走（失败除外）。
export type KbTaskStatus =
  | "queued"        // 排队中：上传只做了「收件」，还没被后台循环取走
  | "chunking"      // 切片中：已被认领，正在把 Markdown 切块（认领即置位，防重复取走）
  | "chunked"       // 已切完：块已落块表、可预览，但还没有向量，不能检索
  | "embedding"     // 入库中：正在逐批 embedding，块/向量尚未写完
  | "searchable"    // 可检索：向量已入库，提问只扫这一层
  | "failed";       // 失败：必须配合 stage 标明停在哪一层

// ------------------------------------------------------------
// 失败停在哪一层
// ------------------------------------------------------------
// 作用一：给用户可读的失败位置（读原件失败 / 切片失败 / 向量化失败）。
// 作用二：给日志排查定位；重试时（步骤 7）复位 queued 由 worker 整篇续跑。
export type KbTaskStage =
  | "read"    // 读磁盘原件失败：文件没落上或已被删
  | "chunk"   // 切片失败：内容问题（空文件 / 全是垃圾块 / 切分器抛错）
  | "embed";  // 向量化入库失败：embed 或写盘抛错

// ------------------------------------------------------------
// 一条上传任务记录（任务表里的最小字段）
// ------------------------------------------------------------
// 任务表是上传、worker、列表三者共享的中枢，字段要「够用且不冗余」：
// - 身份字段（id / docId / filename / category）建任务时定死，之后不可变；
// - 状态字段（status / stage / error / chunkCount）由 worker 推进；
// - 时间字段（createdAt / updatedAt）给列表排序和「有没有动过」的判断。
// 字段表详见学习计划第二部分。
export interface KbTask {
  // 任务 id：kb_{timestamp}_{random}，一次上传一条、绝不重复
  id: string;
  // 文档身份：同「分类 + 文件名」复用同一 docId（由 uploader 保证）；
  // 它是「替换单位」——入库、删除都按它定位，旧版同名文件被整篇覆盖
  docId: string;
  // 原始文件名，如 stage3-rag-notes.md；与 docId 一起组成唯一身份
  filename: string;
  // 所属分类：检索的硬边界，上传时必须携带、检索时必须带入（步骤 6）
  category: string;
  // 当前状态（状态机节点，见上方 KbTaskStatus 说明）
  status: KbTaskStatus;
  // 失败停点（read / chunk / embed）；成功状态为 null
  stage: KbTaskStage | null;
  // 失败原因文案，直接展示给用户；成功状态为 null
  error: string | null;
  // 切出的块数；chunking 之前为 null，chunked 之后等于块表实时值
  chunkCount: number | null;
  // 创建时间（毫秒时间戳），任务列表按它倒序（新的在前）
  createdAt: number;
  // 最近一次状态变更时间，列表一眼能看出「这条有没有在动」
  updatedAt: number;
}

// ------------------------------------------------------------
// 磁盘记录形状校验
// ------------------------------------------------------------
// 干什么：tasks.json 是持久化文件，理论上谁都能改、也可能被写坏。
//         这个函数逐字段检查一条记录的形状，坏记录直接排除。
// 为什么：列表/认领逻辑都按合法字段进行操作，一条脏数据
//         （字段缺失 / 类型不对）不挡在这里，就会让整个逻辑崩溃或静默丢任务。
// 类型谓词（value is KbTask）：通过校验后 TS 自动把它当成 KbTask 用。
export function isValidKbTask(value: unknown): value is KbTask {
  // 非对象 / null 一律不是合法记录（先排除最粗的一类）
  if (typeof value !== "object" || value === null) return false;
  // 转成 Partial 后再逐字段验证，避免每处都做类型断言
  const task = value as Partial<KbTask>;
  // 下面逐字段检查：身份与状态字段必须是字符串
  return (
    typeof task.id === "string" &&        // 任务 id 必须是字符串
    typeof task.docId === "string" &&     // 文档身份必须是字符串
    typeof task.filename === "string" &&  // 文件名必须是字符串
    typeof task.category === "string" &&  // 分类必须是字符串
    typeof task.status === "string" &&    // 状态必须是字符串
    // stage 允许 null，或必须是三个合法停点之一
    (task.stage === null || task.stage === "read" || task.stage === "chunk" || task.stage === "embed") &&
    // error 允许 null，或必须是字符串（失败原因文案）
    (task.error === null || typeof task.error === "string") &&
    // chunkCount 允许 null，或必须是数字（块数统计）
    (task.chunkCount === null || typeof task.chunkCount === "number") &&
    // 两个时间戳必须是数字（列表排序 / 状态新鲜度依赖它）
    typeof task.createdAt === "number" &&
    typeof task.updatedAt === "number"
  );
}

// ------------------------------------------------------------
// 上传请求体
// ------------------------------------------------------------
// 学习期决策（见 tasks/dynamic-kb-step0-assets.md）：
// 项目无 multer 依赖，上传走 JSON + base64——客户端一行组包、
// 服务端 Buffer.from 解码，1MB 的学习文档绰绰有余。
export interface KbUploadBody {
  // 原始文件名，如 notes.md；服务端只取 basename 防路径穿越
  filename: string;
  // base64 编码的文件内容；校验通过后由 uploader 解码写盘
  content: string;
  // 必须选定的分类；为空直接拒绝（不存在「无名类」脏数据）
  category: string;
}
