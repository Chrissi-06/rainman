self.addEventListener('push', (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Rainman', body: event.data?.text() || 'Neue Rainman-Meldung' };
  }

  const title = data.title || 'Rainman';
  const options = {
    body: data.body || 'Neue Rainman-Meldung',
    icon: '/Rainman.png',
    badge: '/Rainman.png',
    data: { url: data.url || '/' },
    tag: data.tag || 'rainman',
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
