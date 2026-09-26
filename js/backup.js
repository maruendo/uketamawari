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

  /* ===== 予約の記録（Excel）=====
     予約1件＝1行で、お客様の情報と予約の中身（商品・金額・受渡・熨斗など）をExcelファイルにする
     （店主 2026-09-26。最初は1人1行の名簿CSVだったが「予約内容も入れてほしい」で予約ごとに変更。
     予約を削除する前の記録として残す用途なので、中身はすべて出す）。
     CSVは店のExcelで先頭0が消える・全部A列に入る、が起きたので .xlsx を直接作る（js/xlsx.js）。
     新しい予約が上。ordersRows は純関数にしてあるのでNodeで中身を確かめられる */
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
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (v == null || v === "" ? null : String(v)));

  // [見出し, 値の取り出し, 列幅]。文字はそのまま文字セル、合計・総個数だけ数値セルにする
  const ORDER_COLUMNS = [
    ["予約日", (o) => o.date, 11],
    ["御名前", (o) => o.customer?.name, 14],
    ["御住所", (o) => o.customer?.address, 30],
    ["電話番号", (o) => o.customer?.phone, 14],
    ["商品", (o) => itemsText(o.items), 50],
    ["合計", (o) => num(o.total), 8],
    ["総個数", (o) => num(o.totalQty), 7],
    ["受渡", (o) => o.delivery?.method, 6],
    ["御来店日時", (o) => visitText(o.delivery || {}), 17],
    ["発送日", (o) => o.delivery?.shipDate, 11],
    ["着日", (o) => o.delivery?.arriveDate, 11],
    ["熨斗", (o) => o.noshi?.type, 6],
    ["熨斗サイズ", (o) => o.noshi?.size, 9],
    ["表書き", (o) => o.noshi?.omotegaki, 8],
    // picksが無い古い予約は紙用の文字列（「・最中×9」を改行で並べたもの）から起こす
    ["菓子・包材", (o) => pickInline(o.packagingPicks)
      || String(o.packaging || "").split("\n").map((l) => l.replace(/^・/, "")).filter(Boolean).join("・"), 30],
    ["備考", (o) => o.memo, 30],
    ["担当", (o) => o.staff, 8],
    ["お支払い", (o) => (o.paid ? "済" : "まだ"), 8],
    ["お渡し", (o) => (o.status === "受渡済" ? "済" : "まだ"), 7],
    ["予約ID", (o) => o.id, 16],
  ];
  function ordersRows(orders) {
    const sorted = [...orders].sort((a, b) =>
      String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
    const head = ORDER_COLUMNS.map(([h]) => h);
    const rows = sorted.map((o) => ORDER_COLUMNS.map(([, get]) => {
      const v = get(o);
      return v == null ? null : (typeof v === "number" ? v : String(v));
    }));
    return [head, ...rows];
  }
  const ORDER_WIDTHS = ORDER_COLUMNS.map(([, , w]) => w);

  function ordersXlsx(orders) {
    return xlsx.build({ sheetName: "予約", rows: ordersRows(orders), widths: ORDER_WIDTHS });
  }

  async function prepareOrdersXlsx() {
    const orders = await db.getAll("orders");
    const blob = new Blob([ordersXlsx(orders)], { type: xlsx.MIME });
    return {
      url: URL.createObjectURL(blob),
      filename: `予約の記録_${stamp()}.xlsx`,
      count: orders.length,
    };
  }

  return { build, prepare, download, parse, importPayload, FORMAT, ordersRows, ordersXlsx, prepareOrdersXlsx };
})();
