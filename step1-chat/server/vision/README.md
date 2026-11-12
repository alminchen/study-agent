# server/vision/ — 图片输入的服务端实现

> 当前状态：**实施中**。计划与验收口径见 `tasks/vision-plan.md`，设计与配置说明见 `docs/vision.md`。
> 本文只讲代码结构。

## 模块职责

把「前端传过来的图片附件」变成「供应商能吃的多模态消息」，
中间要过四道关：尺寸与格式校验 → 模型能力判定 → token 估算 → 协议转换。

## 文件说明

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 服务端契约的唯一来源：允许的 MIME、三个上限常量、错误码、附件类型 |
| `validateImage.ts` | 单图校验：MIME、base64 合法性、字节数、像素尺寸 |
| `validateRequestMessages.ts` | 整条请求校验：图片张数、附件与 messages 的对应关系 |
| `capability.ts` | 模型是否支持图片：环境变量白名单 → id 启发式 → 运行期降级 |
| `estimateImageTokens.ts` | 按像素尺寸估算图片 token 占用 |
| `toProviderMessages.ts` | 转成供应商的 `text + image_url` 内容 parts |

## 限制常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `ALLOWED_IMAGE_MIME_TYPES` | `image/png` / `image/jpeg` / `image/webp` | 三端（浏览器端、服务端、前端类型）保持一致 |
| `MAX_IMAGE_BYTES` | 1MB | 单图解码后字节上限 |
| `MAX_IMAGE_DIMENSION` | 4096px | 单图像素边长上限 |
| `MAX_IMAGES_PER_REQUEST` | 1 | 每次请求图片张数上限 |

这三个上限目前是**代码常量，不是环境变量**。

## 错误码

服务端定死错误码和文案，前端只按 code 映射提示，不重写：

`image_too_large`、`image_unsupported_format`、`image_invalid_data`、
`image_dimensions_exceeded`、`vision_model_unsupported`、
`vision_payload_too_large`、`vision_provider_rejected`

## 命名约定

字段必须与前端 `src/types.ts` **同名同义**，否则跨端契约会静默丢数据。
`server/vision/types.ts` 是服务端侧唯一契约来源，前端按逐字对齐维护一份镜像类型。

## 相关文档

- `docs/vision.md`：能力判定优先级、图片限制、隐私约定
- `tasks/vision-plan.md`：专项执行计划与验收口径
- `src/vision/README.md`：前端压缩与校验
