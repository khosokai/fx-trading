# アーキテクチャ

OANDA v20 REST API による FX 自動デイトレードシステム。
TypeScript一本・ランタイム依存ゼロ・ビルドレス (Node 24 型ストリッピング)。
本番は Cloudflare Workers (Cron + D1 + Static Assets)。姉妹プロジェクト
`~/dev/gmo-coin` の実証済み設計を土台に、FX特有の拡張を加えている。

## パリティ原則 (最重要)

**バックテストと本番は同一の `Strategy.decide()` を実行する。**

- 戦略は `src/core/strategy.ts` の契約 (`decide(ctx) → {target: -1|0|1, stopLossPips, ...}`) のみに依存する
- 本番もバックテストも **M1足を共通の `src/core/aggregate.ts` で上位足に集計**する。
  プロバイダ側の足の切り方の差異をパリティ検証から排除するため
- `src/examples/verifyParity.ts` が本番の判定ログを同じ足で再計算し全件照合する

## レイヤ構成

```
src/core/       時刻・pips・セッション・インジケータ・Strategy契約 (環境非依存)
src/backtest/   エンジン・メトリクス・WFA・レポート
src/strategies/ 戦略実装 (donchian / sessionBreakout / bbRsi)
src/oanda/      v20 APIクライアント (fetch薄ラッパー、手書き型)
src/safety/     ハードリミット・キルスイッチ・監視・通知 (戦略の外側)
src/live/       tradingBot (tickシーケンス)・ports (DB抽象)・paramsレジストリ
src/data/       Dukascopy取込・月次gzipチャンクストア
worker/         Workersエントリ・D1実装 (StateStore/BotDb)・管理API
admin/public/   管理画面 (vanilla JS + uPlot、ビルドレス)
```

## 時刻の規律 (DST)

NYロールオーバー(17:00 America/New_York)・週末境界・セッションはすべて
**IANAタイムゾーン** (`src/core/sessions.ts`) で計算する。UTC固定オフセットは禁止
(3月/11月のDST切替でバックテストが半年分歪む)。取引日キーは NY17:00 区切り。

## ライブtickシーケンス (毎分cron)

1. キルスイッチ確認 (D1、強整合)
2. 週末クローズ確認
3. **transaction照合** — `transactions/sinceid` で台帳取り込み + unknown intent解決。
   **新規発注の検討より必ず先に行う** (前回POSTが結果不明で終わった場合の回復パス)
4. M1取得 (`price=BA`, 確定足のみ) → 共通aggregateで戦略時間軸へ
5. **バーゲート**: `decisions` の UNIQUE(strategy_id, instrument, bar_time) への
   INSERT が弾かれたらこのバーは処理済み → no-op
6. ポジションは毎回 OANDA `openPositions` から導出 (プロセス内状態に依存しない)
7. `strategy.decide()` — 判定は行動の有無に関わらず記録 (パリティ検証の元データ)
8. RiskManager ハードリミット (POST直前のキルスイッチ再チェック込み)
9. 発注: **intentをPOSTの前にINSERT** → MARKET + `stopLossOnFill`(distance) +
   `takeProfitOnFill` → 結果でintent更新
10. equity snapshot 記録 + healthchecks.io ping

### 「判定が1分遅れる」のは正常系

cronの発火と足の確定は競合する。足がまだ確定していないtickでは前の足の
バーゲートに弾かれてno-opになり、**次のtickで新しい足を処理する**。
判定ログ上で1分遅れて見えるのは仕様であり異常ではない。

### 死亡セマンティクス

`decisions INSERT (ゲート) → intent INSERT → POST` の順序により、途中で
Workerが死んだ場合は常に**機会損失側**に倒れる (二重発注は構造的に起きない)。
「decisionあり・intentなし」のサイレントスキップは管理画面が検出して表示する。

## 二重発注の防止 (OANDAに冪等性がないため)

- OANDAの成行注文にサーバー側の冪等性保証は**ない** (`clientExtensions.id` の
  重複拒否は注文がpendingの間のみ。成行は即約定するため効かない)
- → `src/httpClient.ts`: **POSTのネットワーク断/タイムアウトは絶対にリトライしない**
  (回帰テストあり)。結果不明のintentは `unknown` とし、次tickの照合で解決する
- 台帳 (`oanda_transactions`) は transaction id 主キー + INSERT OR IGNORE で
  取り込みが冪等 → 並行tickでも二重計上されない
- `stopLossOnFill` は必須 (エンジン/発注層が強制)。Workerが死んでも
  サーバー側SLが最大エクスポージャを守る

## バー内SL/TPの保守的ルール (バックテスト)

① 判定はエグジット側価格 (ロング→Bid足)
② 窓開けで始値がSLを超えていれば始値で約定 (+SLスリッページ)
③ 同一バーでSL/TP両方タッチ → SL約定 (最悪ケース)
④ TPは指値どおり。SLには不利スリッページ (デフォルト0.3pips) を標準上乗せ

変更するときは `test/engine.test.ts` と本節を必ず同時に更新する。

## 状態管理

- `safety_state` は **key-value行** (killSwitch / daily / peakEquity /
  orderTimestamps / supervisor / lastTransactionId を独立UPDATE)。
  単一JSONブロブのload-modify-saveは禁止 (gmo-coinで書き込み競合の原因になった)
- D1を使う理由: 強整合でキルスイッチが即時反映される (KVは伝播に最大60秒)

## 安全限界とパラメータの分離

- **ハードリミット** (`src/safety/config.ts`): 環境変数のみ。GUI/D1から変更不可。
  1注文上限 / 総units上限 / riskPct上限 / 証拠金使用率 / 日次損失% / 最大DD% /
  発注頻度 / 価格乖離 / スプレッドガード / ロールオーバーブラックアウト
- **戦略パラメータ** (D1 `params`): GUIで編集可。保存でversion+1、
  **次tickから新規エントリーのみ**に適用 (既存ポジションのSL/TPに遡及しない)。
  保存時に `src/live/paramsRegistry.ts` のスキーマ+範囲バリデーションを通す

## 管理画面

Workers Static Assets + vanilla JS + uPlot (ベンダリング済み)。認証は
Cloudflare Access を前提とし、変更系APIはAccessのJWTヘッダ (または
フォールバックの `ADMIN_TOKEN`) を要求する。判定は `worker/api.ts` の
`requireAuth` 1関数に隔離。**live開始後はGUI改修を凍結する** (運用ルール)。

## Goldステータス取引量

月間取引量は台帳からのSUMで導出 (`/api/volume`)。加算カウンタは持たない
(並行tickで二重加算されうるため)。**ゲージは監視専用** — サイズ・頻度を
目標駆動で上げるトリガーにしない。
