// バックアップ: 予約データをJSONファイルへ書き出し／読み込み。
// iPadのSafariはデータを勝手に消すことがあるため、定期的な書き出しが運用の前提。
// 保存先は店のPCの共有フォルダを想定（店内Wi-Fi直・インターネットは経由しない）。
const backup = (() => {
  const FORMAT = 1;   // ファイル形式の版。読み込み時の互換チェックに使う
  const STORES = ["orders", "products", "settings"];  // 画像Blobは対象外（別途検討）

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function build() {
    const data = {};
    for (const s of STORES) data[s] = await db.getAll(s);
    return {
      format: FORMAT,
      app: "uketamawari",
      exportedAt: new Date().toISOString(),
      counts: Object.fromEntries(STORES.map((s) => [s, data[s].length])),
      data,
    };
  }

  // ファイルの中身を用意する（まだ保存はしない）
  async function prepare() {
    const payload = await build();
    const blob = new Blob([JSON.stringify(payload, null, 1)], {
      type: "application/json",
    });
    return {
      url: URL.createObjectURL(blob),
      filename: `承り表バックアップ_${stamp()}.json`,
      counts: payload.counts,
    };
  }

  // 保存ダイアログを出す。iPad Safariでは「ダウンロード」扱いになり保存先を選べる。
  // ここを踏むと後続のJSが中断されることがあるため、記録の保存など
  // 必ずやりたい処理は呼び出し側でこれより前に済ませておくこと。
  function download({ url, filename }) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 即時revokeするとSafariが保存前に失う場合があるため少し置く
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function parse(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error("ファイルが壊れているか、バックアップファイルではありません");
    }
    if (!obj || obj.app !== "uketamawari" || !obj.data) {
      throw new Error("このアプリのバックアップファイルではありません");
    }
    if (obj.format > FORMAT) {
      throw new Error("新しい版のバックアップです。アプリを更新してください");
    }
    return obj;
  }

  // 読み込み。mode="merge"=同じIDのみ上書き / "replace"=全消しして入れ替え
  async function importPayload(payload, mode) {
    const d = payload.data;
    const result = {};
    for (const s of STORES) {
      const rows = Array.isArray(d[s]) ? d[s] : [];
      if (mode === "replace") await db.clear(s);
      for (const row of rows) await db.put(s, row);
      result[s] = rows.length;
    }
    return result;
  }

  /* ===== 予約の記録（CSV）=====
     予約1件＝1行で、お客様の情報と予約の中身（商品・金額・受渡・熨斗など）をExcelで開ける形にする
     （店主 2026-09-26。最初は1人1行の名簿だったが「予約内容も入れてほしい」で予約ごとに変更。
     予約を削除する前の記録として残す用途なので、中身はすべて出す）。
     新しい予約が上。純関数にしてあるのでヘッドレスで中身を確かめられる */
  // Excelが勝手に数式や数値として扱わないよう、全欄を "" で囲む。
  // "" で囲んでも = + - @ で始まる欄はExcelが数式と見なして #NAME? になるので
  // （備考「+10個追加」など）、先頭に空白を1つ足して逃がす
  const csvCell = (v) => {
    let s = String(v ?? "").replace(/"/g, '""');
    if (/^[=+\-@]/.test(s)) s = " " + s;
    return `"${s}"`;
  };
  // 電話番号は "" で囲むだけではExcelが数値にして先頭の0を落とす（店主 2026-09-26・実機で発生）。
  // ="0979…" の形にするとExcel・LibreOfficeとも文字のまま読む。空欄はそのまま空に
  const csvText = (v) => (v === "" || v == null) ? '""' : `=${csvCell(v)}`;
  const pickInline = (picks) => (picks || []).map((p) => `${p.name}×${p.qty}`).join("・");
  // 「詰合せ1×2（最中×9・笑くぼ×10）・大福×10」。中身を選んだ明細は（）で添える
  const itemsText = (items) => (items || []).map((it) => {
    const inner = pickInline(it.picks);
    return `${it.name}×${it.qty}` + (inner ? `（${inner}）` : "");
  }).join("・");
  const visitText = (d) => {
    if (!d.visitAt) return "";
    const [date, time] = d.visitAt.split("T");
    return time ? `${date} ${time}` : date;
  };

  const ORDER_COLUMNS = [
    ["予約日", (o) => o.date],
    ["御名前", (o) => o.customer?.name],
    ["御住所", (o) => o.customer?.address],
    ["電話番号", (o) => o.customer?.phone, csvText],
    ["商品", (o) => itemsText(o.items)],
    ["合計", (o) => o.total],
    ["総個数", (o) => o.totalQty],
    ["受渡", (o) => o.delivery?.method],
    ["御来店日時", (o) => visitText(o.delivery || {})],
    ["発送日", (o) => o.delivery?.shipDate],
    ["着日", (o) => o.delivery?.arriveDate],
    ["熨斗", (o) => o.noshi?.type],
    ["熨斗サイズ", (o) => o.noshi?.size],
    ["表書き", (o) => o.noshi?.omotegaki],
    // picksが無い古い予約は紙用の文字列（「・最中×9」を改行で並べたもの）から起こす
    ["菓子・包材", (o) => pickInline(o.packagingPicks)
      || String(o.packaging || "").split("\n").map((l) => l.replace(/^・/, "")).filter(Boolean).join("・")],
    ["備考", (o) => o.memo],
    ["担当", (o) => o.staff],
    ["お支払い", (o) => (o.paid ? "済" : "まだ")],
    ["お渡し", (o) => (o.status === "受渡済" ? "済" : "まだ")],
    ["予約ID", (o) => o.id],
  ];
  function ordersCsv(orders) {
    const sorted = [...orders].sort((a, b) =>
      String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
    const head = ORDER_COLUMNS.map(([h]) => csvCell(h)).join(",");
    const rows = sorted.map((o) =>
      ORDER_COLUMNS.map(([, get, fmt]) => (fmt || csvCell)(get(o))).join(","));
    return [head, ...rows].join("\r\n") + "\r\n";
  }

  async function prepareOrdersCsv() {
    const orders = await db.getAll("orders");
    const csv = ordersCsv(orders);
    // 先頭のBOMが無いとWindowsのExcelで日本語が化ける
    const blob = new Blob(["﻿" + csv], { type: "text/csv" });
    return {
      url: URL.createObjectURL(blob),
      filename: `予約の記録_${stamp()}.csv`,
      count: orders.length,
    };
  }

  return { build, prepare, download, parse, importPayload, FORMAT, ordersCsv, prepareOrdersCsv };
})();
