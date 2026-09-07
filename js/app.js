// 画面制御・受注入力・顧客情報・印刷プレビュー
(() => {
  const state = {
    master: null,          // { categories, staff, products }
    currentCategory: null,
    items: [],             // { productId, name, price, qty, note }
    info: {                // 顧客・受渡情報（フォームと同期）
      date: "", staff: "", name: "", address: "", phone: "",
      method: "来店", visitDate: "", visitTime: "",
      shipDate: "", arriveDate: "",
      noshiType: "なし", noshiSize: "", omotegaki: "",
      packaging: "", packagingPicks: [], memo: "", paid: false,   // paid=会計済み（店主が印刷前に付ける）
    },
    currentOrderId: null,  // 保存済みの予約を編集中ならそのID（上書き保存用）
    orderMeta: null,       // { createdAt, status } 既存予約の引き継ぎ
    listFilter: "all",
    openedFrom: "form",    // "list"=予約一覧から開いた / "form"=入力の流れで来た（印刷画面の戻り先が変わる）
    prevScreen: null,      // 直前の画面。「◀ …へ戻る」は一段だけここへ戻る（2026-09-02）
    savedSnapshot: null,   // 最後に保存／読み込んだ時点の内容。今と違えば「保存していない変更あり」
  };

  const OMOTEGAKI_PRESETS = ["御祝", "内祝", "御供", "志", "御中元", "御歳暮"];

  // 設定画面に出す版番号。iPadに届いているのが新しい版かを店主と電話で確認するために要る。
  // **sw.js の CACHE と必ず同じ番号にすること**（片方だけ上げると嘘の表示になる）
  const APP_VERSION = "v37（2026-09-07）";

  const $ = (sel) => document.querySelector(sel);
  const yen = (n) => "¥" + Number(n).toLocaleString("ja-JP");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const fmtDateJa = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    const w = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
    return `${y}年${m}月${d}日（${w}）`;
  };

  /* ===== 画面遷移 ===== */
  // iPadは入力欄の外を触ってもキーボードが閉じない。出したままだと
  // 画面下のボタン（印刷など）がキーボードの裏に隠れて押せなくなるので、
  // 入力欄からフォーカスを外して明示的に閉じる。
  function closeKeyboard() {
    const el = document.activeElement;
    if (el && typeof el.blur === "function"
        && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      el.blur();
    }
  }

  /* ===== 入力中ロック（店主と相談のうえ案1に決定 2026-09-02）=====
     商品を選び始めてから保存・印刷・クリアで終えるまでを「入力中」とし、その間は上の
     「予約一覧」「設定」を押せなくする。理由: 入力の途中で一覧へ飛んで別の予約を「開く」と、
     途中の入力が黙って消えていた。確認の窓を増やす案（見るだけモード等）より、
     「入力中は出られない」の一本にした方が店主が覚えることが少なく、事故も物理的に起きない。
     入力中を終える出口は3つだけ: プレビューの「保存」「印刷」（どちらも予約一覧へ）、受注入力の「クリア」。
     一覧から開いた予約は、プレビューの「予約一覧へ戻る」でも閉じられる（未保存の変更があるときだけ確認） */
  const isBusy = () =>
    state.items.length > 0 || !!state.info.name.trim() || !!state.info.phone.trim() || !!state.currentOrderId;
  const snapshot = () => JSON.stringify({ items: state.items, info: state.info });
  // 未保存の変更があるか。新規入力は保存するまで常に「あり」、開いた予約は読み込み時点と比べる
  const isDirty = () => isBusy() && snapshot() !== state.savedSnapshot;

  function updateNavLock() {
    const busy = isBusy();
    document.querySelectorAll(".nav-btn").forEach((b) => {
      const lock = busy && b.dataset.goto !== "screen-order";
      b.classList.toggle("locked", lock);
      b.setAttribute("aria-disabled", lock ? "true" : "false");
      if (b.dataset.goto === "screen-order") b.classList.toggle("busy", busy);
    });
  }
  let noticeTimer = null;
  function showNavNotice(msg) {
    const el = $("#nav-notice");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => el.classList.add("hidden"), 4000);
  }

  function goto(screenId) {
    closeKeyboard();
    const cur = document.querySelector(".screen.active");
    if (cur && cur.id !== screenId) state.prevScreen = cur.id;
    updateNavLock();
    if (screenId === "screen-order") renderDetailHeading();
    if (screenId === "screen-customer") onEnterCustomer();
    if (screenId === "screen-list") renderOrderList();
    if (screenId === "screen-master") renderSettings();
    // お客様入力画面の間はタブレットをお客様に渡すため、
    // 他画面（予約一覧・設定）へ行けるメニューを隠す
    document.body.classList.toggle("customer-mode", screenId === "screen-customer");
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $("#" + screenId).classList.add("active");
    // 商品の編集画面は設定画面の続きなので、上のメニューは「設定」を光らせたままにする
    const navFor = screenId === "screen-edit" ? "screen-master" : screenId;
    document.querySelectorAll(".nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.goto === navFor);
    });
    if (screenId === "screen-preview") fitSheets();   // 表示されてから測り直す
  }
  document.querySelectorAll("[data-goto]").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.classList.contains("locked")) {
        showNavNotice("入力中です。「保存」「印刷」「クリア」のどれかで終えてから移動できます");
        return;
      }
      goto(b.dataset.goto);
    });
  });

  // 「◀ …へ戻る」＝一段だけ前の画面へ。文字は行き先つき（「戻る」だけだと、どこへ戻るのか
  // 経路によって違うので迷う、との店主指摘 2026-09-02）
  const SCREEN_LABEL = { "screen-order": "商品選択", "screen-customer": "お客様情報", "screen-preview": "印刷プレビュー", "screen-list": "予約一覧" };
  function customerBackTarget() {
    return state.prevScreen === "screen-preview" ? "screen-preview" : "screen-order";
  }
  $("#btn-customer-back").addEventListener("click", () => {
    const to = customerBackTarget();
    if (to === "screen-preview") renderSheet();   // 直した内容をプレビューに反映してから戻る
    goto(to);
  });

  // 入力欄以外をタップしたらキーボードを閉じる（iPadには「完了」が無いため）。
  // iOSは touchend → mousedown → focus の順に起きるので、touchendの時点で即blurすると
  // 「これから開くキーボード」を潰しかねない。少し待ってフォーカスが動いていないときだけ閉じる。
  document.addEventListener("touchend", (e) => {
    if (e.target.closest("input, textarea, select, label, button")) return;
    const before = document.activeElement;
    setTimeout(() => {
      // この間にフォーカスが動いていたら、そのタップは入力欄を開くタップだったということ
      if (document.activeElement === before) closeKeyboard();
    }, 300);
  }, { passive: true });

  // 入力欄に入っている間だけ「キーボードを閉じる」ボタンを出す
  // （お客様情報画面と商品の編集画面の両方に置いてあるのでクラスでまとめて扱う）
  const kbdBtns = [...document.querySelectorAll(".btn-close-kbd")];
  const showKbdBtn = (on) => kbdBtns.forEach((b) => b.classList.toggle("hidden", !on));
  kbdBtns.forEach((b) => b.addEventListener("click", closeKeyboard));
  document.addEventListener("focusin", (e) => {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) showKbdBtn(true);
  });
  document.addEventListener("focusout", () => {
    // 次の入力欄へ移る場合もあるので、少し待ってから判定する
    setTimeout(() => {
      const el = document.activeElement;
      if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) showKbdBtn(false);
    }, 100);
  });

  // キーボードの「改行」でも閉じる。textarea（備考）は改行を残したいので対象外。
  // 日本語入力の「変換の確定」も同じEnterで飛んでくる。ここで閉じてしまうと
  // 漢字に変換した瞬間にキーボードが消えて名前が打てなくなるので、変換中は必ず無視する
  // （isComposing が false でも keyCode 229 で来る端末がある）
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      closeKeyboard();
    }
  });

  /* ===== テンキー ===== */
  const numpad = {
    _onOk: null,
    open({ title, initial, onOk }) {
      $("#numpad-title").textContent = title;
      $("#numpad-display").textContent = String(initial ?? 0);
      this._onOk = onOk;
      this._fresh = true; // 最初のキーで置き換え（レジと同じ挙動）
      $("#numpad-overlay").classList.remove("hidden");
    },
    close() {
      $("#numpad-overlay").classList.add("hidden");
      this._onOk = null;
    },
  };
  $("#numpad-keys").addEventListener("click", (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    const disp = $("#numpad-display");
    if (key === "C") { disp.textContent = "0"; numpad._fresh = false; return; }
    let cur = numpad._fresh ? "" : disp.textContent.replace(/^0$/, "");
    numpad._fresh = false;
    cur = (cur + key).slice(0, 7); // 最大7桁
    disp.textContent = cur === "" ? "0" : String(Number(cur));
  });
  $("#numpad-cancel").addEventListener("click", () => numpad.close());
  $("#numpad-ok").addEventListener("click", () => {
    const val = Number($("#numpad-display").textContent);
    const fn = numpad._onOk;
    numpad.close();
    if (fn) fn(val);
  });

  /* ===== 選択リスト（商品内容・菓子包材） =====
     店主の指示で、どちらも手打ちではなく「種類＋個数を選ぶ」方式にする。
       商品内容 … 詰合せの中身。候補は菓子（sweet）
       菓子・包材 … 箱・紙袋など。候補は包材（packaging）
     保存は picks（配列）が正で、紙に出す文字列はそこから組み立てる。 */
  // 1件ぶんの表記（「・最中×9」）。縦・横どちらの並べ方でもこれを使い回す
  const pickLine = (p) => `・${p.name}×${p.qty}`;
  // 縦1行ずつ（店主指示 2026-09-01）。右下の菓子・包材の大枠はこちら。
  // 改行を出すので、表示側は white-space を pre-line / pre-wrap にしておくこと
  const fmtPicks = (picks) => (picks || []).map(pickLine).join("\n");
  // 横につなげて詰める（店主指示 2026-09-02）。明細表の「商品内容」欄はこちら。
  // 大枠と違って行の高さが決まっているため、1品ずつ改行すると行が間延びする
  const fmtPicksInline = (picks) => (picks || []).map(pickLine).join("");

  /* 詰合せ1・2は中身が決まっているので、明細に追加した瞬間に商品内容メモへ
     自動で中身を入れる（店主 2026-09-02）。中身は商品マスタの contents
     （価格表の「中身」列をそのまま持つ生の文字列。reference/make_products.py 参照）を、
     菓子の名前候補と突き合わせて読み取る。表記ゆれ（笑窪→中津の笑くぼ 等）は
     下の別名表で吸収し、全角数字も算用数字に直してから読む。
     **確実に読み取れた分だけ**自動で入れる。1つでも怪しければ何も入れず、
     これまでどおり店主が手で選ぶ（中身を誤読して配るくらいなら、空のままにして
     気づいてもらう方が安全）。オーダー詰合せ（contents無し）はそもそも対象外＝常に手動。
     自動で入った後も、他の選択と同じタグ操作（＋で足す／タップで消す）で直せる */
  const CONTENTS_ALIASES = {
    "笑窪": "中津の笑くぼ",
    "モナロン": "もなろん",
    "丸ボーロ": "丸ぼうろ",
    "ボーロ": "丸ぼうろ",
    "水饅頭": "水まんじゅう",
    // 羊羹は2026-09-02の価格表で商品名が中身欄と同じ表記（栗羊羹カット等）になった。
    // 「価格表の内容に戻す」を押す前のiPadには旧名（羊羹栗等）が残るので、候補を順に試す
    "栗羊羹カット": ["栗羊羹カット", "羊羹栗"],
    "抹茶羊羹棹": ["抹茶羊羹棹", "羊羹抹茶 1棹"],
    "抹茶羊羹カット": ["抹茶羊羹カット", "羊羹抹茶"],
    "干菓子": "京干菓子2個入",   // 店主確認 2026-09-02: 詰合せの干菓子＝京干菓子2個入が1袋（1個＝1袋）
    // 店主確認 2026-09-02: 価格表の「丸円どら焼き」＝店で言う「どら焼き」（200円）。商品名は
    // 「どら焼き」に直したが、「価格表の内容に戻す」前のiPadには丸円どら焼きの名で届いている
    "どら焼き": ["どら焼き", "丸円どら焼き"],
    // 詰合せ9の「ガトー抹茶」＝ガトー小。価格で裏取り済み（2026-09-02）:
    // ガトー小2400＋もなろん3×160＋フロランタン3×190＋黒箱350＝3800＝詰合せ9の価格
    "ガトー抹茶": "ガトー小",
  };
  // これ以降が読めなければ「包材の話に移った」とみなして打ち切る（包材はここでは拾わない）
  const CONTENTS_PACKAGING_HINT = /^(箱|籠|敷|ケース|階段|セット箱|デラックス|黒箱|桐箱|茶籠|風呂敷|ワッパ)/;
  const toHankakuDigits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

  function autoPicksFromContents(product) {
    if (!product.contents) return null;
    const sweets = state.master.products.filter((p) => p.sweet);
    const candidates = [
      ...sweets.map((p) => [p.name, p]),
      ...Object.entries(CONTENTS_ALIASES)
        .map(([alias, names]) => [alias, [].concat(names).map((n) => sweets.find((p) => p.name === n)).find(Boolean)])
        .filter(([, p]) => p),
    ].sort((a, b) => b[0].length - a[0].length);   // 長い表記から先に試す（部分一致の誤爆防止）

    let s = toHankakuDigits(product.contents);
    const picks = [];
    while (s.length) {
      const hit = candidates.find(([alias]) => s.startsWith(alias));
      if (!hit) return (CONTENTS_PACKAGING_HINT.test(s) && picks.length) ? picks : null;
      s = s.slice(hit[0].length);
      const numMatch = s.match(/^\d+/);
      if (!numMatch) return null;   // 名前の直後に個数が無い＝読み方の想定が外れている
      const qty = Number(numMatch[0]);
      s = s.slice(numMatch[0].length);
      if (qty <= 0 || qty > 30) return null;   // 桁の誤読（例: 205個）を弾く安全弁
      picks.push({ id: hit[1].id, name: hit[1].name, qty });
    }
    return picks.length ? picks : null;
  }

  /* 明細に追加したときに自動で入れる中身。
     1. 店主が設定画面で決めた「詰合せの中身」（fixedPicks）があればそれを最優先。
        名前は今の商品マスタから引き直す（改名しても追従する）。かくした／消した菓子は
        設定したときの名前のまま出す（作る菓子であることに変わりはないため）
     2. 無ければ価格表の記載（contents）を読み取る（上の autoPicksFromContents） */
  function autoPicksFor(product) {
    const fixed = product.fixedPicks;
    if (Array.isArray(fixed) && fixed.length) {
      return fixed.map((f) => {
        const cur = state.master.products.find((p) => p.id === f.id);
        return { id: f.id, name: cur ? cur.name : f.name, qty: f.qty };
      });
    }
    return autoPicksFromContents(product);
  }

  const picker = {
    _onPick: null,
    _kind: null,
    _cat: null,
    open({ title, kind, onPick }) {
      this._onPick = onPick;
      this._kind = kind;
      this._cat = null;
      $("#picker-title").textContent = title;
      this.render();
      $("#picker-overlay").classList.remove("hidden");
    },
    close() {
      $("#picker-overlay").classList.add("hidden");
      this._onPick = null;
    },
    candidates() {
      return state.master.products.filter((p) => p[this._kind]);
    },
    render() {
      const all = this.candidates();
      // 候補が多いので価格表の分類で絞り込めるようにする
      const cats = [...new Set(all.map((p) => p.srcCategory || p.category))];
      if (!this._cat) this._cat = cats[0];
      const tabs = $("#picker-tabs");
      tabs.innerHTML = "";
      cats.forEach((c) => {
        const b = document.createElement("button");
        b.className = "picker-tab" + (c === this._cat ? " active" : "");
        b.textContent = c;
        b.addEventListener("click", () => { this._cat = c; this.render(); });
        tabs.appendChild(b);
      });
      const list = $("#picker-list");
      list.innerHTML = "";
      all.filter((p) => (p.srcCategory || p.category) === this._cat).forEach((p) => {
        const b = document.createElement("button");
        b.className = "picker-item";
        b.textContent = p.name;
        b.addEventListener("click", () => {
          const fn = this._onPick;
          this.close();
          numpad.open({
            title: `${p.name} の個数`,
            initial: 1,
            onOk: (qty) => { if (qty > 0 && fn) fn({ id: p.id, name: p.name, qty }); },
          });
        });
        list.appendChild(b);
      });
      if (!list.children.length) {
        list.innerHTML = '<div class="picker-none">この分類に商品がありません</div>';
      }
    },
  };
  $("#picker-close").addEventListener("click", () => picker.close());
  $("#picker-overlay").addEventListener("click", (e) => {
    if (e.target.id === "picker-overlay") picker.close();
  });

  // 選んだものを「もなろん3 ×」のタグで並べる。タグを押すと取り消し
  function renderPicks(el, picks, onChange) {
    el.innerHTML = "";
    if (!picks.length) {
      el.innerHTML = '<span class="picks-none">（未選択）</span>';
      return;
    }
    picks.forEach((p, idx) => {
      const tag = document.createElement("button");
      tag.className = "pick-tag";
      tag.innerHTML = `${esc(p.name)}<b>${p.qty}</b><span class="x">×</span>`;
      tag.title = "押すと取り消します";
      // 一回触っただけで消えるのは危ない（店主 2026-09-02）。必ず確認を挟む。
      // 商品内容・菓子包材・商品編集の「詰合せの中身」の3か所すべてに効く
      tag.addEventListener("click", () => {
        if (!confirm(`「${p.name}×${p.qty}」を取り消しますか？`)) return;
        picks.splice(idx, 1); onChange();
      });
      el.appendChild(tag);
    });
  }

  /* ===== カテゴリタブ・商品グリッド ===== */
  function renderTabs() {
    const wrap = $("#category-tabs");
    wrap.innerHTML = "";
    state.master.categories.forEach((cat) => {
      const b = document.createElement("button");
      b.className = "cat-tab" + (cat === state.currentCategory ? " active" : "");
      b.textContent = cat;
      b.addEventListener("click", () => {
        state.currentCategory = cat;
        renderTabs();
        renderGrid();
      });
      wrap.appendChild(b);
    });
  }

  function renderGrid() {
    const grid = $("#product-grid");
    grid.innerHTML = "";
    state.master.products
      .filter((p) => p.category === state.currentCategory)
      .forEach((p) => {
        const b = document.createElement("button");
        b.className = "product-btn";
        const priceLabel = p.price == null
          ? '<span class="p-price undecided">価格 手入力</span>'
          : `<span class="p-price">${yen(p.price)}</span>`;
        b.innerHTML = `<span class="p-name">${esc(p.name)}</span>${priceLabel}`;
        b.addEventListener("click", () => tapProduct(p));
        grid.appendChild(b);
      });
  }

  /* ===== 明細操作 ===== */
  function tapProduct(p) {
    const existing = state.items.find((it) => it.productId === p.id);
    if (existing) { existing.qty += 1; renderDetails(); return; }

    // 詰合せ1・2など中身が決まっている商品は、この時点で商品内容を自動で入れておく
    const autoPicks = autoPicksFor(p) || [];
    const autoNote = fmtPicksInline(autoPicks);

    if (p.price == null) {
      // 価格未定商品: 単価を手入力してから明細へ
      numpad.open({
        title: `${p.name} の単価（税込）`,
        initial: 0,
        onOk: (price) => {
          if (price <= 0) return;
          state.items.push({ productId: p.id, name: p.name, price, qty: 1, note: autoNote, picks: autoPicks });
          renderDetails();
        },
      });
      return;
    }
    state.items.push({ productId: p.id, name: p.name, price: p.price, qty: 1, note: autoNote, picks: autoPicks });
    renderDetails();
  }

  function changeQty(item) {
    numpad.open({
      title: `${item.name} の個数`,
      initial: item.qty,
      onOk: (qty) => {
        if (qty <= 0) {
          // 0を打ってOK＝行の削除。長押し削除と同じく確認を挟む（店主 2026-09-02）
          if (!confirm(`個数が0です。「${item.name}」を明細から削除しますか？`)) return;
          state.items = state.items.filter((it) => it !== item);
        } else {
          item.qty = qty;
        }
        renderDetails();
      },
    });
  }

  function removeItem(item) {
    if (confirm(`「${item.name}」を明細から削除しますか？`)) {
      state.items = state.items.filter((it) => it !== item);
      renderDetails();
    }
  }

  function totals() {
    return {
      qty: state.items.reduce((s, it) => s + it.qty, 0),
      price: state.items.reduce((s, it) => s + it.price * it.qty, 0),
    };
  }

  function renderDetails() {
    updateNavLock();
    const ul = $("#detail-list");
    ul.innerHTML = "";
    state.items.forEach((it) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="d-name">${esc(it.name)}</span>` +
        `<span class="d-price">${yen(it.price)}</span>` +
        `<span class="d-qty">${it.qty}</span>` +
        `<span class="d-sub">${yen(it.price * it.qty)}</span>`;

      // タップ=数量変更 / 長押し=削除
      let pressTimer = null, longPressed = false;
      const start = () => {
        longPressed = false;
        pressTimer = setTimeout(() => { longPressed = true; removeItem(it); }, 600);
      };
      const cancel = () => clearTimeout(pressTimer);
      li.addEventListener("touchstart", start, { passive: true });
      li.addEventListener("touchend", (e) => {
        cancel();
        if (!longPressed) { e.preventDefault(); changeQty(it); }
      });
      li.addEventListener("touchmove", cancel, { passive: true });
      // PC(マウス)でも動作確認できるように
      li.addEventListener("mousedown", start);
      li.addEventListener("mouseup", () => { cancel(); if (!longPressed) changeQty(it); });
      li.addEventListener("mouseleave", cancel);

      ul.appendChild(li);
    });

    const t = totals();
    $("#total-qty").textContent = t.qty;
    $("#total-price").textContent = yen(t.price);
    renderDetailHeading();
  }

  // 明細の見出し。保存済みの予約を開いているときは誰の予約かを出して、
  // 「前のお客の予約が残ったまま次の商品を足す」事故に気づけるようにする
  function renderDetailHeading() {
    $("#detail-pane h2").textContent = state.currentOrderId
      ? `明細（保存済み：${state.info.name || "名前なし"} 様）` : "明細";
  }

  $("#btn-clear-order").addEventListener("click", () => {
    if (state.items.length === 0 && !state.currentOrderId) return;
    if (confirm("入力内容をすべてクリアして新しい予約を始めますか？")) {
      resetOrder();
    }
  });

  /* ===== 顧客・受渡情報フォーム ===== */
  function bindText(id, key) {
    $(id).addEventListener("input", (e) => { state.info[key] = e.target.value; });
  }

  function makeToggle(containerSel, onChange) {
    const wrap = $(containerSel);
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".toggle-btn");
      if (!btn) return;
      wrap.querySelectorAll(".toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
      onChange(btn.dataset.val);
    });
  }

  function initCustomerForm() {
    bindText("#f-staff", "staff");
    bindText("#f-name", "name");
    bindText("#f-address", "address");
    bindText("#f-phone", "phone");
    bindText("#f-noshi-size", "noshiSize");
    bindText("#f-omotegaki", "omotegaki");
    bindText("#f-memo", "memo");
    $("#f-date").addEventListener("input", (e) => { state.info.date = e.target.value; });
    $("#f-visit-date").addEventListener("input", (e) => { state.info.visitDate = e.target.value; });
    $("#f-visit-time").addEventListener("input", (e) => { state.info.visitTime = e.target.value; });
    $("#f-ship").addEventListener("input", (e) => { state.info.shipDate = e.target.value; });
    $("#f-arrive").addEventListener("input", (e) => { state.info.arriveDate = e.target.value; });

    makeToggle("#delivery-toggle", (val) => {
      state.info.method = val;
      $("#row-visit").classList.toggle("hidden", val !== "来店");
      $("#row-ship").classList.toggle("hidden", val !== "配送");
    });
    makeToggle("#noshi-toggle", (val) => { state.info.noshiType = val; });

    renderStaffButtons();

    // 表書きプリセットボタン
    const ob = $("#omotegaki-btns");
    OMOTEGAKI_PRESETS.forEach((word) => {
      const b = document.createElement("button");
      b.className = "toggle-btn";
      b.textContent = word;
      b.addEventListener("click", () => {
        state.info.omotegaki = word;
        $("#f-omotegaki").value = word;
        ob.querySelectorAll(".toggle-btn").forEach((x) => x.classList.toggle("active", x === b));
      });
      ob.appendChild(b);
    });

    // 菓子・包材（包材のみ。店主指示 2026-08-30）
    const refreshPackaging = () => {
      renderPicks($("#packaging-picks"), state.info.packagingPicks, refreshPackaging);
      state.info.packaging = fmtPicks(state.info.packagingPicks);
    };
    $("#btn-pick-packaging").addEventListener("click", () => {
      picker.open({
        title: "菓子・包材",
        kind: "packaging",
        onPick: (p) => { state.info.packagingPicks.push(p); refreshPackaging(); },
      });
    });
    refreshPackaging();
    state._refreshPackaging = refreshPackaging;   // 予約を読み込んだときの再描画用
  }

  // 担当者ボタン（マスタから。設定画面で変更されたら描き直す）
  function renderStaffButtons() {
    const sb = $("#staff-btns");
    sb.innerHTML = "";
    state.master.staff.forEach((name) => {
      const b = document.createElement("button");
      b.className = "toggle-btn" + (state.info.staff === name ? " active" : "");
      b.textContent = name;
      b.addEventListener("click", () => {
        state.info.staff = name;
        $("#f-staff").value = name;
        sb.querySelectorAll(".toggle-btn").forEach((x) => x.classList.toggle("active", x === b));
      });
      sb.appendChild(b);
    });
  }

  function onEnterCustomer() {
    $("#btn-customer-back").textContent = `◀ ${SCREEN_LABEL[customerBackTarget()]}へ戻る`;
    if (!state.info.date) {
      state.info.date = todayStr();
      $("#f-date").value = state.info.date;
    }
    // 明細行ごとの商品内容メモ
    const wrap = $("#item-notes");
    wrap.innerHTML = "";
    if (state.items.length === 0) {
      wrap.innerHTML = '<span class="none">（商品が選ばれていません）</span>';
      return;
    }
    state.items.forEach((it) => {
      if (!it.picks) it.picks = [];
      const row = document.createElement("div");
      row.className = "item-note-row";
      const nameSpan = document.createElement("span");
      nameSpan.className = "in-name";
      nameSpan.textContent = it.name;

      const picksEl = document.createElement("div");
      picksEl.className = "picks";
      const add = document.createElement("button");
      add.className = "pick-add";
      add.textContent = "＋ 中身を選ぶ";

      const refresh = () => {
        renderPicks(picksEl, it.picks, refresh);
        it.note = fmtPicksInline(it.picks);   // 紙・保存用の文字列を同期
      };
      add.addEventListener("click", () => {
        picker.open({
          title: `${it.name} の中身`,
          kind: "sweet",
          onPick: (p) => { it.picks.push(p); refresh(); },
        });
      });
      refresh();

      row.appendChild(nameSpan);
      row.appendChild(picksEl);
      row.appendChild(add);
      wrap.appendChild(row);
    });
  }

  /* ===== 印刷プレビュー（承り表） =====
     A4横1枚に2面。左=お客様用・右=店用で中身が違う（店主指示 2026-08-30）。
       お客様用: 明細＋合計＋店名住所。菓子・包材の枠と備考は載せない
       店用    : 従来どおり菓子・包材の大枠・備考・トータル数あり
     配置は店の指示なので勝手に変えないこと。 */
  const SHOP = {
    name: "菓子舗丸円堂",
    zip: "〒871-0021",
    address: "大分県中津市沖代町1丁目446番11",
    tel: "TEL 0979-64-6328",
  };
  const ITEM_ROWS = 7;   // 明細の行数（記入分＋手書き用の空行）

  // withNote=false はお客様控（商品内容の列を出さない。店主 2026-09-07:
  // 「お客様は商品内容とトータル数は必要ない」。列が減るぶん商品名が読みやすくなる）
  function itemRows(withNote) {
    let rows = "";
    for (let r = 0; r < ITEM_ROWS; r++) {
      const it = state.items[r];
      const note = it ? (fmtPicksInline(it.picks) || it.note || "") : "";
      const noteTd = withNote ? `<td class="c-note">${it ? esc(note) : ""}</td>` : "";
      rows += it
        ? `<tr><td>${esc(it.name)}</td><td class="c-price">${yen(it.price)}</td><td class="c-qty">${it.qty}</td>${noteTd}</tr>`
        : `<tr class="blank"><td></td><td class="c-price"></td><td class="c-qty"></td>${noteTd}</tr>`;
    }
    return rows;
  }

  // 支払い欄。Wordの様式どおり「済・未」を並べ、当てはまる方に丸を付ける
  // （熨斗の内・外と同じ見せ方。赤字のお礼文にする案は取り下げ 2026-08-30）
  function paidHTML() {
    return ["済", "未"]
      .map((v) => `<span class="noshi-opt${(state.info.paid ? "済" : "未") === v ? " sel" : ""}">${v}</span>`)
      .join("・");
  }

  /* 店控の右下の大枠 ＝ その予約ぶんの **製造指示書**（店主 2026-09-01）。
     売った商品名を並べる欄ではない。「何の菓子を何個作り、何の包材を用意するか」を書く。
       菓子 … 中身(picks)を選んだ明細は、**中身の個数×その商品(箱)の個数**で数える
              （中身は1箱ぶんの入力なので、箱が複数ならその分だけ増やす。店主 2026-09-02。
              以前は「箱数は掛けない」だったが、紙の承り表への店主の赤字修正で
              実際の総数と食い違うことが分かり、この掛け算に変更した）。
              選んでいない明細は商品そのものを数える（大福×10 のような単品も作る菓子なので出す）
       包材 … 選んだ包材（個数はそのまま。箱の数と結び付いていないため掛けない）
     どちらも**同じ名前は合算**する。ばらばらに並んでいると作る数を数えられないため。 */
  function tallyLines(pairs) {
    const m = new Map();
    pairs.forEach(([name, qty]) => m.set(name, (m.get(name) || 0) + qty));
    return [...m].map(([name, qty]) => `・${name}×${qty}`);
  }

  function shopBoxText() {
    const goods = [];
    state.items.forEach((it) => {
      const picks = it.picks || [];
      if (picks.length) picks.forEach((p) => goods.push([p.name, p.qty * it.qty]));
      else goods.push([it.name, it.qty]);
    });
    const packPicks = state.info.packagingPicks || [];
    const blocks = [];
    if (goods.length) blocks.push(tallyLines(goods).join("\n"));
    if (packPicks.length) blocks.push(tallyLines(packPicks.map((p) => [p.name, p.qty])).join("\n"));
    else if (state.info.packaging) blocks.push(state.info.packaging);  // picksが無い古い予約
    return blocks.join("\n\n");
  }

  function sheetHTML(kind) {
    const i = state.info;
    const t = totals();
    const forShop = kind === "shop";

    const noshiOpts = ["内", "外"].map((v) =>
      `<span class="noshi-opt${i.noshiType === v ? " sel" : ""}">${v}</span>`).join("・");
    const visitStr = i.method === "来店"
      ? `<span class="nw">${fmtDateJa(i.visitDate)}</span> <span class="nw">${esc(i.visitTime)}</span>` : "";
    const shipStr = i.method === "配送" ? `<span class="nw">${fmtDateJa(i.shipDate)}</span>` : "";
    const arriveStr = i.method === "配送" ? `<span class="nw">${fmtDateJa(i.arriveDate)}</span>` : "";

    // 上部は左右2列（左=お客様、右=受渡）
    const head = `
      <div class="sheet-header">
        <span class="sheet-title">承り表</span>
        <span class="sheet-date"><span class="lbl">日付</span> ${fmtDateJa(i.date || todayStr())}</span>
        <span><span class="lbl">受付</span> ${esc(i.staff)}</span>
      </div>
      <div class="sheet-top">
        <div class="st-col">
          <div class="sheet-row sheet-name"><span class="lbl">御名前</span><span class="val">${esc(i.name)}</span><span>様</span></div>
          <div class="sheet-row"><span class="lbl">御住所</span><span class="val">${esc(i.address)}</span></div>
          <div class="sheet-row"><span class="lbl">電話番号</span><span class="val">${esc(i.phone)}</span></div>
          <div class="sheet-row"><span class="lbl">支払</span><span class="val">${paidHTML()}</span></div>
        </div>
        <div class="st-col">
          <div class="sheet-row"><span class="lbl">御来店日時</span><span class="val date-val">${visitStr}</span></div>
          <div class="sheet-row"><span class="lbl">発送日</span><span class="val date-val">${shipStr}</span></div>
          <div class="sheet-row"><span class="lbl">着日</span><span class="val date-val">${arriveStr}</span></div>
          <div class="sheet-row"><span class="lbl">熨斗</span><span>${noshiOpts}</span><span class="lbl">サイズ</span><span class="val">${esc(i.noshiSize)}</span></div>
          <div class="sheet-row"><span class="lbl">表書き</span><span class="val">${esc(i.omotegaki)}</span></div>
        </div>
      </div>`;

    const table = forShop ? `
      <table>
        <tr><th style="width:36%">商品名（箱種類）</th><th style="width:18%">価格（税込）</th><th style="width:10%">個数</th><th>商品内容</th></tr>
        ${itemRows(true)}
      </table>` : `
      <table>
        <tr><th style="width:56%">商品名（箱種類）</th><th style="width:26%">価格（税込）</th><th>個数</th></tr>
        ${itemRows(false)}
      </table>`;
    const tableWithWarn = `${table}
      ${state.items.length > ITEM_ROWS
        ? `<div class="overflow-warn">※明細が${state.items.length}件あり、${ITEM_ROWS}行に入り切りません</div>` : ""}`;

    if (!forShop) {
      // お客様用: レシート風。包材や備考は見せない
      return `<div class="sheet sheet-customer">
        <div class="copy-label">お客様控</div>
        ${head}${tableWithWarn}
        <div class="sheet-totals">
          <span class="thanks">ご予約ありがとうございました</span>
          <span class="total-price">合計（税込） ${yen(t.price)}</span>
        </div>
        <div class="shop-info">
          <div class="shop-name">${SHOP.name}</div>
          <div>${SHOP.zip}</div>
          <div>${esc(SHOP.address)}</div>
          <div>${SHOP.tel}</div>
        </div>
      </div>`;
    }

    // 店用: 菓子・包材の大枠と備考つき
    return `<div class="sheet sheet-shop">
      <div class="copy-label">店控</div>
      ${head}${tableWithWarn}
      <div class="sheet-bottom">
        <div class="sb-left">
          <div class="sheet-row"><span class="lbl">合計（税込）</span><span class="val total-price">${yen(t.price)}</span></div>
          <div class="sheet-row"><span class="lbl">備考</span><span class="val memo">${esc(i.memo)}</span></div>
        </div>
        <div class="sb-right">
          <span class="lbl">トータル数 <b>${t.qty}</b>　菓子・包材</span>
          <div class="memo-box">${esc(shopBoxText())}</div>
        </div>
      </div>
    </div>`;
  }

  function renderSheet() {
    setPrintedMode(false);
    $("#print-sheet").innerHTML =
      `<div class="sheet-pair">
         <div class="sheet-copy sheet-copy-customer">${sheetHTML("customer")}</div>
         <div class="cut-line"></div>
         <div class="sheet-copy sheet-copy-shop">${sheetHTML("shop")}</div>
       </div>
       <div class="mm-ruler" aria-hidden="true"></div>`;
    updatePreviewBar();
    fitSheets();
  }

  /* 店控の字を、A4横の半分（A5相当）の枠の中でできるだけ大きくする（店主 2026-09-07:
     「店控の字が少し大きくなって、A4に収まればいい」。老眼で7pt相当は読みにくい）。
     お客様控は今までどおり zoom 0.60 のまま（「お客様は小さくていい」）。
     やり方: 店控の zoom を 0.80 から 0.02 刻みで下げていき、店控の高さが紙に収まる最初の値を採る。
     下限は 0.60（今までの大きさ。これ以下にはしない）。高さの mm 換算は #print-sheet 内の
     幅100mmの定規要素（.mm-ruler）を実測して行うので、画面の外側の zoom（スマホ幅で 0.42）が
     掛かっていても正しく測れる。予約が軽ければ字が大きく、右下の枠が20行を超えるような重い
     予約では今までの大きさに近づく。プレビュー表示時・resize・beforeprint で掛け直す */
  const SHOP_ZOOM_MAX = 0.80, SHOP_ZOOM_MIN = 0.60, SHOP_ZOOM_STEP = 0.02;
  // A4横の高さ210mm − 余白8mm×2 = 194mm が理論値。ただし店のプリンタ（iPad→AirPrint→Canon TS3730）は
  // Chromeの計測より1割ほど大きく出る疑いがある（v23の「82%で収まる」、2026-09-07の実物写真）ので、
  // 余裕を見て 172mm。**店で2枚に分かれたらここを下げ、下に余白が余るようなら上げる**（1か所で調整できる）
  const PAGE_LIMIT_MM = 172;
  function fitShopZoom() {
    const copy = document.querySelector("#print-sheet .sheet-copy-shop");
    const sheet = copy && copy.querySelector(".sheet");
    const ruler = document.querySelector("#print-sheet .mm-ruler");
    if (!sheet || !ruler || !ruler.getBoundingClientRect().width) return;
    const pxPerMm = ruler.getBoundingClientRect().width / 100;
    let z = SHOP_ZOOM_MAX;
    for (; z > SHOP_ZOOM_MIN + 1e-9; z -= SHOP_ZOOM_STEP) {
      sheet.style.zoom = z.toFixed(2);
      if (copy.getBoundingClientRect().height / pxPerMm <= PAGE_LIMIT_MM) break;
    }
    if (z <= SHOP_ZOOM_MIN + 1e-9) sheet.style.zoom = SHOP_ZOOM_MIN.toFixed(2);
  }
  function fitSheets() {
    fitShopZoom();
    fitDateVals();   // 拡大すると日付欄の幅も変わるので、zoomを決めてから測る
  }

  // 御来店日時・発送日・着日は必ず1行（店主 2026-09-02）。iPadの画面幅では
  // 「2026年9月8日（火） 09:30」が欄の右に突き抜けたので、入り切らない欄だけ
  // 文字を0.5ptずつ小さくして収める（下限7pt）。画面が隠れている間は幅が0で測れないので、
  // プレビューを開いたとき・画面幅が変わったとき・印刷の直前にも掛け直す
  function fitDateVals() {
    document.querySelectorAll("#print-sheet .date-val").forEach((el) => {
      el.style.fontSize = "";
      if (!el.clientWidth) return;
      let pt = 12;
      while (el.scrollWidth > el.clientWidth + 1 && pt > 7) {
        pt -= 0.5;
        el.style.fontSize = pt + "pt";
      }
    });
  }
  window.addEventListener("resize", fitSheets);
  window.addEventListener("beforeprint", fitSheets);

  // 下のボタンは来た経路で変える（店主指示 2026-09-01）
  //   予約一覧から: [予約一覧に戻る][編集する][保存][印刷]
  //   入力の流れ  : [編集に戻る][保存][印刷]（「編集する」は戻ると同じなので出さない）
  function updatePreviewBar() {
    const fromList = state.openedFrom === "list";
    $("#btn-preview-back").textContent = fromList ? "◀ 予約一覧へ戻る" : "◀ お客様情報へ戻る";
    // 一覧から開いたときは直したい場所に一発で入れるよう2つに分ける（案B・2026-09-03）。
    // 以前の「編集する」1つだと、商品を足す道が見つからなかった（店主指摘）
    $("#btn-preview-edit-items").classList.toggle("hidden", !fromList);
    $("#btn-preview-edit").classList.toggle("hidden", !fromList);
  }
  $("#btn-preview-back").addEventListener("click", () => {
    if (state.openedFrom !== "list") { goto("screen-customer"); return; }
    // 一覧から開いた予約を閉じて戻る。「編集する」で直して保存していないときだけ確認
    if (isDirty() && !confirm(
      "変更を保存していません。\n保存せずに予約一覧へ戻りますか？\n\n" +
      "（保存するなら【キャンセル】のあと「保存」を押してください）"
    )) return;
    resetOrder();
    goto("screen-list");
  });
  $("#btn-preview-edit").addEventListener("click", () => goto("screen-customer"));
  $("#btn-preview-edit-items").addEventListener("click", () => goto("screen-order"));

  // 支払いトグル（印刷プレビュー画面）。押すたびに紙面の表示を作り直す
  makeToggle("#paid-toggle", (val) => {
    state.info.paid = val === "済";
    renderSheet();
  });

  // ボタンの文言どおり、ここで実際に保存する（2026-09-02）。
  // 以前は保存せずプレビューへ進むだけで、印刷か「保存」を押す前に上部メニューで
  // 他の画面へ移るとお客様の入力がまるごと消えていた。
  // 保存に失敗しても印刷はさせたいので、失敗は知らせたうえでプレビューへ進む
  $("#btn-to-preview").addEventListener("click", async () => {
    const missing = [];
    if (!state.info.name.trim()) missing.push("御名前");
    if (!state.info.phone.trim()) missing.push("電話番号");
    if (missing.length) { alert(missing.join("・") + " を入力してください"); return; }
    try {
      await saveOrder();
    } catch (err) {
      console.error("save failed", err);
      alert("保存できませんでした：" + err.message + "\n印刷はできます。あとで「保存」を押し直してください");
    }
    renderSheet();
    goto("screen-preview");
  });

  /* ===== 予約の保存・一覧 ===== */
  function pad2(n) { return String(n).padStart(2, "0"); }

  // 同じ日の**最大番号＋1**を振る。「件数＋1」にすると、予約を1件削除したあとの新規保存が
  // 既存の番号と重なり、その予約を黙って上書きして消してしまう
  // （A,B保存→A削除→C保存 で B が消えるのをヘッドレスで再現 2026-09-02）。件数方式に戻さないこと
  async function nextOrderId() {
    const prefix = "o_" + (state.info.date || todayStr()).replace(/-/g, "") + "_";
    const all = await db.getAll("orders");
    const maxSeq = all
      .filter((o) => o.id.startsWith(prefix))
      .reduce((m, o) => Math.max(m, Number(o.id.slice(prefix.length)) || 0), 0);
    return prefix + String(maxSeq + 1).padStart(3, "0");
  }

  function buildOrder() {
    const i = state.info;
    const t = totals();
    return {
      id: state.currentOrderId,
      createdAt: state.orderMeta?.createdAt || new Date().toISOString(),
      date: i.date || todayStr(),
      staff: i.staff,
      customer: { name: i.name, address: i.address, phone: i.phone },
      items: state.items.map((it) => ({ productId: it.productId, name: it.name, price: it.price, qty: it.qty, note: it.note, picks: it.picks || [] })),
      total: t.price,
      totalQty: t.qty,
      delivery: {
        method: i.method,
        visitAt: i.method === "来店" && i.visitDate ? i.visitDate + (i.visitTime ? "T" + i.visitTime : "") : null,
        shipDate: i.method === "配送" ? (i.shipDate || null) : null,
        arriveDate: i.method === "配送" ? (i.arriveDate || null) : null,
      },
      noshi: { type: i.noshiType, size: i.noshiSize, omotegaki: i.omotegaki },
      packaging: i.packaging,
      packagingPicks: i.packagingPicks,
      memo: i.memo,
      paid: i.paid,
      status: state.orderMeta?.status || "受付済",
    };
  }

  async function saveOrder() {
    if (!state.currentOrderId) state.currentOrderId = await nextOrderId();
    const order = buildOrder();
    await db.put("orders", order);
    state.orderMeta = { createdAt: order.createdAt, status: order.status };
    state.savedSnapshot = snapshot();
    renderDetailHeading();
    return order;
  }

  // 以前ここにあった「受注入力へ戻るときに保存済みの予約が残っていないか確認する」処理は、
  // 入力中は上部メニューで他画面へ出られなくなった（2026-09-02・案1）ので不要になり削除した。
  // 印刷・保存は必ず入力を空にして予約一覧へ移るため、前の予約が入力画面に残ることもない
  function resetOrder() {
    state.items = [];
    state.currentOrderId = null;
    state.orderMeta = null;
    state.openedFrom = "form";
    state.savedSnapshot = null;
    state.info = {
      date: "", staff: "", name: "", address: "", phone: "",
      method: "来店", visitDate: "", visitTime: "",
      shipDate: "", arriveDate: "",
      noshiType: "なし", noshiSize: "", omotegaki: "",
      packaging: "", packagingPicks: [], memo: "", paid: false,
    };
    syncFormFromInfo();
    if (state._refreshPackaging) state._refreshPackaging();
    renderDetails();
  }

  // state.info の値をフォームの見た目（入力欄・トグルのON状態）へ反映
  function syncFormFromInfo() {
    const i = state.info;
    const setVal = (id, v) => { $(id).value = v || ""; };
    setVal("#f-date", i.date); setVal("#f-staff", i.staff);
    setVal("#f-name", i.name); setVal("#f-address", i.address); setVal("#f-phone", i.phone);
    setVal("#f-visit-date", i.visitDate); setVal("#f-visit-time", i.visitTime);
    setVal("#f-ship", i.shipDate); setVal("#f-arrive", i.arriveDate);
    setVal("#f-noshi-size", i.noshiSize); setVal("#f-omotegaki", i.omotegaki);
    setVal("#f-memo", i.memo);   // 菓子・包材は選択タグなので renderPicks 側で描く
    const setToggle = (sel, val) => {
      document.querySelectorAll(sel + " .toggle-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.val === val));
    };
    setToggle("#delivery-toggle", i.method);
    setToggle("#noshi-toggle", i.noshiType);
    setToggle("#paid-toggle", i.paid ? "済" : "未");
    $("#row-visit").classList.toggle("hidden", i.method !== "来店");
    $("#row-ship").classList.toggle("hidden", i.method !== "配送");
    document.querySelectorAll("#staff-btns .toggle-btn").forEach((b) =>
      b.classList.toggle("active", b.textContent === i.staff));
    document.querySelectorAll("#omotegaki-btns .toggle-btn").forEach((b) =>
      b.classList.toggle("active", b.textContent === i.omotegaki));
  }

  // 保存済み予約を編集用に読み込む
  function loadOrder(o) {
    state.currentOrderId = o.id;
    state.orderMeta = { createdAt: o.createdAt, status: o.status };
    state.openedFrom = "list";
    state.items = o.items.map((it) => ({ ...it }));
    const [vd, vt] = (o.delivery.visitAt || "").split("T");
    state.info = {
      date: o.date, staff: o.staff,
      name: o.customer.name, address: o.customer.address, phone: o.customer.phone,
      method: o.delivery.method, visitDate: vd || "", visitTime: vt || "",
      shipDate: o.delivery.shipDate || "", arriveDate: o.delivery.arriveDate || "",
      noshiType: o.noshi.type, noshiSize: o.noshi.size, omotegaki: o.noshi.omotegaki,
      packaging: o.packaging, packagingPicks: o.packagingPicks || [], memo: o.memo,
      paid: !!o.paid,   // 旧データ(paidなし)は未払い扱い
    };
    syncFormFromInfo();
    if (state._refreshPackaging) state._refreshPackaging();
    renderDetails();
    state.savedSnapshot = snapshot();
  }

  // 受渡日（来店なら来店日・配送なら着日）で並べる
  const deliveryDateOf = (o) => o.delivery.method === "来店"
    ? (o.delivery.visitAt || "")
    : (o.delivery.arriveDate || o.delivery.shipDate || "");

  /* 予約一覧の状態表示（店主指示 2026-09-01）
       ・「受付済／受渡済」は一字違いで紛らわしいので、画面では「まだ・済」で見せる
       ・お渡しとお支払いは別物なので、必ず見出しを付けて並べる
       ・押した瞬間に切り替わるとどちらだったか分からなくなるため、確認を挟む */
  function flagHTML(key, label, done) {
    return `<div class="o-flag" data-flag="${key}">
        <span class="of-label">${label}</span>
        <div class="btn-group">
          <button class="toggle-btn st-open${done ? "" : " active"}" data-val="未">まだ</button>
          <button class="toggle-btn st-done${done ? " active" : ""}" data-val="済">済</button>
        </div>
      </div>`;
  }

  async function toggleFlag(o, key, toDone) {
    const label = key === "hand" ? "お渡し" : "お支払い";
    const now = key === "hand" ? o.status === "受渡済" : !!o.paid;
    if (toDone === now) return;   // 今と同じ側を押しただけ
    const who = o.customer.name ? `${o.customer.name} 様の予約` : "この予約";
    if (!confirm(`${who}を\n「${label}：${toDone ? "済" : "まだ"}」にしますか？`)) return;
    if (key === "hand") o.status = toDone ? "受渡済" : "受付済";
    else o.paid = toDone;
    await db.put("orders", o);
    // 同じ予約を印刷プレビューで開いたままなら、そちらの控えも合わせておく。
    // ずれたまま「保存」を押すと一覧での変更が巻き戻ってしまう
    if (state.currentOrderId === o.id) {
      state.info.paid = !!o.paid;
      state.orderMeta = { createdAt: o.createdAt, status: o.status };
      syncFormFromInfo();
      renderSheet();
    }
    renderOrderList();
  }

  async function renderOrderList() {
    const ul = $("#order-list");
    const orders = (await db.getAll("orders"))
      .filter((o) => state.listFilter === "all"
        || (state.listFilter === "undelivered" ? o.status === "受付済" : o.status === "受渡済"))
      .sort((a, b) => (deliveryDateOf(a) || "9999").localeCompare(deliveryDateOf(b) || "9999"));
    ul.innerHTML = "";
    if (orders.length === 0) {
      ul.innerHTML = '<li class="none">予約はありません</li>';
      return;
    }
    orders.forEach((o) => {
      const li = document.createElement("li");
      const dd = deliveryDateOf(o);
      const [d, tm] = dd.split("T");
      const dateLabel = d ? `${fmtDateJa(d)}${tm ? " " + tm : ""}` : "受渡日未定";
      li.innerHTML =
        `<div class="o-main">
           <span class="o-date">${dateLabel}<span class="o-method">${o.delivery.method}</span></span>
           <span class="o-sub">${esc(o.customer.name)} 様　${esc(o.customer.phone)}</span>
         </div>
         <span class="o-total">${yen(o.total)}</span>
         <div class="o-flags">
           ${flagHTML("hand", "お渡し", o.status === "受渡済")}
           ${flagHTML("pay", "お支払い", !!o.paid)}
         </div>
         <div class="o-actions">
           <button class="o-open">開く・再印刷</button>
           <button class="o-del">削除</button>
         </div>`;
      li.querySelector(".o-open").addEventListener("click", () => {
        loadOrder(o);
        renderSheet();
        goto("screen-preview");
      });
      li.querySelectorAll(".o-flag").forEach((box) => {
        box.addEventListener("click", (ev) => {
          const btn = ev.target.closest(".toggle-btn");
          if (btn) toggleFlag(o, box.dataset.flag, btn.dataset.val === "済");
        });
      });
      li.querySelector(".o-del").addEventListener("click", async () => {
        if (!confirm(`${o.customer.name} 様の予約（${yen(o.total)}）を削除しますか？`)) return;
        await db.delete("orders", o.id);
        if (state.currentOrderId === o.id) resetOrder();
        renderOrderList();
      });
      ul.appendChild(li);
    });
  }

  makeToggle("#list-filter", (val) => {
    state.listFilter = val;
    renderOrderList();
  });

  // 印刷を押した時点でその注文は「終わり」（店主 2026-09-02）。保存して印刷し、印刷の窓が
  // 閉じたら「印刷済み表示」に切り替える（案C・2026-09-03）: 承り表はそのまま残し、下のボタンを
  // 「予約一覧へ」「次の予約を入力する」の2つにする。すぐ一覧へ飛ばすと、いま何を印刷したのか
  // 分からなくなる、との店主指摘のため。どちらのボタンも入力を空にする。
  // 「閉じた」合図は afterprint。iPad Safariで飛ばない場合に備えて matchMedia("print") も見る。
  // どちらも来なければ普通のボタンのまま（保存→一覧 で終えられる。実機で確認のうえ判断）
  let printing = false;
  function setPrintedMode(on) {
    $("#screen-preview").classList.toggle("printed", on);
    $("#printed-bar").classList.toggle("hidden", !on);
  }
  function afterPrintDone() {
    if (!printing) return;
    printing = false;
    setPrintedMode(true);
  }
  $("#btn-printed-list").addEventListener("click", () => { resetOrder(); goto("screen-list"); });
  $("#btn-printed-next").addEventListener("click", () => { resetOrder(); goto("screen-order"); });
  window.addEventListener("afterprint", afterPrintDone);
  if (window.matchMedia) {
    const mq = window.matchMedia("print");
    const onChange = (e) => { if (!e.matches) setTimeout(afterPrintDone, 0); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  $("#btn-print").addEventListener("click", async () => {
    closeKeyboard();
    await saveOrder();
    printing = true;
    window.print();
  });
  // 「保存」も同じく注文の区切り。一覧から来ても入力の流れでも予約一覧へ
  $("#btn-save-only").addEventListener("click", async () => {
    await saveOrder();
    alert("保存しました");
    resetOrder();
    goto("screen-list");
  });

  /* ===== 設定画面（バックアップ・アプリの状態） ===== */
  const LAST_BACKUP_KEY = "lastBackupAt";

  async function renderSettings() {
    const el = $("#backup-status");
    try {
      const orders = await db.getAll("orders");
      const rec = await db.getAll("settings");
      const last = rec.find((r) => r.key === LAST_BACKUP_KEY);
      const lastLabel = last
        ? `${fmtDateJa(last.value.slice(0, 10))} ${last.value.slice(11, 16)}`
        : "まだ一度も書き出していません";
      el.innerHTML =
        `<div>保存されている予約：<b>${orders.length}</b> 件</div>` +
        `<div>最後に書き出した日：<b>${esc(lastLabel)}</b></div>`;
    } catch {
      el.textContent = "データを読み取れませんでした";
    }
    await renderOfflineStatus();
    $("#staff-edit").value = state.master.staff.join("\n");
    await renderMasterEditor();
  }

  // アプリ本体が何ファイルiPadに入っているかを数える。
  // 登録済みでも中身が空なら「Wi-Fiなしで起動できる」と言えないため、実数で見る。
  async function cachedFileCount() {
    if (!("caches" in window)) return 0;
    let n = 0;
    for (const key of await caches.keys()) {
      if (!key.startsWith("uketamawari")) continue;
      const c = await caches.open(key);
      n += (await c.keys()).length;
    }
    return n;
  }

  async function renderOfflineStatus() {
    const el = $("#offline-status");
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    const lines = ["この iPad で動いているアプリの版：" + APP_VERSION];
    if (!("serviceWorker" in navigator) || location.protocol === "file:") {
      lines.push("この開き方ではオフライン保存は使えません（動作確認用の表示です）");
    } else {
      const n = await cachedFileCount().catch(() => 0);
      if (n > 0 && navigator.serviceWorker.controller) {
        lines.push(`✓ アプリはiPadに保存済みです（${n}ファイル）。Wi-Fiがなくても起動できます`);
      } else if (n > 0) {
        lines.push(`アプリを保存しました（${n}ファイル）。一度閉じて開き直すと有効になります`);
      } else {
        lines.push("⚠ まだiPadに保存できていません。Wi-Fiに繋いで開き直してください");
      }
    }
    lines.push(standalone
      ? "✓ ホーム画面のアイコンから起動しています"
      : "※ ブラウザで開いています。「ホーム画面に追加」して使ってください");
    lines.push(navigator.onLine ? "ネット接続：あり" : "ネット接続：なし（予約入力は使えます）");
    el.innerHTML = lines.map((s) => `<div>${esc(s)}</div>`).join("");
  }

  $("#btn-export").addEventListener("click", async () => {
    let file;
    try {
      file = await backup.prepare();
      // 保存ダイアログを出すと後続処理が中断されることがあるので、
      // 記録と画面更新を先に済ませてからダウンロードを始める。
      // このため保存をキャンセルしても記録は更新される（＝「書き出した日」は
      // 厳密には「書き出し操作をした日」）。順序を入れ替えると記録自体が
      // 残らなくなるので、この割り切りを承知の上で変えないこと。
      await db.put("settings", { key: LAST_BACKUP_KEY, value: new Date().toISOString() });
      await renderSettings();
      await updateBackupBanner();
    } catch (err) {
      console.error("export failed", err);
      alert("書き出しに失敗しました：" + err.message);
      return;
    }
    backup.download(file);
    alert(`予約 ${file.counts.orders} 件を書き出します。\n保存先にお店のパソコンの共有フォルダを選んでください。`);
  });

  /* ===== バックアップ促しバナー ===== */
  const BACKUP_REMIND_DAYS = 7;

  // バナーに出す文言を返す。出す必要がなければ null。
  // confirm等を含まない純関数にしてNodeでテストできるようにしてある
  function backupReminderText(lastIso, orderCount, nowMs) {
    if (orderCount === 0) return null;   // 守るデータがなければ急かさない
    const lastMs = lastIso ? new Date(lastIso).getTime() : NaN;
    if (isNaN(lastMs)) return "まだ一度もバックアップを書き出していません";
    const days = Math.floor((nowMs - lastMs) / 86400000);
    if (days < BACKUP_REMIND_DAYS) return null;
    return `バックアップを${days}日間書き出していません`;
  }

  async function updateBackupBanner() {
    const el = $("#backup-banner");
    if (el.dataset.dismissed) return;   // 「閉じる」を押したら次の起動まで出さない
    try {
      const orders = await db.getAll("orders");
      const rec = await db.getAll("settings");
      const last = rec.find((r) => r.key === LAST_BACKUP_KEY);
      const msg = backupReminderText(last ? last.value : null, orders.length, Date.now());
      // DB読み取りの間に「閉じる」が押されていたら再表示しない
      if (el.dataset.dismissed) return;
      if (!msg) { el.classList.add("hidden"); return; }
      $("#backup-banner-msg").textContent = "⚠ " + msg;
      el.classList.remove("hidden");
    } catch { /* バナーが出せなくても営業は止めない */ }
  }

  $("#backup-banner-go").addEventListener("click", () => goto("screen-master"));
  $("#backup-banner-close").addEventListener("click", () => {
    const el = $("#backup-banner");
    el.dataset.dismissed = "1";
    el.classList.add("hidden");
  });

  // 復元はデータが消えたときの非常用。誤操作で普段使いされないよう入口で一段止める
  $("#btn-import").addEventListener("click", () => {
    if (!confirm(
      "「バックアップから戻す」は、iPadのデータが消えてしまったときの復元用です。\n" +
      "ふだんの営業では使いません。\n\n続けますか？"
    )) return;
    $("#import-file").click();
  });

  // 読み込み方を3択で尋ねる。confirmは2択しか出せないので順に聞く。
  // 戻り値: "replace" | "merge" | null（null=やめる）
  // ask は confirm 相当（テストから差し替えられるよう引数で受ける）
  function askImportMode(payload, ask) {
    const n = payload.counts?.orders ?? (payload.data.orders || []).length;
    const when = payload.exportedAt
      ? payload.exportedAt.slice(0, 16).replace("T", " ") : "不明";

    // 1段目: そもそも読み込むか（間違ったファイルを選んだときの逃げ道）
    if (!ask(
      `このファイルには予約が ${n} 件入っています。\n` +
      `書き出した日時: ${when}\n\n` +
      `このファイルを読み込みますか？\n` +
      `【OK】読み込む　【キャンセル】やめる`
    )) return null;

    // 2段目: 入れ替えか追加か
    const replace = ask(
      `読み込み方を選んでください。\n\n` +
      `【OK】今あるデータを全部消して、このファイルの内容に入れ替える\n` +
      `【キャンセル】今あるデータは残したまま、このファイルの分を追加する`
    );
    if (!replace) return "merge";

    // 3段目: 全消しは取り返しがつかないので最終確認
    if (!ask("本当に今のデータを全部消して入れ替えますか？この操作は取り消せません。")) return null;
    return "replace";
  }

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";   // 同じファイルを続けて選べるようにする
    if (!file) return;
    try {
      const payload = backup.parse(await file.text());
      const mode = askImportMode(payload, confirm);
      if (!mode) return;
      const res = await backup.importPayload(payload, mode);
      resetOrder();
      // 商品マスタも入れ替わるので必ず読み直す。
      // これを忘れると、復元直後は画面が復元前の商品・値段のまま残る
      await reloadMaster();
      await updateBackupBanner();
      alert(`読み込みました（予約 ${res.orders} 件）`);
    } catch (err) {
      alert("読み込めませんでした：" + err.message);
    }
  });

  // アプリ本体を入れ直す。
  // 直したはずの修正がiPadに届かない事故（Service Workerが古いキャッシュを返し続ける）が
  // 起きるため、店主が自分で押して直せる逃げ道を用意しておく。
  // 消すのはアプリのファイルだけ。予約と商品はIndexedDBにあるので触らない。
  $("#btn-update-app").addEventListener("click", async () => {
    if (!navigator.onLine) {
      alert("Wi-Fiに繋がっていません。\n繋がってからもう一度押してください。");
      return;
    }
    if (!confirm(
      "アプリの中身を最新のものに入れ直します。\n" +
      "予約データ・商品の設定は消えません。\n\n続けますか？"
    )) return;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("uketamawari-")).map((k) => caches.delete(k)));
    } catch (err) {
      console.error("update failed", err);   // 消せなくても読み込み直しは試す
    }
    location.reload();
  });

  window.addEventListener("online", renderOfflineStatus);
  window.addEventListener("offline", renderOfflineStatus);

  /* ===== 商品マスタ編集（設定画面） ===== */
  let masterTab = null;      // 一覧で開いているタブ
  let editing = null;        // 編集中の商品（新規はid未発行）

  async function renderMasterEditor() {
    const all = await master.loadAll();
    const cats = state.master.categories;
    if (!masterTab || !cats.includes(masterTab)) masterTab = cats[0];

    const tabs = $("#master-tabs");
    tabs.innerHTML = "";
    cats.forEach((c) => {
      const n = all.filter((p) => p.category === c).length;
      const b = document.createElement("button");
      b.className = "picker-tab" + (c === masterTab ? " active" : "");
      b.textContent = `${c}（${n}）`;
      b.addEventListener("click", () => { masterTab = c; renderMasterEditor(); });
      tabs.appendChild(b);
    });

    const list = $("#master-list");
    list.innerHTML = "";
    const rows = all.filter((p) => p.category === masterTab);
    if (!rows.length) {
      list.innerHTML = '<div class="picker-none">この置き場所に商品がありません</div>';
      return;
    }
    rows.forEach((p) => {
      const row = document.createElement("button");
      row.className = "master-row" + (p.active ? "" : " off");
      row.innerHTML =
        `<span class="m-name">${esc(p.name)}</span>` +
        `<span class="m-price">${p.price == null ? "その都度入力" : yen(p.price)}</span>` +
        (p.active ? "" : '<span class="m-off">かくす</span>');
      row.addEventListener("click", () => openEditor(p));
      list.appendChild(row);
    });
  }

  function openEditor(p) {
    editing = p ? { ...p } : {
      id: null, name: "", price: null, category: masterTab || state.master.categories[0],
      active: true, sweet: false, packaging: false, sortOrder: 99999,
    };
    // 配列は複製しておく（「やめる」で一覧側のオブジェクトを汚さないため）
    editing.fixedPicks = (editing.fixedPicks || []).map((x) => ({ ...x }));
    renderEditorPicks();
    $("#edit-title").textContent = p ? "商品の編集" : "商品の追加";
    $("#edit-delete").style.display = p ? "" : "none";
    $("#e-name").value = editing.name;
    $("#e-price").value = editing.price == null ? "" : editing.price;
    // 新規追加は値段を入れるのが普通なので「その都度入力」は既存商品のときだけ引き継ぐ
    const manual = !!p && p.price == null;
    $("#e-price-manual").checked = manual;
    $("#e-price").disabled = manual;

    const sel = $("#e-category");
    sel.innerHTML = "";
    state.master.categories.forEach((c) => {
      const o = document.createElement("option");
      o.value = c; o.textContent = c;
      if (c === editing.category) o.selected = true;
      sel.appendChild(o);
    });
    $("#e-sweet").checked = !!editing.sweet;
    $("#e-packaging").checked = !!editing.packaging;
    document.querySelectorAll("#e-active-toggle .toggle-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.val === (editing.active ? "表示" : "非表示")));
    goto("screen-edit");
  }

  function closeEditor() {
    editing = null;
    goto("screen-master");
  }

  // 「詰合せの中身」欄。タグの操作は明細の商品内容と同じ（＋で足す／タップで消す）。
  // 空のときは、価格表の記載から何が読み取れるかを見せて、1タップで取り込めるようにする
  // 店主の指摘（2026-09-02）: 空欄のときは価格表の読み取りがそのまま自動で入るので
  // 「取り込む」ボタンは要らない。要るのは**手で変えた後に価格表の記載へ戻したいとき**。
  // 戻すと今の設定が消えるので、押した瞬間には変えず必ず確認を出す
  function renderEditorPicks() {
    if (!editing) return;
    renderPicks($("#e-picks"), editing.fixedPicks, renderEditorPicks);
    const hint = $("#e-picks-hint");
    const btn = $("#e-picks-import");
    const parsed = autoPicksFromContents(editing);
    const manual = editing.fixedPicks.length > 0;
    if (manual && parsed) {
      hint.textContent = "注文に追加すると、この中身が商品内容に自動で入ります（価格表の記載: " + fmtPicksInline(parsed) + "）";
    } else if (manual) {
      hint.textContent = "注文に追加すると、この中身が商品内容に自動で入ります";
    } else if (parsed) {
      hint.textContent = "価格表の記載どおり自動で入ります: " + fmtPicksInline(parsed) + "　※変えたいときだけ上で選び直してください";
    } else if (editing.contents) {
      hint.textContent = `価格表の記載「${editing.contents}」は自動で読み取れません。ここで中身を選んでください`;
    } else {
      hint.textContent = "詰合せなら中身を選んでおくと、注文に追加した瞬間に商品内容へ自動で入ります";
    }
    const showReset = manual && !!parsed;
    btn.classList.toggle("hidden", !showReset);
    btn.onclick = showReset ? () => {
      if (!confirm(
        "詰合せの中身を、価格表の記載に戻します。\n\n" +
        "今ここで選んでいる中身（" + fmtPicksInline(editing.fixedPicks) + "）は消えます。\n" +
        "価格表の記載: " + fmtPicksInline(parsed) + "\n\n戻しますか？"
      )) return;
      editing.fixedPicks = [];
      renderEditorPicks();
    } : null;
  }
  $("#e-pick-add").addEventListener("click", () => {
    if (!editing) return;
    picker.open({
      title: `${$("#e-name").value.trim() || "この商品"} の中身`,
      kind: "sweet",
      onPick: (p) => { editing.fixedPicks.push(p); renderEditorPicks(); },
    });
  });

  $("#e-price-manual").addEventListener("change", (e) => {
    $("#e-price").disabled = e.target.checked;
    if (e.target.checked) $("#e-price").value = "";
  });
  makeToggle("#e-active-toggle", (val) => { if (editing) editing.active = val === "表示"; });
  $("#edit-cancel").addEventListener("click", closeEditor);

  $("#edit-save").addEventListener("click", async () => {
    const name = $("#e-name").value.trim();
    if (!name) { alert("商品名を入れてください"); return; }
    const manual = $("#e-price-manual").checked;
    const priceRaw = $("#e-price").value.trim();
    if (!manual && priceRaw === "") { alert("値段を入れてください（決まっていなければ「その都度入力する」）"); return; }
    const price = manual ? null : Number(priceRaw);
    if (price != null && (isNaN(price) || price < 0)) { alert("値段は0以上の数字で入れてください"); return; }

    const p = {
      ...editing,
      id: editing.id || master.newId(),
      name, price,
      category: $("#e-category").value,
      sweet: $("#e-sweet").checked,
      packaging: $("#e-packaging").checked,
      fixedPicks: editing.fixedPicks.length ? editing.fixedPicks : null,
    };
    await master.save(p);
    await reloadMaster();
    closeEditor();
  });

  $("#edit-delete").addEventListener("click", async () => {
    if (!editing || !editing.id) return;
    if (!confirm(`「${editing.name}」を削除しますか？\n\n※過去の予約に載った分はそのまま残ります。\n　使わないだけなら「かくす」をおすすめします。`)) return;
    await master.remove(editing.id);
    await reloadMaster();
    closeEditor();
  });

  $("#btn-add-product").addEventListener("click", () => openEditor(null));

  $("#btn-reseed").addEventListener("click", async () => {
    if (!confirm(
      "商品の一覧を、アプリに入っている価格表の内容に戻します。\n\n" +
      "お店で足した商品や、直した値段は消えます。\n（予約・担当者・詰合せの中身の設定は残ります）\n続けますか？"
    )) return;
    if (!confirm("本当に戻しますか？この操作は取り消せません。")) return;
    await master.reseed();
    await reloadMaster();
    alert("価格表の内容に戻しました");
  });

  $("#btn-save-staff").addEventListener("click", async () => {
    const list = $("#staff-edit").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!list.length) { alert("担当者を1人以上入れてください"); return; }
    await master.setStaff(list);
    await reloadMaster();
    alert("担当者を保存しました");
  });

  // マスタを読み直して、受注画面と設定画面の両方を描き直す
  async function reloadMaster() {
    state.master = await master.load();
    if (!state.master.categories.includes(state.currentCategory)) {
      state.currentCategory = state.master.categories[0];
    }
    renderStaffButtons();
    renderTabs();
    renderGrid();
    await renderMasterEditor();
    $("#staff-edit").value = state.master.staff.join("\n");
  }

  /* ===== 起動 ===== */
  // アプリ一式をiPadに保存してWi-Fiなしで起動できるようにする。
  // file:// で開いた動作確認時は登録できないので黙って飛ばす。
  // ?nosw=1 は動作確認用。付けないとローカルサーバでの検証中に
  // 古いキャッシュが返り続け、直したCSSやJSを見ているつもりで見ていない事故が起きる
  if ("serviceWorker" in navigator && location.protocol !== "file:"
      && !location.search.includes("nosw")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  master.load().then((m) => {
    state.master = m;
    state.currentCategory = m.categories[0];
    initCustomerForm();
    updateBackupBanner();   // 起動時にバックアップの間隔をチェック
    // ?demo=1 でダミーデータを投入（スクリーンショット・動作確認用）
    if (location.search.includes("demo")) {
      state.items = [
        { productId: "p_002", name: "最中 5個", price: 1600, qty: 2, note: "", picks: [] },
        // 中身の多い詰合せ＝紙面の高さが一番きつくなる例。レイアウト確認用に残しておく
        { productId: "p_039", name: "丸円堂詰合せ2", price: 2460, qty: 1, note: "",
          picks: [{ id: "p_001", name: "最中", qty: 9 }, { id: "p_005", name: "中津の笑くぼ", qty: 10 },
                  { id: "p_010", name: "丸ぼうろ", qty: 6 }, { id: "p_014", name: "もなろん", qty: 4 }] },
        { productId: "p_054", name: "大福", price: 140, qty: 10, note: "", picks: [] },
      ];
      state.items.forEach((it) => { it.note = fmtPicks(it.picks); });
      state.info.packagingPicks = [{ id: "p_072", name: "階段10", qty: 3 },
                                   { id: "p_076", name: "紙袋", qty: 2 }];
      state.info.packaging = fmtPicks(state.info.packagingPicks);
      state.currentCategory = "箱 店内";
      Object.assign(state.info, {
        name: "山田 花子", phone: "0312345678", staff: "担当A",
        visitDate: todayStr(), visitTime: "10:00",
        noshiType: "内", omotegaki: "御祝",
        // 改行が紙に出るかを毎回見られるように、備考は複数行にしてある
        memo: "紙袋2枚\n熨斗は当日お渡し\n夕方以降に来店予定",
      });
      ["#f-name", "#f-phone", "#f-staff"].forEach((id, k) => {
        $(id).value = [state.info.name, state.info.phone, state.info.staff][k];
      });
      $("#f-visit-date").value = state.info.visitDate;
      $("#f-visit-time").value = state.info.visitTime;
      $("#f-memo").value = state.info.memo;
    }
    renderTabs();
    renderGrid();
    renderDetails();
    // ?demo=1&selftest=1 でデモ予約を保存→一覧表示（保存機能の動作確認用）
    if (location.search.includes("selftest")) {
      saveOrder().then(() => goto("screen-list"));
      return;
    }
    // ?screen=screen-xxx で指定画面を直接開く（スクリーンショット用）
    const params = new URLSearchParams(location.search);
    const scr = params.get("screen");
    if (scr && $("#" + scr)) {
      if (scr === "screen-preview") renderSheet();
      goto(scr);
    }
    // ?tap=ボタンID でそのボタンを自動タップ（ボタン経由の動作確認用）
    const tap = params.get("tap");
    if (tap && $("#" + tap)) setTimeout(() => $("#" + tap).click(), 100);
  });
})();
