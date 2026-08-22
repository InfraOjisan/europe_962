# europe_962
ハプスブルク帝国の興亡（会議は踊る、されど進まず ）欧州版歴史シミュレーション

## ドキュメント

- 世界観・戦闘・勢力のコンセプト: [`gamesystem_europe.md`](./gamesystem_europe.md)
- ゲームシステム概要設計（UI／処理）: [`docs/gamesystem_design.md`](./docs/gamesystem_design.md)
- UIモックアップ（静的デザインキャンバス）: [`design/ui-mockup/`](./design/ui-mockup/)（[公開キャンバス](https://claude.ai/code/artifact/77f25624-c076-4af6-92d7-ca321893b909)）

## データモデル・ゲームエンジン（TypeScript実装）

`src/` に、概要設計書のデータモデル（Region / Faction / Army / Character /
Captivity / GameState）と、大戦・プレイヤーのゲームオーバー判定・戦闘解決・継承・
捕虜/人質・AI意思決定・経済・史実イベント・版図外勢力・ターン進行の各エンジンを実装している。
`advanceYear()` でサンプル初期データを実際に1年ずつ進められ、外交・行動フェイズも
AI（点数判断、既定）が実際に動かす（詳細は `docs/gamesystem_design.md` 13章）。

```
src/
  models/     # Region, Faction, Army, Character, Captivity, GameState, Policy,
              # RegionArchetype などの型定義
  engine/
    warCheck.ts          # 大戦判定・大戦への近さ（実装済み）
    combatEngine.ts      # 戦闘解決（史実シナリオで検証済み。係数は継続チューニング対象）
    causalityGuard.ts    # 因果律の保護（史実の転換点を演算の外側から補正する最終手段）
    kinship.ts            # 親等計算（血族ネットワークのBFS距離、実装済み）
    succession.ts          # 継承・養子縁組・後継者危機/内乱（係数は継続チューニング対象）
    captivity.ts            # 捕虜・人質・身代金・併合/傀儡化の強制（同上）
    playerGameOver.ts        # プレイヤーのゲームオーバー：降伏/臣従（傍観・再起チャンス）/滅亡（血縁再起）
    offMapThreats.ts          # 版図外勢力（モンゴル・ティムール・オスマン＝ペルシャ）の天災的襲来判定
    aiPolicy.ts                 # AI意思決定：点数判断（Policy別の重み付けスコアリング、実装済み）
    aiProvider.ts                # AI意思決定：生成AI丸投げ（OpenAI互換API、失敗時は点数判断へ自動フォールバック）
    economy.ts                    # 経済：地勢アーキタイプ別の税率・天候（正規分布）・戦争/疫病補正
    eventEngine.ts                  # 史実イベント年表の適用（データは data/historicalEvents.ts）
    turnEngine.ts                    # 5フェイズのターン進行（TurnFSM）を実際に回すオーケストレーション層。
                                      # 外交・行動フェイズのAI接続、多重戦闘・奇襲・挟撃の判定もここに実装
  data/
    initialState.ts   # 962年開始時点のサンプル初期データ
    historicalEvents.ts # 中学校社会科レベルの世界史年表イベント（1054〜1799年）
    offMapThreats.ts    # 版図外勢力の史実データ（マジャール人〜オスマン＝サファヴィー、962〜1639年）
  utils/      # GameState の参照整合性バリデーション
```

戦闘解決・継承・捕虜/人質・経済の各エンジンは、`combatEngine.historical.test.ts` などの
史実シナリオテストで「劣勢でも定説通りの結果を導けるか」を検証しながら実装したが、
係数そのものは今後も「史実の戦役・王朝史をシナリオ化して再演算し、乖離があれば係数調整、
それでも説明できない事象は演算の外側で強制イベント（因果律の保護、`causalityGuard.ts`）
として補正する」検証プロセスを回しながら調整していく対象。

AI意思決定（`aiPolicy.ts`/`aiProvider.ts`）は `turnEngine.ts` の外交・行動フェイズに
接続済み。既定では点数判断（`decideByScoring`、ネットワーク不要・決定的）のみで
全AI勢力（`GameState.playerFactionId` を除く）を動かし、生成AI丸投げ方式は
`runDiplomacyAsync`/`runActionAsync` として同じ選択肢構築ロジックを共有する非同期版で
別途提供する（"major decision" 局面での任意のオプトイン利用を想定。詳細は
`docs/gamesystem_design.md` 13章）。生成AI丸投げ方式は既定でOpenAI API
（`OPENAI_API_KEY` 環境変数、モデルは `gpt-4o`）を使い、`AIProviderConfig` で任意の
OpenAI互換エンドポイント／キー／モデルに差し替えられる。意思決定には常に「大戦への近さ」
（`warCheck.ts` の `greatWarProximity`）を織り込む。

### セットアップ・実行

```bash
npm install
npm run typecheck   # 型チェック
npm test            # ユニットテスト（vitest、史実シナリオ検証を含む）
npm run build       # dist/ にビルド
```

## ローカルPoC（ブラウザで動かして確認する）

`server/` に、`src/` のエンジンをブラウザから触れる最小のローカルサーバーを用意している。
外部公開は意図しておらず（認証・DB無し、GameStateはサーバープロセスのメモリ上に1つだけ）、
**自分のPC上で動作確認する**ための構成。

```
server/
  index.mjs      # 薄いHTTP API（ビルド済み dist/ のエンジンをそのまま呼ぶ）
                 # GET  /api/state            現在のGameStateを返す
                 # POST /api/advance-year     1年進める（{ "useAI": true|false }）
                 # POST /api/reset            962年の初期状態に戻す
                 # POST /api/select-faction   操作勢力を選択/変更（{ "factionId": string|null }。
                 #                            null で観戦のみ＝CPU完全おまかせモードに戻す）
  public/        # 静的フロントエンド（プレーンHTML/CSS/JS、ビルド不要）
                 # design/ui-mockup/ の中世羊皮紙調デザインを踏襲した簡易ビューア
                 # （州カード・勢力一覧・軍団一覧・年表ログ・大戦ゲージ・次の年へボタン・勢力選択モーダル）
```

### 起動手順

```bash
npm install
cp .env.example .env   # 生成AI丸投げ方式を試す場合のみ、OPENAI_API_KEY を .env に記入
npm run poc            # = npm run build && npm run serve
```

`http://localhost:4000` をブラウザで開くと、まず操作勢力の選択モーダルが出る（`GameState.playerFactionId`、
設計書6.2章）。いずれかの勢力を選ぶとその勢力はAIの自動判断（`turnEngine.ts` の
`runDiplomacy`/`runAction`）から除外され、以後CPUが動かさなくなる。「観戦のみで進める」を選ぶか
モーダルを閉じれば、これまでどおり全勢力をCPUが動かす「CPU完全おまかせモード」で進行する
（トップバーの「変更」ボタンでいつでも選び直せる）。

> ⚠️ 現時点ではプレイヤー専用の外交・軍事コマンド（宣戦布告・軍団移動など）は未実装。
> 操作勢力に選んだ勢力は「AIが自動で動かさなくなる」だけで、明示的な指示を出す手段はまだ無い
> （＝何もしなければその勢力は動かない。他の勢力はこれまでどおりAIが動く）。実際のコマンドUIは
> 今後の課題（`docs/gamesystem_design.md` 12章）。

「次の年へ」ボタンでターンが進み、州の領有・勢力の国庫・外交関係・戦争状態などが実際の
エンジン計算に基づいて更新される。「生成AIを使う」をチェックすると `advanceYearAsync`
（生成AI丸投げ、失敗時は自動フォールバック）を使う。`.env` を用意していない場合や
`OPENAI_API_KEY` が空の場合も、自動的に点数判断へフォールバックするため問題なく動作する
（コンソールにその旨のログが出る）。

`PORT` 環境変数でポート番号を変更できる（既定 `4000`）。停止するには起動したターミナルで
Ctrl+Cすればよい。状態はメモリ上のみで永続化しないため、サーバーを再起動すると962年に戻る
（明示的にリセットしたい場合は画面の「初期状態にリセット」ボタン、または `/api/reset` を叩く）。

複数人へ共有できる形でホストしたくなった場合（社内共有・外部公開など）は、認証・レート制限・
永続化（現状はメモリのみでプロセス再起動すると消える）・同時アクセス時の状態競合への対応が
別途必要になる——現状の `server/` はあくまで単独プレイのPoC用。

