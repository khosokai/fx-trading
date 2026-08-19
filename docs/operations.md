# 運用手順

## 環境構築

```sh
npm install
npm run typecheck && npm test          # 常にgreenを保つ

# データ取得 (Dukascopy, 口座不要)
npm run data:download                   # USD_JPY + EUR_USD 2021〜

# バックテスト / 研究
npm run backtest                        # 単発 + スプレッド感度
npm run research                        # WFA両ペア + 採択判定
```

## Cloudflare デプロイ

```sh
# 初回のみ
wrangler d1 create fx-trading-bot       # → database_id を wrangler.jsonc に反映
wrangler d1 migrations apply fx-trading-bot --remote

# Secrets (実キーはローカルに置かない。.dev.varsはローカルdev専用)
wrangler secret put OANDA_API_TOKEN
wrangler secret put OANDA_ACCOUNT_ID
wrangler secret put NOTIFY_WEBHOOK_URL
wrangler secret put HEALTHCHECK_URL_BOT
wrangler secret put HEALTHCHECK_URL_SUPERVISOR
wrangler secret put ADMIN_TOKEN         # Cloudflare Access設定までのフォールバック

npm run worker:deploy
```

- **Workers Paidプランが必須** (無料プランはCronのCPU 10msのみ)
- 管理画面は workers.dev URL。Cloudflare Access (Zero Trust) で `/*` を保護する
- ローカル検証: `npm run worker:dev` → `curl "localhost:8787/__scheduled?cron=*+*+*+*+*"`

## OANDAトークンの扱い

OANDAのパーソナルアクセストークンには**権限スコープの分離がない**
(参照のみ/発注のみを分けられない)。Cloudflare Accessとトークン管理が
防衛線のすべて。

- 発行: My fxTrade → API Access Management (NYサーバー・プロコース必須)
- **失効・再発行手順**: 漏洩を疑ったら (1) My fxTradeで即時失効 (2) 新トークン発行
  (3) `wrangler secret put OANDA_API_TOKEN` で差し替え (4) `wrangler deploy` 不要
  (Secretsは即時反映) (5) 判定ログで次tickの正常動作を確認
- 口座残高が25万円を下回るとトークンが無効化される点に注意

## パラメータ変更

管理画面 → パラメータ。保存で新version、**次tickから新規エントリーのみ**適用。
安全限界 (SAFETY_*) は環境変数のみ: 変更は `wrangler.jsonc` のvars (公開可能なもの)
または dashboard の環境変数で行い、mainへのpush/デプロイで反映する。

## キルスイッチ

- 発動: 管理画面 (KILL入力) / supervisorの自動発動 (日次損失・最大DD超過)
- 発動時: 取引ロック永続化 → 全注文キャンセル → (SAFETY_FLATTEN_ON_KILL=true なら)
  全ポジションクローズ。**サーバー側SL/TPは残る**
- 解除: 管理画面のRESETのみ (人間の明示操作)。解除前に OANDA の建玉と
  `unknown` intent が残っていないことを確認する

## デッドマンスイッチ (healthchecks.io)

- bot: Period 1分 / Grace 5分。supervisor: Period 5分 / Grace 15分
- botはtickがエラーなしで完走したときだけping (エラー多発時は沈黙してアラート)

## BOT_LIVE 昇格チェックリスト (事前固定 — 検証期間中に基準を動かさない)

fxpractice で `BOT_LIVE=true` にした日から **14日間** で以下全達成が条件:

- [ ] 判定ログにバー欠落ゼロ (decisionsページで確認。1分遅れは正常系)
- [ ] supervisor の連続失敗警告ゼロ
- [ ] `npm run verify:parity` 全件一致
- [ ] デッドマンスイッチの発報テスト実施 (cronを一時停止して検知を確認)
- [ ] キルスイッチ 発動→解除→(flatten時)全クローズ のリハーサル実施
- [ ] `unknown` intent の回復を実地確認 (制御された条件で疑似ネットワーク断を発生させる)
- [ ] スプレッドガードがロールオーバー帯で発注拒否するのを観測
- [ ] `npm run compare:feeds` でOANDA実スプレッドを確認し、
      バックテストのspreadMarkupに反映した上で採択戦略が基準を維持している

達成後: `OANDA_ENV=live` + 最小サイズで開始。**live開始後はGUI改修を凍結**。

## Gold ステータス維持 — API利用権の生命線 (2026-08-20 OANDA JP確認済み)

- **取引量カウント**: 新規+決済の両方が合算 (1万通貨×25往復/月 = 50万USD)。
  非USDペアは約定時レートでUSD換算。**デモ取引はカウント外**。
  当システムの `/api/volume` (ORDER_FILLごとの|units|USD換算SUM) は同じ数え方
- **降格判定**: 毎月3日頃に前月分を判定。降格すると**APIトークンは本番・デモとも
  即無効化 (401) → Bot完全停止**。デモ口座もロック (60日でデータ削除)。
  昇格は毎営業日判定で、達成の翌日〜翌々日に復帰できる
- **口座開設前のfxpractice API接続は不可** (デモAPIトークンはGold会員のみ発行可)。
  フォワードテストは口座開設後の緩和期間 (開設月〜翌月末Gold) 内に行う
- **残高維持だけではAPI継続不可** — 毎月50万USDの実取引が必須。
  「取引せずデータ収集だけ」の運用は緩和期間中しか成立しない
- 運用対応 (実装済み):
  - supervisorが**毎月20日以降、期待進捗の80%未満で1日1回警告** (BOT_LIVE時のみ)
  - **401検知で即時緊急通知** (Botは停止状態。ポジションはサーバー側SL/TP頼みに
    なるため、OANDAの取引画面で直接確認・管理する)
  - Bot停止月などの月末ノルマ消化は**人間が判断して手動実施**
    (コスト目安: 1万通貨25往復 × スプレッド0.4pips ≈ 1,000円)。
    ゲージ・警告は情報提供のみで、自動発注のトリガーにはしない

## 定期メンテナンス

- 月次: decisions / equity_snapshots の古い行をプルーニング
  (`wrangler d1 execute fx-trading-bot --remote --command "DELETE FROM decisions WHERE ts < datetime('now','-6 months')"`)
- 月初3日頃: Gold判定の結果を確認 (取引量ゲージと突き合わせ)
- 入出金後: 日次損失基準がずれるため `safety_state` の daily/peakEquity を手動リセット
