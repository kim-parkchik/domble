#!/bin/sh
# 分野 F（一年分の続け通し）のスクリプトをまとめて流す。結果は一時フォルダの out_*.txt に残り、そのフォルダを最後に表示する
# 使い方（リポジトリの直下で）：sh spec/audit/scenarios/run_all.sh
cd "$(dirname "$0")" || exit 1
OUT="$(mktemp -d)"
for s in s1_designer s2_retail s3_restaurant s4_r7_rules; do
  bun "$s.ts" > "$OUT/out_$s.txt" 2>&1 || echo "失敗：$s"
  grep "（一致" "$OUT/out_$s.txt" | sed "s/^/$s: /"
done
echo "結果：$OUT"
