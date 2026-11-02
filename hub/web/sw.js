// metacom's service worker: push alerts from the hub (hub/lib/push.js). An agent that needs you
// arrives with its options as buttons where the platform has them (one tap answers, through the
// capability in the alert); a tap anywhere else opens its room. iPhones show no buttons: the tap
// opens the room, where you reply with the number.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d;
  try {
    d = e.data.json();
  } catch {
    d = { title: 'metacom', body: e.data ? e.data.text() : '', url: '/' };
  }
  const max = (self.Notification && Notification.maxActions) || 2;
  const actions = d.cap ? (d.options || []).slice(0, max).map((title, i) => ({ action: String(i + 1), title })) : [];
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.where ? `${d.body}\n— ${d.where}` : d.body,
      tag: d.tag,
      renotify: true,
      requireInteraction: d.kind === 'blocked',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      actions,
      data: d,
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  e.notification.close();
  if (e.action && d.cap) {
    const answer = fetch('/push/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ c: d.cap, n: Number(e.action) }) })
      .then((r) => r.json())
      .catch(() => ({ ok: false, text: 'The hub could not be reached.' }))
      .then((r) => self.registration.showNotification(r.ok ? 'Answered' : 'Not answered', { body: r.text, tag: d.tag, icon: '/icon-192.png' }));
    e.waitUntil(answer);
    return;
  }
  const url = new URL(d.url || '/', self.location.origin);
  const path = url.origin === self.location.origin ? url.pathname : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) return open.navigate(path).then((c) => (c || open).focus());
      return self.clients.openWindow(path);
    }),
  );
});
