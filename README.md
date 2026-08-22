# europe_962
ハプスブルク帝国の興亡（会議は踊る、されど進まず ）欧州版歴史シミュレーション

## ドキュメント

- 世界観・戦闘・勢力のコンセプト: [`gamesystem_europe.md`](./gamesystem_europe.md)
- ゲームシステム概要設計（UI／処理）: [`docs/gamesystem_design.md`](./docs/gamesystem_design.md)
- UIモックアップ（静的デザインキャンバス）: [`design/ui-mockup/`](./design/ui-mockup/)（[公開キャンバス](https://claude.ai/code/artifact/77f25624-c076-4af6-92d7-ca321893b909)）

## データモデル・ゲームエンジン（TypeScript実装）

`src/` に、概要設計書のデータモデル（Region / Faction / Army / Character /
Captivity / GameState）と、大戦判定・戦闘解決・継承・捕虜/人質・ターン進行の
各エンジンを実装している。`advanceYear()` でサンプル初期データを実際に1年ずつ
進められる（AIの意思決定はまだスタブ、詳細は `docs/gamesystem_design.md` 9章）。

```
src/
  models/     # Region, Faction, Army, Character, Captivity, GameState などの型定義
  engine/
    warCheck.ts        # 大戦判定（実装済み）
    combatEngine.ts    # 戦闘解決（史実シナリオで検証済み。係数は継続チューニング対象）
    causalityGuard.ts  # 因果律の保護（史実の転換点を演算の外側から補正する最終手段）
    kinship.ts          # 親等計算（血族ネットワークのBFS距離、実装済み）
    succession.ts        # 継承・養子縁組・後継者危機/内乱（係数は継続チューニング対象）
    captivity.ts          # 捕虜・人質・身代金・併合/傀儡化の強制（同上）
    turnEngine.ts          # 5フェイズのターン進行（TurnFSM）を実際に回すオーケストレーション層
  data/       # 962年開始時点のサンプル初期データ
  utils/      # GameState の参照整合性バリデーション
```

戦闘解決・継承・捕虜/人質の各エンジンは、`combatEngine.historical.test.ts` などの
史実シナリオテストで「劣勢でも定説通りの結果を導けるか」を検証しながら実装したが、
係数そのものは今後も「史実の戦役・王朝史をシナリオ化して再演算し、乖離があれば係数調整、
それでも説明できない事象は演算の外側で強制イベント（因果律の保護、`causalityGuard.ts`）
として補正する」検証プロセスを回しながら調整していく対象。

外交フェイズ・行動フェイズ（AIの宣戦・同盟・軍配置などの意思決定）は `turnEngine.ts` 上は
まだフェイズを進めるだけのスタブで、次の実装対象。

### セットアップ・実行

```bash
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト（vitest、史実シナリオ検証を含む）
npm run build       # dist/ にビルド
```

