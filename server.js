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
    const tzOffset = (account.tzOffset !== undefined) ? account.tzOffset : 0;

    for (const n of notes) {
      if (!n.reminder || n.done) continue;
      let reminderStr = n.reminder;
      const hasTimezone = /Z|[+-]\d{2}:\d{2}$/.test(reminderStr);
      let t;
      if (hasTimezone) {
        t = new Date(reminderStr).getTime();
      } else {
        t = new Date(reminderStr).getTime() - tzOffset * 60 * 1000;
      }
      if (isNaN(t)) continue;

      // Main reminder
      const key = `${n.id}_${n.reminder}`;
      if (t <= now && !fired[key]) {
        fired[key] = Date.now();
        sendTelegram(account, n).catch(() => {});
        console.log(`[${new Date().toISOString()}] Sent reminder to ${chatid}: "${n.title}"`);
      }

      // 1-hour-before Telegram warning
      if (n.hourBefore) {
        const earlyKey = `${n.id}_1hbefore_${n.reminder}`;
        const earlyT = t - 60 * 60 * 1000;
        if (earlyT <= now && !fired[earlyKey]) {
          fired[earlyKey] = Date.now();
          const title = n.title || '(без названия)';
          let msg = `⏰ <b>Напоминание через час — Элегия</b>\n\n📌 <b>${title}</b>`;
          try {
            const d = new Date(n.reminder);
            const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
            const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            msg += `\n📆 Срок: ${dateStr}, ${timeStr}`;
          } catch(e) {}
          const url = `https://api.telegram.org/bot${account.token}/sendMessage`;
          const body = JSON.stringify({ chat_id: account.chatid, text: msg, parse_mode: 'HTML' });
          const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => res.resume());
          req.on('error', () => {});
          req.write(body); req.end();
          console.log(`[${new Date().toISOString()}] Sent 1h-before to ${chatid}: "${n.title}"`);
        }
      }
    }
    // Чистим старые ключи (7 дней)
    const cutoff = now - 7 * 24 * 3600 * 1000;
    for (const key of Object.keys(fired)) {
      if (fired[key] < cutoff) delete fired[key];
    }
  }
}

// ── Telegram Webhook (polling fallback via /telegram) ──────────────────────────
async function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  // Helper: find token for this chatId
  const userData = store.get(chatId);
  const token = userData?.account?.token;

  if (text === '/start') {
    const helpMsg = `👋 <b>Элегия — сервер уведомлений</b>\n\nДоступные команды:\n/notes — все активные заметки\n/ping — статус сервера\n/sync — информация о синхронизации`;
    await sendTelegramRaw(chatId, token, helpMsg);
    return;
  }

  if (text === '/ping') {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);
    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const pingMsg = `✅ <b>Сервер работает</b>\n\n⏱ Uptime: ${h}ч ${m}м ${s}с\n👥 Пользователей: ${store.size}\n💾 Память: ${memMB} МБ\n🕐 Время: ${new Date().toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})} (MSK)`;
    await sendTelegramRaw(chatId, token, pingMsg);
    return;
  }

  if (text === '/sync') {
    if (!userData) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных синхронизации</b>\n\nОткройте приложение Элегия — оно автоматически синхронизирует заметки с сервером.');
      return;
    }
    const { notes, account } = userData;
    const total = notes?.length || 0;
    const active = notes?.filter(n => !n.done).length || 0;
    const withReminder = notes?.filter(n => !n.done && n.reminder).length || 0;
    const syncMsg = `🔄 <b>Синхронизация</b>\n\n📋 Всего заметок: ${total}\n✅ Активных: ${active}\n⏰ С напоминанием: ${withReminder}\n\nДанные в памяти сервера актуальны.`;
    await sendTelegramRaw(chatId, token, syncMsg);
    return;
  }

  if (text === '/notes' || text.startsWith('/notes ')) {
    if (!userData || !Array.isArray(userData.notes)) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных</b>\n\nОткройте приложение Элегия — оно автоматически синхронизирует заметки с сервером.');
      return;
    }
    const { notes, account: acc } = userData;
    const active = notes.filter(n => !n.done);
    if (!active.length) {
      await sendTelegramRaw(chatId, acc?.token || token, '✨ <b>Активных заметок нет</b>');
      return;
    }
    const now = Date.now();
    let msg2 = `📋 <b>Активные заметки (${active.length})</b>\n\n`;
    active.slice(0, 20).forEach((n, i) => {
      const title = n.title || '(без названия)';
      let line = `${i+1}. <b>${title}</b>`;
      if (n.reminder) {
        try {
          const d = new Date(n.reminder);
          const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
          const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
          const overdue = d.getTime() < now;
          line += `\n   📆 ${dateStr}, ${timeStr}${overdue ? ' ⚠️ просрочено' : ''}`;
        } catch(e) {}
      }
      if (n.recurRule) line += `\n   🔄 ${n.recurRule}`;
      if (n.tags && n.tags.length) line += `\n   🏷 ${n.tags.join(', ')}`;
      msg2 += line + '\n\n';
    });
    if (active.length > 20) msg2 += `…и ещё ${active.length - 20} заметок`;
    await sendTelegramRaw(chatId, acc?.token || token, msg2.trim());
    return;
  }
}

async function sendTelegramRaw(chatId, token, text, fallbackToken, fallbackChatId) {
  const tok = token || fallbackToken;
  if (!tok) return;
  const id = chatId || fallbackChatId;
  if (!id) return;
  const url = `https://api.telegram.org/bot${tok}/sendMessage`;
  const body = JSON.stringify({ chat_id: id, text, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

// ── Webhook registration ──────────────────────────────────────────────────────
const registeredWebhooks = new Set(); // токены для которых уже зарегистрировали webhook

async function registerWebhook(token) {
  if (!token || registeredWebhooks.has(token)) return;
  const serverUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL;
  if (!serverUrl) {
    console.log('[webhook] SERVER_URL not set, skipping auto-register');
    return;
  }
  const webhookUrl = serverUrl.replace(/\/$/, '') + '/telegram';
  const url = `https://api.telegram.org/bot${token}/setWebhook`;
  const body = JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] });
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.ok) {
            registeredWebhooks.add(token);
            console.log(`[webhook] Registered for token ...${token.slice(-6)}: ${webhookUrl}`);
          } else {
            console.log(`[webhook] Failed: ${r.description}`);
          }
        } catch(e) {}
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
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

  // ── GET /setup-webhook?token=XXX — ручная регистрация webhook ────────────
  if (req.method === 'GET' && req.url.startsWith('/setup-webhook')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const token = urlObj.searchParams.get('token');
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Укажите ?token=ВАШ_ТОКЕН_БОТА');
      return;
    }
    const serverUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL || `https://${req.headers.host}`;
    const webhookUrl = serverUrl.replace(/\/$/, '') + '/telegram';
    const apiUrl = `https://api.telegram.org/bot${token}/setWebhook`;
    const body = JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] });
    try {
      const result = await new Promise((resolve, reject) => {
        const r = https.request(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, resp => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ ok: false }); } });
        });
        r.on('error', reject);
        r.write(body); r.end();
      });
      if (result.ok) {
        registeredWebhooks.add(token);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`✅ Webhook зарегистрирован!\nURL: ${webhookUrl}\n\nТеперь команды /notes /ping /sync /start работают в боте.`);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`❌ Ошибка Telegram: ${result.description}`);
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Ошибка: ${e.message}`);
    }
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
      // Авто-регистрация webhook при получении токена
      if (account.token) registerWebhook(account.token).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stored: notes?.length ?? 0 }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── POST /telegram — Telegram webhook ───────────────────────────────────
  if (req.method === 'POST' && req.url === '/telegram') {
    try {
      const body = await readBody(req);
      const update = JSON.parse(body);
      handleTelegramUpdate(update).catch(e => console.error('TG update error:', e));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(400); res.end();
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
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);
    const uptimeStr = `${h}ч ${m}м ${s}с`;
    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const totalNotes = [...store.values()].reduce((acc, d) => acc + (d.notes?.length || 0), 0);
    const activeNotes = [...store.values()].reduce((acc, d) => acc + (d.notes?.filter(n=>!n.done).length || 0), 0);
    const totalFired = [...store.values()].reduce((acc, d) => acc + Object.keys(d.fired || {}).length, 0);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Элегия — сервер уведомлений</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,600&family=IBM+Plex+Sans:wght@500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0c1410;--bg2:#111a16;--accent:#c49a3c;--accent2:#e0bd72;
  --accent-glow:rgba(196,154,60,0.18);--text:#f0ead8;--text2:#a89e82;--text3:#5a5444;
  --glass-bg:rgba(30,26,16,0.46);--glass-bg-strong:rgba(22,20,13,0.76);
  --glass-border:rgba(224,189,114,0.16);--done:#4ecb74;--red:#e05c5c;
}
body{background:var(--bg);color:var(--text);font-family:'IBM Plex Sans',system-ui,sans-serif;min-height:100vh;
  display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:40px 20px;
  background-image:radial-gradient(700px 480px at 14% -8%,rgba(196,154,60,0.06),transparent 60%),
    radial-gradient(500px at 100% 20%,rgba(196,154,60,0.05),transparent 55%);}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:34px;font-style:italic;color:var(--accent2);
  margin-bottom:4px;letter-spacing:0.02em;}
.subtitle{font-size:12px;color:var(--text3);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:32px;font-weight:600;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;width:100%;max-width:820px;margin-bottom:24px;}
.card{background:var(--glass-bg-strong);border:1px solid var(--glass-border);border-radius:18px;
  padding:20px 22px;box-shadow:0 8px 28px rgba(0,0,0,0.35),inset 0 1px 0 rgba(255,255,255,0.05);}
.card-label{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.14em;margin-bottom:8px;}
.card-value{font-family:'IBM Plex Mono',monospace;font-size:24px;font-weight:600;color:var(--accent2);line-height:1;}
.card-sub{font-size:11px;color:var(--text3);margin-top:5px;font-weight:600;}
.status-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
.dot{width:9px;height:9px;border-radius:50%;background:var(--done);box-shadow:0 0 8px var(--done);flex-shrink:0;
  animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.info-card{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:14px;
  padding:16px 20px;width:100%;max-width:820px;margin-bottom:14px;
  font-size:12px;color:var(--text2);line-height:2;font-weight:600;}
.info-card b{color:var(--text);}
.ep{display:inline-block;background:rgba(196,154,60,0.10);border:1px solid rgba(196,154,60,0.2);
  border-radius:999px;padding:2px 12px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--accent2);margin:2px 3px;}
.time{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3);margin-top:28px;}
</style>
</head>
<body>
  <h1>Элегия</h1>
  <div class="subtitle">Сервер уведомлений</div>
  <div class="grid">
    <div class="card">
      <div class="status-row"><span class="dot"></span><div class="card-label" style="margin:0;">Статус</div></div>
      <div class="card-value" style="font-size:16px;color:var(--done);margin-top:6px;">Работает</div>
      <div class="card-sub">Uptime: ${uptimeStr}</div>
    </div>
    <div class="card">
      <div class="card-label">Пользователи</div>
      <div class="card-value">${store.size}</div>
      <div class="card-sub">Активных сессий</div>
    </div>
    <div class="card">
      <div class="card-label">Заметки</div>
      <div class="card-value">${totalNotes}</div>
      <div class="card-sub">${activeNotes} активных</div>
    </div>
    <div class="card">
      <div class="card-label">Уведомлений отправлено</div>
      <div class="card-value">${totalFired}</div>
      <div class="card-sub">За всё время</div>
    </div>
    <div class="card">
      <div class="card-label">Память</div>
      <div class="card-value">${memMB} <span style="font-size:14px;">МБ</span></div>
      <div class="card-sub">RSS процесса</div>
    </div>
    <div class="card">
      <div class="card-label">Проверка</div>
      <div class="card-value" style="font-size:16px;">каждую</div>
      <div class="card-sub">минуту</div>
    </div>
  </div>
  <div class="info-card">
    <b>API endpoints:</b><br>
    <span class="ep">POST /sync</span> — синхронизация заметок из браузера<br>
    <span class="ep">GET /ping</span> — проверка доступности сервера<br>
    <span class="ep">POST /telegram</span> — webhook для Telegram команд<br>
    <span class="ep">GET /setup-webhook?token=…</span> — регистрация webhook вручную<br>
    <span class="ep">GET /</span> — эта страница
  </div>
  <div class="info-card">
    <b>Telegram команды бота:</b><br>
    <span class="ep">/notes</span> — список активных заметок<br>
    <span class="ep">/ping</span> — статус сервера (uptime, память, кол-во пользователей)<br>
    <span class="ep">/sync</span> — информация о синхронизированных данных<br>
    <span class="ep">/start</span> — справка по командам
  </div>
  <div class="info-card" style="border-color:rgba(196,154,60,0.35);">
    <b style="color:var(--accent2);">⚙️ Как включить команды бота (один раз)</b><br><br>
    Telegram должен знать адрес сервера чтобы слать команды. Есть два способа:<br><br>
    <b>Способ 1 — автоматически</b> (если задан <code style="color:var(--accent2);">SERVER_URL</code>)<br>
    В Render.com → Environment → добавить переменную:<br>
    <code style="color:var(--accent2);">SERVER_URL = https://ВАШ-СЕРВЕР.onrender.com</code><br>
    После перезапуска сервера webhook зарегистрируется сам при первом /sync из приложения.<br><br>
    <b>Способ 2 — вручную</b> (работает всегда)<br>
    Откройте в браузере:<br>
    <code style="color:var(--accent2);word-break:break-all;">https://ВАШ-СЕРВЕР.onrender.com/setup-webhook?token=ТОКЕН_БОТА</code><br>
    Должно ответить «✅ Webhook зарегистрирован!»<br><br>
    <b>Способ 3 — через BotFather (curl)</b><br>
    <code style="color:var(--accent2);word-break:break-all;font-size:10px;">curl "https://api.telegram.org/botТОКЕН/setWebhook?url=https://ВАШ-СЕРВЕР.onrender.com/telegram"</code>
  </div>
  <div class="time">Время сервера: ${new Date().toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})} (MSK)</div>
</body>
</html>`);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Элегия notification server listening on port ${PORT}`);
});
