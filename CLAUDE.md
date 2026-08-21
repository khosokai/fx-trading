# fx-trading

OANDA v20 API による FX 自動デイトレードシステム。TypeScript一本・ランタイム依存ゼロ・
ビルドレス (Node 24 型ストリッピングで `.ts` を直接実行)。本番は Cloudflare Workers。
姉妹プロジェクト `~/dev/gmo-coin` の実証済み設計が土台。

## コマンド

- `npm run typecheck` / `npm test` — 常にgreenを保つ (エンジン/セッション/クライアントの回帰テスト)
- `npm run data:download` — Dukascopy M1 Bid/Ask取得 (USD_JPY, EUR_USD)。
  429で止まる場合は `scripts/downloadDukascopyRaw.ts` (生datafeed直読みフォールバック、
  整合検証済み。経緯は docs/research.md 2026-08-21)
- `npm run backtest` / `npm run research` — バックテスト / WFA+採択判定
- `npm run worker:dev` — ローカルWorker (`curl "localhost:8787/__scheduled?cron=*+*+*+*+*"` でcron発火)

## 絶対に守る規則

1. **POSTのネットワーク断/タイムアウトはリトライしない** (`src/httpClient.ts`)。
   OANDAの成行注文に冪等性はなく、リトライ=二重発注リスク。回復は次tickの
   `transactions/sinceid` 照合のみ。回帰テストあり (`test/httpClient.test.ts`)
2. **時刻計算はIANAタイムゾーン** (`src/core/sessions.ts`)。UTC固定オフセット禁止 (DSTバグ)
3. **safety_state はkey-value行の独立UPDATE**。単一JSONブロブのload-modify-save禁止
4. **ハードリミット (SAFETY_*) は環境変数のみ**。D1 params/GUIから変更可能にしない
5. **バー内SL/TPルール** (エンジン§保守的ルール) を変えるときは
   `test/engine.test.ts` と `docs/architecture.md` を必ず同時更新
6. **戦略はバックテストと本番で同一の `decide()`** (パリティ原則)。
   上位足は必ず `src/core/aggregate.ts` でM1から集計
7. **研究の規律** (`docs/research.md`): 採択基準は事前固定・両ペアWFA必須・
   スプレッド感度で棄却・全戦略不採択ならlive見送り (締切より基準)
8. **認証はfail-closed** (`worker/api.ts` requireAuth): ADMIN_TOKEN一致のみが認証。
   ヘッダの「存在」を認証に使わない (Cf-Access-Jwt-Assertionは偽装可能。
   Access移行はJWT署名検証の実装が前提)
9. **unknown intentの解決は永続台帳 (client_order_id) に対して行う**。
   揮発的なAPIレスポンスで orphan 判定しない (誤「未達」通知の回帰テストあり)
10. **htfを使う戦略を追加する前に必ず**: 本番tickは現在 `htf: {}` を渡している
   (tradingBot)。Strategyに必要HTFを宣言させて本番でaggregateClosedから構築するか、
   宣言があるのに空なら大声で失敗する仕掛けを先に入れること
   (バックテストでは見えて本番では静かに空になるパリティ地雷)

## 構成の要点

- `src/` はNode/Workers両対応 (fsは動的import、`node:fs`直importはNode専用ファイルのみ)
- worker/ 用の型チェックは `tsc -p worker` (workers-types混在。`Buffer.toString("utf8")` は
  引数なし `.toString()` にする — 型衝突回避)
- 管理画面 `admin/public/` はビルドレスvanilla JS + ベンダリング済みuPlot
- D1マイグレーション: `wrangler d1 migrations apply fx-trading-bot --local|--remote`
- 詳細は `docs/architecture.md` (設計) / `docs/operations.md` (運用・昇格チェックリスト)

## 現況・スケジュール

計画ファイル: `~/.claude/plans/fx-api-oanda-api-api-2026-9-frolicking-grove.md`
2026/9 にOANDA本番口座開設予定 (初期緩和 = 開設月〜翌月末Gold付与)。
それまでに戦略研究 (Phase 3) を完了し、開設後にfxpracticeで14日チェックリスト
(`docs/operations.md`) → 10月からlive想定。

OANDA JP確認済み (2026-08-20): 口座開設前のfxpractice API接続は不可 (前倒し不能)。
API維持には**毎月50万USDの実取引が必須** (Gold喪失で本番・デモともトークン無効化
= Bot完全停止)。詳細は `docs/operations.md` のGoldステータス維持セクション。
