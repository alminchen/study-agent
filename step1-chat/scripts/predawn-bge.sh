#!/usr/bin/env bash
# 预下载 Xenova/bge-large-zh-v1.5（BGE large-zh 的 ONNX 版，供 @huggingface/transformers 使用）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/models/Xenova/bge-large-zh-v1.5"
BASE="https://huggingface.co/Xenova/bge-large-zh-v1.5/resolve/main"

mkdir -p "$DEST/onnx"

download() {
  local rel="$1"
  local out="$DEST/$rel"
  if [[ -f "$out" && -s "$out" ]]; then
    echo "skip (exists): $rel"
    return
  fi
  echo "downloading: $rel"
  mkdir -p "$(dirname "$out")"
  curl -L --fail --retry 3 --retry-delay 2 -o "$out" "$BASE/$rel"
}

# 小文件
download "config.json"
download "tokenizer.json"
download "tokenizer_config.json"
download "special_tokens_map.json"
download "vocab.txt"
download "quantize_config.json"

# 量化版约 312MB，足够阶段 3 学习；完整 fp32 model.onnx 约 1.3GB
download "onnx/model_quantized.onnx"

# 如需完整精度，取消下一行注释
# download "onnx/model.onnx"

echo ""
echo "Done. Files in: $DEST"
du -sh "$DEST" "$DEST/onnx"/* 2>/dev/null || true
