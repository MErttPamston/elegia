// server.js — Элегия: фоновые Telegram-уведомления
// Деплоится на Render.com (бесплатно).
// Хранит заметки в памяти (получает их от браузера через /sync).
// Каждую минуту проверяет напоминания и шлёт в Telegram.

const http = require('http');
const PORT = process.env.PORT || 3000;

// ── Хранилище ─────────────────────────────────────────────────────────────────
// Ключ — chatid пользователя, значение — { notes, account, fired }
const store = new Map();

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(account, noteObj) {
  if (!account?.token || !account?.chatid) return;
  const title = noteObj.title || '(без названия)';
  let msg = `⏰ <b>Напоминание — Элегия</b>\n\n📌 <b>${title}</b>`;
  const plain = (noteObj.plainText || '').trim();
  if (plain && plain !== title) msg += `\n📝 ${plain.slice(0, 200)}${plain.length > 200 ? '…' : ''}`;
  const due = noteObj.reminder || noteObj.datetime || (noteObj.date ? noteObj.date + (noteObj.time ? 'T' + noteObj.time : '') : '');
  if (due) {
    try {
      const d = new Date(due);
      const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      msg += `\n📆 Срок: ${dateStr}, ${timeStr}`;
    } catch (e) {}
  }
  if (noteObj.recurRule) msg += `\n🔄 Повторение: ${noteObj.recurRule}`;
  if (noteObj.tags?.length) msg += `\n🏷️ Теги: ${noteObj.tags.join(', ')}`;

  const url = `https://api.telegram.org/bot${account.token}/sendMessage`;
  const body = JSON.stringify({ chat_id: account.chatid, text: msg, parse_mode: 'HTML' });

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Проверка напоминаний ──────────────────────────────────────────────────────
function checkAll() {
  const now = Date.now();
  for (const [chatid, data] of store.entries()) {
    const { notes, account, fired } = data;
    if (!Array.isArray(notes)) continue;
    for (const n of notes) {
      if (!n.reminder || n.done) continue;
      const t = new Date(n.reminder).getTime();
      if (isNaN(t)) continue;
      const key = `${n.id}_${n.reminder}`;
      if (t <= now && !fired[key]) {
        fired[key] = Date.now();
        sendTelegram(account, n).catch(() => {});
        console.log(`[${new Date().toISOString()}] Sent reminder to ${chatid}: "${n.title}"`);
      }
    }
    // Чистим старые ключи (7 дней)
    const cutoff = now - 7 * 24 * 3600 * 1000;
    for (const key of Object.keys(fired)) {
      if (fired[key] < cutoff) delete fired[key];
    }
  }
}

// Запускаем проверку каждую минуту
setInterval(checkAll, 60_000);

// ── HTTP сервер ───────────────────────────────────────────────────────────────
const https = require('https');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
  cors(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST /sync — браузер присылает заметки + аккаунт ─────────────────────
  if (req.method === 'POST' && req.url === '/sync') {
    try {
      const body = await readBody(req);
      const { notes, account } = JSON.parse(body);
      if (!account?.chatid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing chatid' }));
        return;
      }
      const existing = store.get(account.chatid) || { fired: {} };
      store.set(account.chatid, { notes: notes || [], account, fired: existing.fired });
      console.log(`[${new Date().toISOString()}] Sync from ${account.chatid}: ${notes?.length ?? 0} notes`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: notes?.length ?? 0 }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── GET /ping — проверка что сервер жив ───────────────────────────────────
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, users: store.size, time: new Date().toISOString() }));
    return;
  }

  // ── GET / — страница статуса ──────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>Элегия — сервер уведомлений</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0e14;color:#e8e6f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#12131c;border:1px solid rgba(130,110,255,.2);border-radius:16px;padding:40px;text-align:center;max-width:400px}
h1{color:#b39dff;margin-bottom:8px}p{color:#9991bb;margin:6px 0}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#34d47a;margin-right:6px}</style>
</head>
<body><div class="card">
<h1>⏰ Элегия</h1>
<p><span class="dot"></span>Сервер уведомлений работает</p>
<p style="margin-top:20px;font-size:13px;color:#5e5880">Активных пользователей: <b style="color:#b39dff">${store.size}</b></p>
</div></body></html>`);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Элегия notification server listening on port ${PORT}`);
});
