# UIモックアップ（静的デザインキャンバス）

`docs/gamesystem_design.md` の UI設計（5.1 画面構成）を、中世羊皮紙・古地図調のビジュアルで
静的モックアップ化したもの。実装コードではなく見た目確認用。

**公開キャンバス:** https://claude.ai/code/artifact/77f25624-c076-4af6-92d7-ca321893b909

## 収録アートボード

| ファイル | 対応する設計書の画面 |
|---|---|
| `Main.dc.html` | ①マップ画面 ＋ ②州詳細パネル ＋ ⑨大戦ゲージ（州選択状態） |
| `ArmyPanel.dc.html` | ③軍団パネル（軍団選択・移動/攻撃指示） |
| `Court.dc.html` | ④宮廷画面（家系図・宰相/戦闘隊長・人材登用） |
| `Diplomacy.dc.html` | ⑤外交画面（関係一覧・条約コマンド） |
| `Mercenary.dc.html` | ⑥傭兵市場 |
| `BattleLog.dc.html` | ⑦戦闘結果ログ（占領／退却／降伏の3類型） |
| `TurnSummary.dc.html` | ⑧ターンサマリー（年始イベント） |

`canvas.json` が上記アートボードのキャンバス配置を定義する。

## 元データとの対応

マップの州・隣接関係・勢力配色は `src/data/initialState.ts`（962年開始データ）と一致させている
（ザクセン／バイエルン／シュヴァーベン／西フランク／ブルゴーニュ／教皇領／東ローマの7州、
神聖ローマ帝国／西フランク王国／教皇領／東ローマ帝国／自由傭兵団の5勢力）。

## 更新方法

各 `.dc.html` を編集した後、以下でキャンバスを再生成できる（`<skill base dir>` は
`design` スキル起動時に表示されるパス）。生成物 `europe-962-ui-mockup.html` は
サイズが大きいためリポジトリには含めていない（`.gitignore` 参照）。

```bash
node "<skill base dir>/seed-canvas.mjs" \
  --template "<skill base dir>/payload.template.html" \
  --out europe-962-ui-mockup.html \
  --title "会議は踊る、されど進まず UIモックアップ" \
  --artboard Main.dc.html --artboard ArmyPanel.dc.html --artboard Court.dc.html \
  --artboard Diplomacy.dc.html --artboard Mercenary.dc.html --artboard BattleLog.dc.html \
  --artboard TurnSummary.dc.html \
  --canvas canvas.json
```
