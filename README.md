# europe_962
ハプスブルク帝国の興亡（会議は踊る、されど進まず ）欧州版歴史シミュレーション

## ドキュメント

- 世界観・戦闘・勢力のコンセプト: [`gamesystem_europe.md`](./gamesystem_europe.md)
- ゲームシステム概要設計（UI／処理）: [`docs/gamesystem_design.md`](./docs/gamesystem_design.md)
- UIモックアップ（静的デザインキャンバス）: [`design/ui-mockup/`](./design/ui-mockup/)（[公開キャンバス](https://claude.ai/code/artifact/77f25624-c076-4af6-92d7-ca321893b909)）

## データモデル・ゲームエンジン（TypeScript実装）

`src/` に、概要設計書のデータモデル（Region / Faction / Army / Character /
Captivity / GameState）と、大戦判定・戦闘解決・継承・捕虜/人質・AI意思決定・経済・
史実イベント・ターン進行の各エンジンを実装している。`advanceYear()` でサンプル初期
データを実際に1年ずつ進められる（AIは外交・行動フェイズにはまだ未接続、詳細は
`docs/gamesystem_design.md` 9章・12章）。

```
src/
  models/     # Region, Faction, Army, Character, Captivity, GameState, Policy,
              # RegionArchetype などの型定義
  engine/
    warCheck.ts          # 大戦判定（実装済み）
    combatEngine.ts      # 戦闘解決（史実シナリオで検証済み。係数は継続チューニング対象）
    causalityGuard.ts    # 因果律の保護（史実の転換点を演算の外側から補正する最終手段）
    kinship.ts            # 親等計算（血族ネットワークのBFS距離、実装済み）
    succession.ts          # 継承・養子縁組・後継者危機/内乱（係数は継続チューニング対象）
    captivity.ts            # 捕虜・人質・身代金・併合/傀儡化の強制（同上）
    aiPolicy.ts               # AI意思決定：点数判断（Policy別の重み付けスコアリング、実装済み）
    aiProvider.ts              # AI意思決定：生成AI丸投げ（OpenAI互換API、失敗時は点数判断へ自動フォールバック）
    economy.ts                  # 経済：地勢アーキタイプ別の税率・天候（正規分布）・戦争/疫病補正
    eventEngine.ts                # 史実イベント年表の適用（データは data/historicalEvents.ts）
    turnEngine.ts                  # 5フェイズのターン進行（TurnFSM）を実際に回すオーケストレーション層。
                                    # 多重戦闘・奇襲・挟撃の判定もここに実装
  data/
    initialState.ts   # 962年開始時点のサンプル初期データ
    historicalEvents.ts # 中学校社会科レベルの世界史年表イベント（1054〜1799年）
  utils/      # GameState の参照整合性バリデーション
```

戦闘解決・継承・捕虜/人質・経済の各エンジンは、`combatEngine.historical.test.ts` などの
史実シナリオテストで「劣勢でも定説通りの結果を導けるか」を検証しながら実装したが、
係数そのものは今後も「史実の戦役・王朝史をシナリオ化して再演算し、乖離があれば係数調整、
それでも説明できない事象は演算の外側で強制イベント（因果律の保護、`causalityGuard.ts`）
として補正する」検証プロセスを回しながら調整していく対象。

AI意思決定（`aiPolicy.ts`/`aiProvider.ts`）と経済・史実イベントのエンジン自体は実装済みだが、
`turnEngine.ts` の外交・行動フェイズはまだそれらを呼び出さないスタブ（次の実装対象）。
生成AI丸投げ方式は既定でOpenAI API（`OPENAI_API_KEY` 環境変数、モデルは `gpt-4o`）を使い、
`AIProviderConfig` で任意のOpenAI互換エンドポイント／キー／モデルに差し替えられる。

### セットアップ・実行

```bash
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト（vitest、史実シナリオ検証を含む）
npm run build       # dist/ にビルド
```

