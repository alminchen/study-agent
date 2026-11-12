# src/vision/ — 前端图片处理

> 当前状态：**实施中**。服务端对端说明见 `server/vision/README.md`，设计说明见 `docs/vision.md`。

## 模块职责

在图片发出去之前，先把用户选的原始图压到可接受的体积，并做一次快速校验。

## 文件说明

| 文件 | 职责 |
| --- | --- |
| `compressImage.ts` | canvas 降采样 + 编码压缩，产出可发送的 `ChatAttachment` |
| `validateImage.ts` | 前端快速校验，与服务端阈值和校验顺序保持一致 |

## 压缩流程

1. 解码源图：`createImageBitmap`，旧浏览器回退 `<img>` + objectURL
2. 最长边降到 1600px
3. 有透明通道 → webp（不支持时退回 png 保留透明）；否则 jpeg 质量 0.85
4. 压完还超 1MB → 最长边再降到 1200px 重压一次；仍然超则拒绝
5. 返回附件：`data` 是 base64 裸串（不含 `data:` 前缀），`previewUrl` 是 objectURL

## 前端校验是体验，不是裁决

前端阈值与 `server/vision/types.ts` 保持一致，校验顺序也对齐
（data → MIME → 像素 → 字节）。

**但最终合法性以服务端为准。** 前端校验只是为了早点给出提示，
避免白跑一趟；服务端永远会重新校验一遍，不信任前端送来的任何尺寸和 MIME。

## 内存与持久化

- `previewUrl` 是 objectURL，只在当前会话可预览，不落盘
- base64 **不进 localStorage**，历史消息里只存图片元数据
- 缩略图组件只消费内存态附件

## 相关文档

- `docs/vision.md`：能力判定、图片限制、隐私约定
- `server/vision/README.md`：服务端校验与协议转换
