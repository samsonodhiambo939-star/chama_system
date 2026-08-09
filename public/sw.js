self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function() { self.clients.claim(); });
self.addEventListener('fetch', function() {});

self.addEventListener('push', function(event) {
  var data = event.data ? event.data.json() : {};
  var title = data.title || 'Apwoche Chama';
  var options = {
    body: data.message || 'New notification from Apwoche Chama',
    icon: '/icons/icon-192.svg',
    badge: '/icons/icon-192.svg',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = event.notification.data.url;
  event.waitUntil(clients.openWindow(url));
});