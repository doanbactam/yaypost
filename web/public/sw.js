// Yaypost service worker: shows push reminders and routes clicks back into the app (or out to x.com).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const tag = payload.tag || "yaypost";
  const requireInteraction = payload.requireInteraction ?? tag.startsWith("due-");
  event.waitUntil(
    self.registration.showNotification(payload.title || "Yaypost", {
      body: payload.body || "",
      tag,
      renotify: true,
      requireInteraction,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: payload.url || "/", postId: payload.postId ?? null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      // Links off-site (e.g. "Posted to X" → x.com) open in a new window.
      if (target.origin !== self.location.origin) return self.clients.openWindow(target.href);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        await client.focus();
        return client.navigate(target.href).catch(() => self.clients.openWindow(target.href));
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
