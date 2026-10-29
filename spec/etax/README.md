# e-Tax の XSD

国税庁が e-Tax のソフトウェア開発者向けに公開している「e-Tax 仕様書」のうち、XML スキーマ（19XMLスキーマ）から、domble が使う手続に要るファイルだけを置いています。手を加えていません。

- 入手元：e-Tax ソフトウェア開発者向け仕様書（e-tax.nta.go.jp）。令和8年（2026年）10月時点のもの
- 消費税：`shohi/RSH0010-<版>.xsd`（消費税及び地方消費税申告(一般・個人)）・`shohi/RSH0030-<版>.xsd`（同(簡易課税・個人)）と、それが読み込むファイル（`general/`・`somu/`）
  - 23.2.0（`-232.xsd`）：令和5年10月1日以後終了の課税期間用（e-Taxソフトの消費税モジュール 232）。令和7年分・令和8年分。国税庁は「個人事業者の方の令和８年分申告においては、【令和８年９月30日以前に開始した課税期間用】をご利用ください」としている（消費税の申告書の様式のページ）
  - 26.0.0（`-260.xsd`）：令和8年10月1日以後開始の課税期間用（モジュール 260。e-Tax のダウンロード一覧で確かめた）。個人事業者は令和9年分から
  - 2つの版が読み込む様式（SHA010-010・SHA020-009 と付表）は同じで、版の番号と日付だけが違う。年分と版の対応は `src/lib/taxXtx.ts` の `XTX_VERSIONS`
- 所得税：`shotoku/RKO0010-250.xsd`（所得税及び復興特別所得税申告。令和7年分の版 25.0.x）と、それが読み込むファイル（`shotoku/` の様式・`kyotsu/`・`general/`）
  - domble が書くのは申告書 `shotoku/KOA020-023.xsd`（第一表・第二表と、損失申告の年は第四表（一）（二））と、青色申告決算書（一般用）`shotoku/KOA210-011.xsd` または収支内訳書（一般用）`shotoku/KOA110-012.xsd`（白色申告の年）。手続の XSD がほかの様式もすべて読み込むので、検証のために一式を置いている
  - 年分と版の対応は `src/lib/incomeTaxXtx.ts` の `INCOME_XTX_VERSIONS`。欄の書き方（区分の値・書式）は国税庁の「XML構造設計書及び帳票フィールド仕様書【所得税関係】」（e-tax09.CAB）で確かめた（リポジトリには入れていない）

使い道

- テスト（`src/lib/taxXtx.test.ts`・`src/lib/incomeTaxXtx.test.ts`、続け通しのスクリプト）：書き出した xtx を `xmllint --schema` で検証する
- `scripts/etax_forms.py`：様式の項目の並び（`src/lib/etaxForms.ts`）と税務署の一覧（`src/constants/taxOffices.ts`）を作る
- `coverage.md`：手続の様式ごとの、domble の対応と優先度（対応表）。一覧は `python3 -I scripts/etax_procedure_forms.py <手続の XSD>` で出せる

新しい年分の版が出たら、手続の XSD を足し（前の年分の版は残す）、`XTX_VERSIONS` に年分と版を足して、様式が変わっていれば `python3 -I scripts/etax_forms.py` を動かし、テストで確かめます。様式の増減は `scripts/etax_procedure_forms.py` で見て、`coverage.md` を直します。
