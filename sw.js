// Service Worker: アプリ一式をiPadに保存し、Wi-Fiなしでも起動できるようにする。
// 顧客データはIndexedDB側にあり、ここでは一切扱わない（キャッシュ対象はアプリのファイルのみ）。
//
// 更新手順: ファイルを変更したら必ず CACHE の数字を上げる。
// 上げ忘れると古いキャッシュが返り続け、iPadに修正が反映されない。
// js/app.js の APP_VERSION と必ず揃えること（設定画面に出す版番号がずれる）
const CACHE = "uketamawari-v37";

const ASSETS = [
  "./",            // 公開URLは末尾スラッシュ（.../uketamawari/）で開かれる
  "./index.html",
  "./css/app.css",
  "./css/print.css",
  "./data/products.js",
  "./js/db.js",
  "./js/master.js",
  "./js/backup.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // 1つでも欠けると全体が失敗するので個別に入れる（アイコン追加時の事故防止）。
  // ただし黙って全滅するとオフライン起動できなくなるため、失敗は必ず記録する。
  e.waitUntil((async () => {
    let cache;
    try {
      cache = await caches.open(CACHE);
    } catch (err) {
      // キャッシュが使えない端末。オフライン起動は諦めるが、アプリ自体は動かす
      console.error("[sw] キャッシュを開けません:", err.message);
      await self.skipWaiting();
      return;
    }
    // addAll は1件でもこけると全滅するので使わない。1件ずつ入れて、
    // 失敗したものだけ記録する（残りはオフラインで使える状態を保つ）。
    const failed = [];
    for (const u of ASSETS) {
      try {
        const res = await fetch(u, { cache: "reload" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await cache.put(u, res);
      } catch (err) {
        failed.push(u + " (" + err.message + ")");
      }
    }
    if (failed.length) console.error("[sw] キャッシュできず:", failed);
    console.log("[sw] install 完了", (await cache.keys()).length + "/" + ASSETS.length);
    await self.skipWaiting();
  })());
});

// 古い版のキャッシュを片付ける。
// CacheStorageはオリジン(github.io)全体で共有され、SWのscopeでは仕切られない。
// 「CACHE以外を全部消す」と書くと、同じPagesに別アプリを置いたとき
// 互いのオフラインデータを消し合うので、自分の名前で始まるものだけを対象にする。
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("uketamawari-") && k !== CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // キャッシュ優先。オフラインで確実に起動することを最優先にする。
  e.respondWith((async () => {
    // キャッシュ機構自体が使えないことがある（容量不足・プライベートモード等）。
    // ここで例外を素通しするとページ全体が開けなくなるので、必ず握って通信に逃がす。
    let cache = null;
    try {
      cache = await caches.open(CACHE);
      // ignoreSearch必須。index.html?demo=1 のようにクエリが付くと
      // 完全一致では当たらず、オフライン時に起動できなくなる。
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
    } catch (err) {
      console.error("[sw] キャッシュを読めません。通信で取得します:", err.message);
    }

    // ここで取得結果をキャッシュに書き戻さないこと。
    // install の書き込みと同じURLで競合し、"Entry already exists" で
    // 事前キャッシュが全滅する。必要なファイルは ASSETS で網羅している。
    try {
      return await fetch(req);
    } catch (err) {
      // 通信不能。画面の読み込みなら、とにかくアプリ本体を返して起動させる
      if (req.mode === "navigate" && cache) {
        const shell = await cache.match("./index.html").catch(() => null);
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
