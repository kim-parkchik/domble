# e-Tax の XSD

国税庁が e-Tax のソフトウェア開発者向けに公開している「e-Tax 仕様書」のうち、XML スキーマ（19XMLスキーマ）から、domble が使う手続に要るファイルだけを置いています。手を加えていません。

- 入手元：e-Tax ソフトウェア開発者向け仕様書（e-tax.nta.go.jp）。令和8年（2026年）10月時点のもの
- 消費税：`shohi/RSH0010-260.xsd`（消費税及び地方消費税申告(一般・個人)）・`shohi/RSH0030-260.xsd`（同(簡易課税・個人)）と、それが読み込むファイル（`general/`・`somu/`）

使い道

- テスト（`src/lib/taxXtx.test.ts`）：書き出した xtx を `xmllint --schema` で検証する
- `scripts/etax_forms.py`：様式の項目の並び（`src/lib/etaxForms.ts`）と税務署の一覧（`src/constants/taxOffices.ts`）を作る

新しい版が出たら、ファイルを差し替えて `python3 -I scripts/etax_forms.py` を動かし、テストで確かめます（手続の版は `src/lib/taxXtx.ts` の `PROCEDURE_VERSION`）。
