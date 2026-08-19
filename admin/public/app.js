/* FX Bot 管理画面 (vanilla JS, ビルドレス)
 * ハッシュルーティング: #dashboard / #trades / #decisions / #params / #safety
 * 変更系APIはCloudflare Access配下ならそのまま通る。
 * Access未設定 (ローカルdev等) では ADMIN_TOKEN をlocalStorageに置いて送る。
 */

const main = document.getElementById("main");
const ksBanner = document.getElementById("ks-banner");

const token = () => localStorage.getItem("adminToken") ?? "";

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.method === "POST") {
    headers["Content-Type"] = "application/json";
    if (token()) headers["Authorization"] = `Bearer ${token()}`;
  }
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const fmt = (v, digits = 2) =>
  v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString("ja-JP", { maximumFractionDigits: digits }) : String(v);
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function table(headers, rows) {
  return `<table><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.join("")}</table>`;
}

/* ---------- ページ ---------- */

async function dashboard() {
  const [s, volume, equity] = await Promise.all([
    api("/api/summary"),
    api("/api/volume"),
    api("/api/equity"),
  ]);
  updateKsBanner(s.killSwitch);
  const snap = s.latestSnapshot ?? {};
  const thisMonth = new Date().toISOString().slice(0, 7);
  const mv = (volume.months ?? []).find((m) => m.month === thisMonth);
  const usd = mv?.usd_notional ?? 0;
  const pace = goldPace(usd, volume.goldRequirementUsd);

  main.innerHTML = `
    <div class="cards">
      ${card("NAV", snap.nav != null ? `¥${fmt(snap.nav, 0)}` : "—")}
      ${card("証拠金使用", snap.margin_used != null ? `¥${fmt(snap.margin_used, 0)}` : "—")}
      ${card("含み損益", snap.unrealized_pl != null ? `¥${fmt(snap.unrealized_pl, 0)}` : "—", cls(snap.unrealized_pl))}
      ${card("オープントレード", s.openTrades)}
      ${card("未解決intent", s.unresolvedIntents, s.unresolvedIntents > 0 ? "warn" : "")}
      ${card("サイレントスキップ(24h)", s.silentSkips24h, s.silentSkips24h > 0 ? "warn" : "")}
      ${card("パラメータ", `v${s.paramsVersion}`)}
    </div>
    <section>
      <h3>Goldステータス 月間取引量 (${thisMonth})</h3>
      <p>$${fmt(usd, 0)} / $${fmt(volume.goldRequirementUsd, 0)} (${((usd / volume.goldRequirementUsd) * 100).toFixed(1)}%) ${pace}</p>
      <div class="gauge"><div style="width:${Math.min(100, (usd / volume.goldRequirementUsd) * 100)}%"></div></div>
      <p class="muted">⚠️ このゲージは監視専用。取引量を稼ぐためにサイズ・頻度を上げるトリガーにしないこと。</p>
    </section>
    <section><h3>エクイティカーブ (30日)</h3><div id="equity-chart"><p class="muted">データなし</p></div></section>
    <p class="muted">supervisor: ${esc(s.supervisor?.lastStatus ?? "—")}</p>
  `;
  if (equity.length > 1) {
    document.getElementById("equity-chart").innerHTML = "";
    new uPlot(
      {
        width: Math.min(1100, main.clientWidth - 10),
        height: 280,
        series: [{}, { label: "NAV", stroke: "#4a90d9", width: 1.5 }],
        axes: [{}, { size: 80 }],
      },
      [equity.map((p) => Date.parse(p.ts) / 1000), equity.map((p) => p.nav)],
      document.getElementById("equity-chart"),
    );
  }
}

function goldPace(usd, requirement) {
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const expected = (requirement * dayOfMonth) / daysInMonth;
  return usd >= expected ? "✅ ペース達成" : `⏳ ペース比 -$${fmt(expected - usd, 0)}`;
}

function card(label, value, extra = "") {
  return `<div class="card ${extra}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

async function trades() {
  const rows = await api("/api/trades?limit=200");
  main.innerHTML = `<h2>トレード履歴</h2>` + table(
    ["トレードID", "銘柄", "units", "エントリー", "価格", "決済", "価格", "損益¥", "スワップ¥", "戦略", "状態"],
    rows.map((t) => `<tr>
      <td>${esc(t.oanda_trade_id)}</td><td>${esc(t.instrument)}</td><td>${fmt(t.units, 0)}</td>
      <td>${shortTs(t.entry_ts)}</td><td>${fmt(t.entry_price, 3)}</td>
      <td>${shortTs(t.exit_ts)}</td><td>${fmt(t.exit_price, 3)}</td>
      <td class="${cls(t.pl_jpy)}">${fmt(t.pl_jpy, 0)}</td><td>${fmt(t.financing_jpy, 0)}</td>
      <td>${esc(t.strategy_id)}</td><td>${t.state}</td></tr>`),
  );
}

async function decisions() {
  const rows = await api("/api/decisions?limit=200");
  main.innerHTML = `<h2>判定ログ</h2>
    <p class="muted">判定が1分遅れるのは正常系 (cronと足確定の競合時は次tickで処理される)。blocked/errorに注目。</p>` +
    table(
      ["時刻", "戦略", "銘柄", "バー", "pos", "target", "action", "SL", "TP", "status", "理由"],
      rows.map((d) => `<tr ${d.status === "error" ? 'class="neg"' : ""}>
        <td>${shortTs(d.ts)}</td><td>${esc(d.strategy_id)}</td><td>${esc(d.instrument)}</td>
        <td>${new Date(d.bar_time).toISOString().slice(5, 16)}</td>
        <td>${d.position}</td><td>${d.target}</td><td>${d.action}</td>
        <td>${fmt(d.sl_pips, 1)}</td><td>${fmt(d.tp_pips, 1)}</td>
        <td>${d.status}</td><td>${esc(d.reason)}</td></tr>`),
    );
}

async function params() {
  const current = await api("/api/params");
  const history = await api("/api/params/history");
  main.innerHTML = `<h2>戦略パラメータ (v${current.version})</h2>
    <p class="muted">保存すると新バージョンとして記録され、<b>次のcron tickから新規エントリーのみ</b>に適用されます (既存ポジションのSL/TPには遡及しません)。<br>
    リスク上限・損失上限などの安全限界はここでは変更できません (環境変数のみ)。</p>
    <textarea id="params-json">${esc(JSON.stringify(current.doc, null, 2))}</textarea>
    <p><input type="text" id="params-note" placeholder="変更メモ (任意)" size="40" />
    <button class="primary" id="params-save">検証して保存</button></p>
    <div id="params-result"></div>
    <h3>変更履歴</h3>` +
    table(["ver", "更新時刻", "メモ"], history.map((h) => `<tr><td>v${h.version}</td><td>${shortTs(h.updated_at)}</td><td>${esc(h.note)}</td></tr>`));

  document.getElementById("params-save").addEventListener("click", async () => {
    const out = document.getElementById("params-result");
    try {
      const doc = JSON.parse(document.getElementById("params-json").value);
      out.innerHTML = `<pre class="diff">${esc(diffSummary(current.doc, doc))}</pre><p>この内容で保存しますか？ <button class="primary" id="confirm-save">保存する</button></p>`;
      document.getElementById("confirm-save").addEventListener("click", async () => {
        const res = await api("/api/params", {
          method: "POST",
          body: JSON.stringify({ doc, note: document.getElementById("params-note").value }),
        });
        out.innerHTML = `<p class="pos">保存しました (v${res.version})</p>`;
        setTimeout(() => route(), 800);
      });
    } catch (err) {
      out.innerHTML = `<p class="neg">エラー: ${esc(err.message)}</p>`;
    }
  });
}

function diffSummary(before, after) {
  const b = JSON.stringify(before, null, 2).split("\n");
  const a = JSON.stringify(after, null, 2).split("\n");
  const lines = [];
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i++) {
    if (b[i] !== a[i]) {
      if (b[i] !== undefined) lines.push(`- ${b[i]}`);
      if (a[i] !== undefined) lines.push(`+ ${a[i]}`);
    }
  }
  return lines.length ? lines.join("\n") : "(変更なし)";
}

async function safety() {
  const s = await api("/api/summary");
  const unknowns = await api("/api/intents?status=unknown");
  const pendings = await api("/api/intents?status=pending");
  const problem = [...unknowns, ...pendings];
  updateKsBanner(s.killSwitch);
  const ks = s.killSwitch;
  main.innerHTML = `<h2>安全装置</h2>
    <section>
      <h3>キルスイッチ: ${ks?.active ? `<span class="neg">発動中</span>` : `<span class="pos">待機</span>`}</h3>
      ${ks?.active ? `<p>理由: ${esc(ks.reason)} (${shortTs(ks.trippedAt)})</p>
        <p>解除は状況を確認した上で行ってください。<br>
        <input type="text" id="reset-confirm" placeholder="RESET と入力" />
        <button class="danger" id="ks-reset">解除する</button></p>`
      : `<p><input type="text" id="kill-confirm" placeholder="KILL と入力" />
        <button class="danger" id="ks-trip">キルスイッチ発動</button>
        <span class="muted">全注文キャンセル + 取引ロック${""}</span></p>`}
    </section>
    <section>
      <h3>要確認intent (unknown/pending: ${problem.length}件)</h3>
      ${problem.length === 0 ? `<p class="pos">なし</p>` : table(
        ["client_id", "時刻", "銘柄", "units", "status"],
        problem.map((i) => `<tr class="neg"><td>${esc(i.client_id)}</td><td>${shortTs(i.ts)}</td><td>${esc(i.instrument)}</td><td>${fmt(i.units, 0)}</td><td>${i.status}</td></tr>`),
      )}
      <p class="muted">unknown = 発注結果が不明のままの注文。次のtickの照合で自動解決されるはず。残り続ける場合はOANDA管理画面で建玉を直接確認すること。</p>
    </section>
    <section>
      <h3>ローカル設定</h3>
      <p><input type="password" id="admin-token" placeholder="ADMIN_TOKEN (Access未設定時のみ)" value="${esc(token())}" />
      <button id="save-token">保存</button>
      <span class="muted">Cloudflare Access配下ではトークン不要。</span></p>
    </section>`;

  document.getElementById("save-token")?.addEventListener("click", () => {
    localStorage.setItem("adminToken", document.getElementById("admin-token").value);
    alert("保存しました");
  });
  document.getElementById("ks-trip")?.addEventListener("click", async () => {
    if (document.getElementById("kill-confirm").value !== "KILL") return alert("KILL と入力してください");
    await api("/api/kill", { method: "POST", body: JSON.stringify({ reason: "管理画面から手動発動" }) });
    route();
  });
  document.getElementById("ks-reset")?.addEventListener("click", async () => {
    if (document.getElementById("reset-confirm").value !== "RESET") return alert("RESET と入力してください");
    await api("/api/kill/reset", { method: "POST", body: "{}" });
    route();
  });
}

/* ---------- 共通 ---------- */

function updateKsBanner(ks) {
  if (ks?.active) {
    ksBanner.textContent = `🚨 キルスイッチ発動中: ${ks.reason}`;
    ksBanner.classList.remove("hidden");
  } else {
    ksBanner.classList.add("hidden");
  }
}

const shortTs = (ts) => (ts ? String(ts).replace("T", " ").slice(5, 19) : "—");

const PAGES = { dashboard, trades, decisions, params, safety };

async function route() {
  const page = location.hash.replace("#", "") || "dashboard";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.hash === `#${page}`));
  try {
    await (PAGES[page] ?? dashboard)();
  } catch (err) {
    main.innerHTML = `<p class="neg">読み込みエラー: ${esc(err.message)}</p>`;
  }
}

window.addEventListener("hashchange", route);
route();
