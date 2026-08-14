#!/usr/bin/env bash
# 预下载 Xenova/bge-reranker-base（交叉编码器，供召回后重排）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/models/Xenova/bge-reranker-base"
BASE="https://huggingface.co/Xenova/bge-reranker-base/resolve/main"

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

download "config.json"
download "tokenizer.json"
download "tokenizer_config.json"
download "special_tokens_map.json"
download "sentencepiece.bpe.model"
download "quantize_config.json"
# 量化版约 279MB
download "onnx/model_quantized.onnx"

echo ""
echo "Done. Files in: $DEST"
du -sh "$DEST" "$DEST/onnx"/* 2>/dev/null || true
