// Service worker for meso.poker. It exists ONLY so nudge notifications work
// on Android Chrome, where page-scoped `new Notification()` is not allowed
// and notifications must be posted via a registration — see
// showNudgeNotification in poker.js, which registers this worker lazily when
// the bell is switched on. Deliberately no fetch handler: nothing is
// intercepted or cached, so the app's serving behaviour is unchanged.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Focus (or reopen) the poker tab when a nudge notification is clicked.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => "focus" in c);
      return client ? client.focus() : self.clients.openWindow("./");
    }),
  );
});
