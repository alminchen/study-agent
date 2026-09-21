import { applyToolCalls } from "./applyToolCalls.js";
import { requestCompletion } from "./complete.js";
import { createConsecutiveFailureTracker } from "./toolFailure.js";
import type { ProviderMessage, ReactLoopOptions } from "./types.js";

/** 同一条用户问题里，最多问模型几次。防止模型反复要工具、循环停不下来。 */
const MAX_MODEL_TURNS = 5;

/**
 * 备份：手写 for 循环版 ReAct。现网走 `runConversation.ts` 的 LangGraph。
 *
 * 有 tool_calls 则执行并回填，再问；没有则把文字交给页面。
 *
 * 注意：源码里只有一处 `requestCompletion`，但它在 for 循环体内。
 * 每进一轮循环就会调一次；调工具后没有 return，turn+1 后会再问模型。
 *
 * 例：「广州天气，顺便查查几点」
 *   turn 1 → requestCompletion → getWeather → applyToolCalls → 继续循环
 *   turn 2 → requestCompletion → getCurrentTime → applyToolCalls → 继续循环
 *   turn 3 → requestCompletion → 无 tool_calls → onDelta 最终文字 → return
 */
export async function runConversationForLoop(options: ReactLoopOptions, apiKey: string) {
  const messages: ProviderMessage[] = [...options.messages];
  const failures = createConsecutiveFailureTracker();

  for (let turn = 1; turn <= MAX_MODEL_TURNS; turn++) {
    // 每一轮都会问一次模型；messages 里已含上一轮的工具回填时，模型能看到结果。
    const { choice } = await requestCompletion(messages, options, apiKey);
    console.log(`\n=== ${turn}) 模型返回 ===`);
    console.log(JSON.stringify(choice, null, 2));

    const message = choice.message;
    if (!message) {
      options.onDelta("");
      return;
    }

    const toolCalls = message.tool_calls;
    if (!toolCalls?.length) {
      // 模型不再要工具 → 把文字交给页面，return 跳出 for，循环结束。
      const text = message.content ?? "";
      console.log(`\n=== ${turn}) 交给页面的文字 ===`);
      console.log(text);
      options.onDelta(text);
      return;
    }

    if (turn === MAX_MODEL_TURNS) {
      const stopped = "这轮没做完：已达到询问次数上限。";
      console.log(`\n=== ${turn}) ${stopped} ===`);
      options.onDelta(stopped);
      return;
    }

    const assistantRow: ProviderMessage = {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
    };
    if (message.reasoning_content != null) {
      assistantRow.reasoning_content = message.reasoning_content;
    }
    messages.push(assistantRow);
    await applyToolCalls(toolCalls, messages, options.onTrace, turn, failures);
    console.log(`\n=== ${turn}) 回填后的 messages ===`);
    console.log(JSON.stringify(messages, null, 2));
    // 这里没有 return：for 进入下一轮，再次 requestCompletion。
  }
}
