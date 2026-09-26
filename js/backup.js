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

  /* ===== お客様名簿（CSV）=====
     予約データから名前・住所・電話だけを抜き出してExcelで開ける形にする（店主 2026-09-26）。
     同じお客様は1行にまとめる。同一人物の判定は電話番号（数字だけにして比較）、
     電話が空なら名前＋住所。名前や住所は一番新しい予約のものを採る。
     純関数にしてあるのでヘッドレスで中身を確かめられる */
  const digits = (s) => String(s || "").replace(/\D/g, "");
  function customersFromOrders(orders) {
    const map = new Map();
    const sorted = [...orders].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    for (const o of sorted) {
      const c = o.customer || {};
      const key = digits(c.phone) || `${(c.name || "").trim()}|${(c.address || "").trim()}`;
      if (!key || key === "|") continue;
      const cur = map.get(key);
      if (cur) {
        cur.count += 1;
        if (o.date < cur.firstDate) cur.firstDate = o.date;
      } else {
        map.set(key, {
          name: c.name || "", address: c.address || "", phone: c.phone || "",
          lastDate: o.date || "", firstDate: o.date || "", count: 1,
        });
      }
    }
    return [...map.values()];
  }

  // Excelが勝手に数式や数値として扱わないよう、全欄を "" で囲む
  const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  // 電話番号は "" で囲むだけではExcelが数値にして先頭の0を落とす（店主 2026-09-26・実機で発生）。
  // ="0979…" の形にするとExcel・LibreOfficeとも文字のまま読む。空欄はそのまま空に
  const csvText = (v) => (v === "" || v == null) ? '""' : `=${csvCell(v)}`;
  function customersCsv(orders) {
    const head = ["御名前", "御住所", "電話番号", "最後の予約日", "最初の予約日", "予約回数"];
    const rows = customersFromOrders(orders).map((c) =>
      [csvCell(c.name), csvCell(c.address), csvText(c.phone),
       csvCell(c.lastDate), csvCell(c.firstDate), csvCell(c.count)].join(","));
    return [head.map(csvCell).join(","), ...rows].join("\r\n") + "\r\n";
  }

  async function prepareCustomers() {
    const orders = await db.getAll("orders");
    const csv = customersCsv(orders);
    // 先頭のBOMが無いとWindowsのExcelで日本語が化ける
    const blob = new Blob(["﻿" + csv], { type: "text/csv" });
    return {
      url: URL.createObjectURL(blob),
      filename: `お客様名簿_${stamp()}.csv`,
      count: csv.split("\r\n").length - 2,
    };
  }

  return { build, prepare, download, parse, importPayload, FORMAT,
           customersFromOrders, customersCsv, prepareCustomers };
})();
