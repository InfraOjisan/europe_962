# europe_962
ハプスブルク帝国の興亡（会議は踊る、されど進まず ）欧州版歴史シミュレーション

## ドキュメント

- 世界観・戦闘・勢力のコンセプト: [`gamesystem_europe.md`](./gamesystem_europe.md)
- ゲームシステム概要設計（UI／処理）: [`docs/gamesystem_design.md`](./docs/gamesystem_design.md)
- UIモックアップ（静的デザインキャンバス）: [`design/ui-mockup/`](./design/ui-mockup/)（[公開キャンバス](https://claude.ai/code/artifact/77f25624-c076-4af6-92d7-ca321893b909)）

## データモデル（TypeScript実装）

`src/` に、概要設計書のデータモデル（Region / Faction / Army / Character /
Captivity / GameState）と、大戦判定・戦闘解決・継承・捕虜/人質エンジンの一次実装を置いている。

```
src/
  models/     # Region, Faction, Army, Character, Captivity, GameState などの型定義
  engine/
    warCheck.ts      # 大戦判定（実装済み）
    combatEngine.ts  # 戦闘解決（草案/未バランス調整）
    kinship.ts        # 親等計算（血族ネットワークのBFS距離、実装済み）
    succession.ts      # 継承・養子縁組・後継者危機/内乱（草案/未バランス調整）
    captivity.ts        # 捕虜・人質・身代金・併合/傀儡化の強制（草案/未バランス調整）
  data/       # 962年開始時点のサンプル初期データ
  utils/      # GameState の参照整合性バリデーション
```

戦闘解決・継承・捕虜/人質の各エンジンは型・構造のみ確定させた草案で、係数や閾値は
今後「史実の戦役・王朝史をシナリオ化して再演算し、乖離があれば係数調整、それでも
説明できない事象は演算の外側で強制イベント（因果律の保護）として補正する」検証
プロセスを回しながら調整していく。

### セットアップ・実行

```bash
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト（vitest）
npm run build       # dist/ にビルド
```

