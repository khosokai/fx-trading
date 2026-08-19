-- FX自動売買ボット 初期スキーマ
--
-- 設計判断:
-- - safety_state は key-value 行構造 (単一JSONブロブ禁止)。killSwitch /
--   daily基準 / lastTransactionId を独立にUPDATEし、書き込み競合を構造的に排除
-- - oanda_transactions は transaction id を主キーとする生台帳。
--   INSERT OR IGNORE で取り込みが冪等になり、並行tickでも二重計上されない
-- - decisions の UNIQUE(strategy_id, instrument, bar_time) がバーゲート:
--   cron重複発火時の同一バー二重処理をDB制約で無効化する
-- - monthly_volume テーブルは持たない (台帳からのSUMで導出。加算カウンタは
--   並行tickで二重加算されうるため)
-- - ハードリミット (リスク上限等) はここに置かない。環境変数/コード定数のみ

CREATE TABLE safety_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- GUI編集可能な戦略パラメータ (安全限界は含めない)
CREATE TABLE params (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE params_history (
  version INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT
);

-- 戦略判定ログ。行動の有無に関わらず全判定を記録する (パリティ検証の元データ)
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  bar_time INTEGER NOT NULL,
  close_bid REAL,
  close_ask REAL,
  position INTEGER NOT NULL,
  target INTEGER NOT NULL,
  action TEXT NOT NULL,         -- none | open | close | reverse
  sl_pips REAL,
  tp_pips REAL,
  status TEXT NOT NULL,         -- ok | blocked | error | dry_run
  reason TEXT,
  param_version INTEGER,
  live INTEGER NOT NULL,
  UNIQUE (strategy_id, instrument, bar_time)
);
CREATE INDEX idx_decisions_ts ON decisions (ts);

-- OANDA transaction 生台帳 (冪等取り込み)
CREATE TABLE oanda_transactions (
  id INTEGER PRIMARY KEY,        -- OANDAのtransaction id
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  instrument TEXT,
  units REAL,
  price REAL,
  pl REAL,
  financing REAL,
  reason TEXT,
  -- unknown intentの解決は揮発的なレスポンスではなく、この永続カラムに対して行う
  -- (カーソル前進後にWorkerが死んでも誤orphan判定にならない)
  client_order_id TEXT,
  raw TEXT NOT NULL
);
CREATE INDEX idx_txn_ts ON oanda_transactions (ts);
CREATE INDEX idx_txn_type ON oanda_transactions (type);
CREATE INDEX idx_txn_client_order ON oanda_transactions (client_order_id);

-- 発注インテント。POSTの「前」に必ずINSERTする (二重発注対策の要)
CREATE TABLE orders_intent (
  client_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  instrument TEXT NOT NULL,
  units INTEGER NOT NULL,
  sl_distance_pips REAL,
  tp_price REAL,
  decision_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','created','filled','rejected','unknown','orphaned')),
  oanda_order_id TEXT,
  oanda_txn_id TEXT,
  resolved_at TEXT
);
CREATE INDEX idx_intent_status ON orders_intent (status);

-- 損益単位のトレード (台帳から導出。oanda_trade_id で冪等)
CREATE TABLE trades (
  oanda_trade_id TEXT PRIMARY KEY,
  instrument TEXT NOT NULL,
  units REAL NOT NULL,
  entry_ts TEXT,
  entry_price REAL,
  exit_ts TEXT,
  exit_price REAL,
  pl_jpy REAL,
  financing_jpy REAL NOT NULL DEFAULT 0,
  strategy_id TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed'))
);
CREATE INDEX idx_trades_state ON trades (state);

CREATE TABLE equity_snapshots (
  ts TEXT PRIMARY KEY,
  nav REAL NOT NULL,
  balance REAL,
  margin_used REAL,
  unrealized_pl REAL,
  spread_pips REAL,
  open_units REAL
);
