import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isVisionCapableModel,
  markVisionUnsupportedModel,
} from "./capability.js";

test("白名单命中：显式配置的模型支持 Vision", () => {
  assert.equal(
    isVisionCapableModel("gpt-5.4-mini", { whitelist: ["gpt-5.4-mini", "gpt-5.6-sol"] }),
    true,
  );
});

test("白名单生效时，未列入的模型不支持 Vision", () => {
  assert.equal(
    isVisionCapableModel("deepseek-chat", { whitelist: ["gpt-5.4-mini"] }),
    false,
  );
});

test("无白名单时走启发式：gpt-4o 命中", () => {
  assert.equal(isVisionCapableModel("gpt-4o"), true);
});

test("无白名单时走启发式：qwen-vl 命中", () => {
  assert.equal(isVisionCapableModel("qwen2.5-vl-7b"), true);
});

test("无白名单时走启发式：deepseek-chat 不命中", () => {
  assert.equal(isVisionCapableModel("deepseek-chat"), false);
});

test("运行期降级：标记后即使启发式命中也不支持", () => {
  markVisionUnsupportedModel("gpt-4o");
  assert.equal(isVisionCapableModel("gpt-4o"), false);
});

test("空模型名不支持 Vision", () => {
  assert.equal(isVisionCapableModel(""), false);
  assert.equal(isVisionCapableModel("   "), false);
});

