// 서비스 워커: 앱이 닫혀 있어도 푸시 알림을 표시합니다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "복습해라", body: event.data ? event.data.text() : "" }; }
  event.waitUntil((async () => {
    // 앱 화면이 보이는 중이면 앱 안의 알림(토스트)이 대신하므로 중복 표시하지 않음
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === "visible")) return;
    await self.registration.showNotification(d.title || "복습해라", {
      body: d.body || "",
      tag: d.tag,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { url: d.url || "#/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "#/", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      try { await c.focus(); await c.navigate(url); return; } catch { /* 다음 방법 */ }
    }
    await self.clients.openWindow(url);
  })());
});
