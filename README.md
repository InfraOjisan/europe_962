# europe_962
ハプスブルク帝国の興亡（会議は踊る、されど進まず ）欧州版歴史シミュレーション

## ドキュメント

- 世界観・戦闘・勢力のコンセプト: [`gamesystem_europe.md`](./gamesystem_europe.md)
- ゲームシステム概要設計（UI／処理）: [`docs/gamesystem_design.md`](./docs/gamesystem_design.md)

## データモデル（TypeScript実装）

`src/` に、概要設計書のデータモデル（Region / Faction / Army / Character /
GameState）と、大戦判定・戦闘解決エンジンの一次実装（草案）を置いている。

```
src/
  models/     # Region, Faction, Army, Character, GameState などの型定義
  engine/     # warCheck（大戦判定・実装済み）, combatEngine（戦闘解決・草案/未バランス調整）
  data/       # 962年開始時点のサンプル初期データ
  utils/      # GameState の参照整合性バリデーション
```

戦闘解決エンジン（`src/engine/combatEngine.ts`）は型・構造のみ確定させた草案で、
係数や閾値は今後「史実の戦役をシナリオ化して再演算し、乖離があれば係数調整、
それでも説明できない事象は戦闘演算の外側で強制イベント（因果律の保護）として
補正する」検証プロセスを回しながら調整していく。

### セットアップ・実行

```bash
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト（vitest）
npm run build       # dist/ にビルド
```

