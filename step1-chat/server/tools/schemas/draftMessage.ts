import type { ToolSchema } from "../types.js";

/**
 * draft_message — 学习「人工确认」用的有后果假工具（schema 侧）。
 *
 * 为何单独造一个假工具，而不是给 getWeather 加确认？
 * - 天气/时间是只读，加确认会破坏现有体验与回归用例
 * - 用「起草/发送消息」语义，最贴近「跑了就有后果」
 *
 * 真实外发（邮件/IM）本期不做；methods 里只模拟成功。
 * 对接聊天后：须进 toolsRequiringConfirm，且 system 写明何时调用。
 */
export const draftMessageTool: ToolSchema = {
  type: "function",
  function: {
    name: "draft_message",
    description:
      "起草或「发送」一条消息（学习用假工具，不会真的外发）。" +
      "适用：用户明确要求起草/发送一条消息、通知、提醒文案。" +
      "不要用本工具查天气或时间。",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "收件人或对象，例如「同事小王」「群公告」",
        },
        body: {
          type: "string",
          description: "消息正文",
        },
      },
      required: ["to", "body"],
    },
  },
};
