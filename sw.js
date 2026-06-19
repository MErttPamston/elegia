// sw.js — Элегия Service Worker
// Версия: 3.7
// Живёт в браузере постоянно (пока сам не выгружен).
// Проверяет напоминания каждую минуту и шлёт Push + Telegram.

const DB_NAME = 'elegia_sw_db';
const DB_VERSION = 1;
const CHECK_INTERVAL_MS = 60000; // проверяем каждую минуту

// ── IndexedDB helpers ────────────────────────────────────────────────────────
function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('data')) {
        db.createObjectStore('data');
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}
async function dbGet(key) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('data', 'readonly');
    const req = tx.objectStore('data').get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('data', 'readwrite');
    tx.objectStore('data').put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ── Telegram отправка ────────────────────────────────────────────────────────
async function sendTelegram(account, noteObj) {
  if (!account || !account.token || !account.chatid) return;
  const title = noteObj.title || '(без названия)';
  let msg = '⏰ <b>Напоминание — Элегия</b>\n\n📌 <b>' + title + '</b>';
  const plain = (noteObj.plainText || '').trim();
  if (plain && plain !== title) msg += '\n📝 ' + plain.slice(0, 200) + (plain.length > 200 ? '…' : '');
  const due = noteObj.reminder || noteObj.datetime || (noteObj.date ? noteObj.date + (noteObj.time ? 'T' + noteObj.time : '') : '');
  if (due) {
    try {
      const d = new Date(due);
      const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      msg += '\n📆 Срок: ' + dateStr + ', ' + timeStr;
    } catch(e) {}
  }
  if (noteObj.recurRule) msg += '\n🔄 Повторение: ' + noteObj.recurRule;
  if (noteObj.tags && noteObj.tags.length) msg += '\n🏷️ Теги: ' + noteObj.tags.join(', ');
  try {
    await fetch('https://api.telegram.org/bot' + account.token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: account.chatid, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) {}
}

// ── Проверка напоминаний ──────────────────────────────────────────────────────
async function checkReminders() {
  const notes = await dbGet('notes');
  const account = await dbGet('tg_account');
  const fired = (await dbGet('sw_fired')) || {};
  if (!Array.isArray(notes)) return;
  const now = Date.now();
  let changed = false;
  for (const n of notes) {
    if (!n.reminder || n.done) continue;
    const t = new Date(n.reminder).getTime();
    if (isNaN(t)) continue;
    const key = n.id + '_' + n.reminder;
    if (t <= now && !fired[key]) {
      fired[key] = true;
      changed = true;
      // Показываем Push-уведомление браузера
      try {
        await self.registration.showNotification('Напоминание — Элегия', {
          body: n.title || '(без названия)',
          icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⏰</text></svg>',
          tag: 'elegia-' + n.id,
          renotify: true,
          requireInteraction: true,
          data: { noteId: n.id }
        });
      } catch(e) {}
      // Отправляем в Telegram
      if (account) await sendTelegram(account, n);
    }
  }
  // Очищаем старые ключи (старше 7 дней)
  const cutoff = now - 7 * 24 * 3600 * 1000;
  for (const key of Object.keys(fired)) {
    const parts = key.split('_');
    const iso = parts[parts.length - 1];
    if (iso && new Date(iso).getTime() < cutoff) { delete fired[key]; changed = true; }
  }
  if (changed) await dbSet('sw_fired', fired);
}

// ── SW события ───────────────────────────────────────────────────────────────
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

// Периодическая проверка через setInterval внутри SW
let _checkTimer = null;
function startChecking() {
  if (_checkTimer) return;
  checkReminders();
  _checkTimer = setInterval(checkReminders, CHECK_INTERVAL_MS);
}

self.addEventListener('activate', () => { startChecking(); });

// Команды от основной страницы
self.addEventListener('message', async e => {
  if (e.data?.type === 'UPDATE_NOTES') {
    await dbSet('notes', e.data.notes);
    startChecking();
  }
  if (e.data?.type === 'UPDATE_TG') {
    await dbSet('tg_account', e.data.account);
  }
  if (e.data?.type === 'PING') {
    e.source?.postMessage({ type: 'PONG' });
    startChecking();
  }
});

// Клик по Push-уведомлению — открывает вкладку
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const noteId = e.notification.data?.noteId;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        if (noteId) clients[0].postMessage({ type: 'OPEN_NOTE', noteId });
      } else {
        self.clients.openWindow('./');
      }
    })
  );
});
