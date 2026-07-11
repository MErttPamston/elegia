// server.js — Nota: фоновые Telegram-уведомления
// Деплоится на Render.com (бесплатно).
// Хранит заметки в памяти (получает их от браузера через /sync).
// Каждую минуту проверяет напоминания и шлёт в Telegram.

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;

// ── Хранилище ─────────────────────────────────────────────────────────────────
// Ключ — chatid пользователя, значение — { notes, account, fired }
const store = new Map();

// Тот же токен, что зашит в клиенте (index.html). Нужен как fallback,
// когда для chatId ещё не было ни одной /sync (например, первое сообщение боту).
const DEFAULT_BOT_TOKEN = '8760227441:AAFHqAc9cQrc7dmg-qAPJHcspi2wPKrTkso';

// ── Пользователи (логин/пароль) и общие заметки ─────────────────────────────
// Хранится в файле users.json рядом с server.js. На бесплатном Render диск
// эфемерный и стирается при передеплое — для хобби-проекта это ок,
// но стоит иметь в виду (не банковское хранилище).
const USERS_FILE = require('path').join(__dirname, 'users.json');
let users = new Map(); // login(lowercase) -> { login, salt, hash, incoming: [] }

// ── Резервная копия аккаунтов в приватный GitHub Gist ───────────────────────
// На бесплатном Render диск стирается при каждом деплое новой версии.
// Если заданы переменные окружения GIST_BACKUP_TOKEN (personal access token
// со scope "gist") и GIST_BACKUP_ID (id уже существующего приватного гиста),
// сервер при старте подтягивает последний бэкап, а при каждом изменении
// пользователей — сохраняет туда свежую копию. Без этих переменных всё
// работает как раньше (только локальный диск, без переживания деплоев).
const GIST_BACKUP_TOKEN = process.env.GIST_BACKUP_TOKEN || '';
const GIST_BACKUP_ID = process.env.GIST_BACKUP_ID || '';
const GIST_FILENAME = 'nota-users-backup.json';
let gistBackupTimer = null;
// Видимость статуса бэкапа — раньше ошибки только тихо уходили в console.error
// и терялись вместе с логами Render. Теперь последний результат хранится в
// памяти и отдаётся через /admin/backup/status, чтобы не гадать постфактум.
let lastBackupAt = 0;       // timestamp последнего УСПЕШНОГО бэкапа
let lastBackupError = null; // текст последней ошибки бэкапа (или null)
function backupUsersToGist() {
  return new Promise(resolve => {
    if (!GIST_BACKUP_TOKEN || !GIST_BACKUP_ID) { resolve({ ok:false, error:'not configured' }); return; }
    const body = JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify([...users.values()]) } } });
    const req = https.request(`https://api.github.com/gists/${GIST_BACKUP_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GIST_BACKUP_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'nota-server',
        'Content-Length': Buffer.byteLength(body)
      }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          lastBackupAt = Date.now();
          lastBackupError = null;
          resolve({ ok:true });
        } else {
          const msg = `GitHub ответил ${r.statusCode}: ${data.slice(0, 300)}`;
          lastBackupError = msg;
          console.error('[gist] backup failed:', msg);
          resolve({ ok:false, error: msg });
        }
      });
    });
    req.on('error', e => {
      lastBackupError = e.message;
      console.error('[gist] backup failed:', e.message);
      resolve({ ok:false, error: e.message });
    });
    req.write(body); req.end();
  });
}
function restoreUsersFromGistIfEmpty() {
  if (users.size > 0 || !GIST_BACKUP_TOKEN || !GIST_BACKUP_ID) return;
  https.get(`https://api.github.com/gists/${GIST_BACKUP_ID}`, {
    headers: { 'Authorization': `token ${GIST_BACKUP_TOKEN}`, 'User-Agent': 'nota-server' }
  }, r => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const d = JSON.parse(data);
        const file = d.files && d.files[GIST_FILENAME];
        if (file && file.content) {
          const arr = JSON.parse(file.content);
          users = new Map(arr.map(u => [u.login.toLowerCase(), u]));
          saveUsers();
          console.log(`[gist] Восстановлено ${users.size} аккаунтов из резервной копии`);
        }
      } catch (e) { console.error('[gist] restore parse failed:', e.message); }
    });
  }).on('error', e => console.error('[gist] restore failed:', e.message));
}
// Восстановление вручную (кнопка в админ-панели) — БЕЗОПАСНОЕ слияние:
// добавляет из бэкапа только те аккаунты, которых сейчас нет на сервере.
// Ни один существующий сейчас аккаунт не будет перезаписан или удалён —
// это гарантирует, что в старый аккаунт всегда можно зайти, даже если
// он почему-то пропал локально, и не рискует свежими данными.
function restoreUsersFromGistMerge() {
  return new Promise((resolve, reject) => {
    if (!GIST_BACKUP_TOKEN || !GIST_BACKUP_ID) { reject(new Error('Резервное копирование не настроено (нет GIST_BACKUP_TOKEN/GIST_BACKUP_ID)')); return; }
    https.get(`https://api.github.com/gists/${GIST_BACKUP_ID}`, {
      headers: { 'Authorization': `token ${GIST_BACKUP_TOKEN}`, 'User-Agent': 'nota-server' }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const d = JSON.parse(data);
          const file = d.files && d.files[GIST_FILENAME];
          if (!file || !file.content) { resolve({ merged: 0, total: users.size }); return; }
          const arr = JSON.parse(file.content);
          let merged = 0;
          for (const u of arr) {
            const key = u.login.toLowerCase();
            if (!users.has(key)) { users.set(key, u); merged++; }
          }
          if (merged > 0) saveUsers();
          resolve({ merged, total: users.size });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    users = new Map(arr.map(u => [u.login.toLowerCase(), u]));
    console.log(`[users] Loaded ${users.size} accounts`);
  } catch (e) { users = new Map(); }
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify([...users.values()])); }
  catch (e) { console.error('[users] save error:', e.message); }
  clearTimeout(gistBackupTimer);
  gistBackupTimer = setTimeout(backupUsersToGist, 1500);
}
loadUsers();
restoreUsersFromGistIfEmpty();
// Автоматический бэкап каждые 10 минут — даже если по какой-то причине
// отложенный бэкап после saveUsers() не успеет сработать (например, сервер
// перезапустился в первые секунды), состояние всё равно регулярно уходит в Gist.
setInterval(backupUsersToGist, 10 * 60 * 1000);

const sessions = new Map(); // token -> login(lowercase)
const FREE_NOTES_LIMIT = 100;
const PLUS_NOTES_LIMIT = 1000;

// ── Коды смены пароля через Telegram ─────────────────────────────────────────
// key -> { code, expiresAt, used }. Живут только в памяти (короткоживущие,
// 10 минут), одноразовые: как только применены в /auth/reset-password-with-code,
// сразу помечаются used и повторно использовать их нельзя.
const passwordResetCodes = new Map();
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
async function issuePasswordResetCode(loginKey) {
  const user = users.get(loginKey);
  if (!user || !user.telegramChatId) return { ok:false, error:'Аккаунт не найден или не привязан Telegram' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  passwordResetCodes.set(loginKey, { code, expiresAt: Date.now() + RESET_CODE_TTL_MS, used: false });
  const text = '🔑 <b>Код смены пароля — Nota</b>\n\nВаш код: <code>' + code + '</code>\n\nОн действует 10 минут и одноразовый. Никому не сообщайте этот код.';
  try {
    await new Promise(resolve => {
      const body = JSON.stringify({ chat_id: user.telegramChatId, text, parse_mode: 'HTML' });
      const r = https.request(`https://api.telegram.org/bot${DEFAULT_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, resp => { resp.on('data', () => {}); resp.on('end', resolve); });
      r.on('error', resolve);
      r.write(body); r.end();
    });
  } catch (e) {}
  return { ok:true };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

// ── Защита ADMIN_KEY от перебора ────────────────────────────────────────────
// Если ключ короткий (например, всего несколько цифр), его можно перебрать
// автоматическим скриптом за секунды. Блокируем IP на 15 минут после
// 5 неверных попыток подряд — это делает перебор практически бесполезным
// независимо от того, насколько простой ключ выбран.
const adminKeyAttempts = new Map(); // ip -> { count, blockedUntil }
function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
function ipBlockedUntil(ip) {
  const rec = adminKeyAttempts.get(ip);
  return (rec && rec.blockedUntil && Date.now() < rec.blockedUntil) ? rec.blockedUntil : 0;
}
function recordFailedAdminAttempt(ip) {
  const now = Date.now();
  let rec = adminKeyAttempts.get(ip);
  if (!rec || (rec.blockedUntil && now >= rec.blockedUntil)) rec = { count: 0, blockedUntil: 0 };
  rec.count++;
  if (rec.count >= 5) { rec.blockedUntil = now + 15 * 60 * 1000; rec.count = 0; }
  adminKeyAttempts.set(ip, rec);
}
function resetAdminAttempts(ip) { adminKeyAttempts.delete(ip); }
function checkAdminKey(req, res, providedKey) {
  const ip = getClientIp(req);
  const blockedUntil = ipBlockedUntil(ip);
  if (blockedUntil) {
    const waitMin = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
    res.writeHead(429, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:false, error: `Слишком много неверных попыток. Попробуйте через ${waitMin} мин.` }));
    return false;
  }
  if (!process.env.ADMIN_KEY || providedKey !== process.env.ADMIN_KEY) {
    recordFailedAdminAttempt(ip);
    res.writeHead(403, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:false, error:'Неверный админ-ключ' }));
    return false;
  }
  resetAdminAttempts(ip); // успешный вход — сбрасываем счётчик для этого IP
  return true;
}

// ── Код регистрации (создаётся вручную со страницы статуса сервера) ────────
// Персистится в отдельный файл рядом с users.json, чтобы код НЕ пропадал
// при обновлении страницы / перезапуске процесса (раньше жил только в
// памяти и "терялся" при любом рестарте сервера). НЕ привязан ни к каким
// аккаунтам: если код деактивировать или он истечёт, уже созданные через
// него аккаунты никуда не пропадают.
const REG_CODE_FILE = require('path').join(__dirname, 'regcode.json');
const REG_CODE_TTL_MS = 24 * 60 * 60 * 1000; // 1 день
let regCode = null; // { code, createdAt, expiresAt, active, used }
function loadRegCode() {
  try { regCode = JSON.parse(fs.readFileSync(REG_CODE_FILE, 'utf8')); } catch (e) { regCode = null; }
}
function saveRegCode() {
  try { fs.writeFileSync(REG_CODE_FILE, JSON.stringify(regCode)); } catch (e) {}
}
loadRegCode();
// Код действует только пока: активен, не истёк по времени И ещё не был использован.
// Как только код использован один раз (создан аккаунт) — он сразу перестаёт
// действовать, даже если время ещё не вышло. По истечении времени код тоже
// сразу перестаёт работать и не может быть "возвращён" деактивацией/реактивацией.
function isRegCodeActive() { return !!(regCode && regCode.active && !regCode.used && Date.now() < regCode.expiresAt); }
function isRegistrationKeyValid(key) {
  if (!key) return false;
  // Постоянный ключ через переменную окружения — необязателен, но если задан, работает всегда
  if (process.env.REGISTRATION_KEY && key === process.env.REGISTRATION_KEY) return true;
  // Временный код с страницы статуса сервера — только цифры, регистр не важен
  if (isRegCodeActive() && String(key).trim() === regCode.code) return true;
  return false;
}
// Помечает разовый код использованным (если именно он был применён при регистрации)
function markRegCodeUsedIfMatches(key) {
  if (regCode && regCode.active && !regCode.used && String(key).trim() === regCode.code && Date.now() < regCode.expiresAt) {
    regCode.used = true;
    saveRegCode();
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(account, noteObj) {
  if (!account?.token || !account?.chatid) return;
  const title = noteObj.title || '(без названия)';
  let msg = `⏰ <b>Напоминание — Nota</b>\n\n📌 <b>${title}</b>`;
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
  const replyMarkup = { inline_keyboard: [[
    { text: '✅ Готово', callback_data: `done_${noteObj.id}` },
    { text: '⏰ +1 час', callback_data: `snooze_${noteObj.id}` }
  ]] };
  const body = JSON.stringify({ chat_id: account.chatid, text: msg, parse_mode: 'HTML', reply_markup: replyMarkup });

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
          if (r.ok && r.result?.message_id) {
            const entry = store.get(String(account.chatid));
            if (entry) { entry.msgMap = entry.msgMap || {}; entry.msgMap[String(r.result.message_id)] = noteObj.id; }
          }
        } catch(e) {}
        resolve(res.statusCode);
      });
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

      // Гибкие предупреждения заранее: за X минут/часов/дней до срока,
      // с опциональным повтором каждые N минут/часов M раз
      const warnBefore = Number(n.warnBeforeMinutes) || 0;
      if (warnBefore > 0) {
        const times = Math.max(1, Number(n.warnRepeatTimes) || 1);
        const every = Number(n.warnRepeatEveryMinutes) || 0;
        for (let i = 0; i < times; i++) {
          // i=0 — самое раннее предупреждение (за warnBefore до срока),
          // каждое следующее — на `every` минут ближе к сроку
          const offsetMin = every > 0 ? warnBefore - i * every : warnBefore;
          if (offsetMin <= 0) break;
          const warnT = t - offsetMin * 60 * 1000;
          const warnKey = `${n.id}_warn${i}_${n.reminder}`;
          if (warnT <= now && warnT > now - 24*3600*1000 && !fired[warnKey]) {
            fired[warnKey] = Date.now();
            const title = n.title || '(без названия)';
            const leadLabel = offsetMin % (60*24) === 0 && offsetMin >= 60*24
              ? `${offsetMin/(60*24)} дн.`
              : (offsetMin % 60 === 0 ? `${offsetMin/60} ч.` : `${offsetMin} мин.`);
            let msg = `⏰ <b>Напоминание за ${leadLabel} — Nota</b>\n\n📌 <b>${title}</b>`;
            try {
              const d = new Date(n.reminder);
              const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
              const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
              msg += `\n📆 Срок: ${dateStr}, ${timeStr}`;
            } catch(e) {}
            const url = `https://api.telegram.org/bot${account.token}/sendMessage`;
            const replyMarkup = { inline_keyboard: [[
              { text: '✅ Готово', callback_data: `done_${n.id}` },
              { text: '⏰ +1 час', callback_data: `snooze_${n.id}` }
            ]] };
            const body = JSON.stringify({ chat_id: account.chatid, text: msg, parse_mode: 'HTML', reply_markup: replyMarkup });
            const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
              let d = '';
              res.on('data', c => d += c);
              res.on('end', () => {
                try {
                  const r = JSON.parse(d);
                  if (r.ok && r.result?.message_id) {
                    const entry = store.get(String(chatid));
                    if (entry) { entry.msgMap = entry.msgMap || {}; entry.msgMap[String(r.result.message_id)] = n.id; }
                  }
                } catch(e) {}
              });
            });
            req.on('error', () => {});
            req.write(body); req.end();
            console.log(`[${new Date().toISOString()}] Sent warn (${leadLabel} before) to ${chatid}: "${n.title}"`);
          }
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
  if (update.callback_query) { await handleCallbackQuery(update.callback_query); return; }
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  // Helper: find token for this chatId
  const userData = store.get(chatId);
  const token = userData?.account?.token || DEFAULT_BOT_TOKEN;

  if (text === '/start' || text === '/help') {
    const helpMsg = `👋 <b>Nota — сервер уведомлений</b>\n\nСоздание:\n/create — создать заметку по шагам (с кнопками)\n/cancel — отменить текущее создание заметки\n\nЗаметки:\n/notes — все активные заметки\n/today — заметки на сегодня\n/tomorrow — заметки на завтра\n/overdue — просроченные заметки\n/done_list — последние выполненные\n/search текст — поиск по заметкам\n/stats — статистика по заметкам\n\nУправление:\n/done N — отметить заметку №N выполненной\n/delete N — удалить заметку №N\n/priority N высокий — задать приоритет заметке №N\n\nАккаунт:\n/telegram — узнать ваш Chat ID\n/forgot_password — сменить пароль аккаунта Nota по коду\n\nℹ️ Заметки создаются только по шагам через /create — просто написанный текст заметкой не станет.`;
    await sendTelegramRaw(chatId, token, helpMsg);
    return;
  }

  if (text === '/telegram') {
    await sendTelegramRaw(chatId, token, `🆔 <b>Ваш Chat ID:</b>\n<code>${chatId}</code>\n\nВставьте его в приложении Nota → вкладка Telegram, чтобы привязать бота к этому сайту.`);
    return;
  }

  // ── /forgot_password — смена пароля аккаунта Nota по шагам ──────────────────
  if (text === '/forgot_password') {
    const data0 = userData || { notes: [], account: null, fired: {}, pendingNew: [], pendingChanges: [], msgMap: {} };
    data0.pwReset = { stage: 'login' };
    store.set(chatId, data0);
    await sendTelegramRaw(chatId, token, '🔑 <b>Смена пароля Nota</b>\n\nВведите логин вашего аккаунта Nota (до 8 символов):');
    return;
  }

  if (text === '/notes' || text.startsWith('/notes ')) {
    if (!userData || !Array.isArray(userData.notes)) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных</b>\n\nОткройте приложение Nota — оно автоматически синхронизирует заметки с сервером.');
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

  // ── /today, /tomorrow — заметки со сроком на конкретный день ─────────────
  if (text === '/today' || text === '/tomorrow') {
    if (!userData || !Array.isArray(userData.notes)) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных</b>\n\nОткройте приложение Nota, чтобы синхронизировать заметки.');
      return;
    }
    const target = new Date();
    if (text === '/tomorrow') target.setDate(target.getDate() + 1);
    const y = target.getFullYear(), m = target.getMonth(), d = target.getDate();
    const list = userData.notes.filter(n => {
      if (!n.reminder || n.done) return false;
      const dt = new Date(n.reminder);
      return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d;
    });
    if (!list.length) {
      await sendTelegramRaw(chatId, token, text === '/today' ? '✨ <b>На сегодня заметок нет</b>' : '✨ <b>На завтра заметок нет</b>');
      return;
    }
    let out = `📅 <b>${text === '/today' ? 'Сегодня' : 'Завтра'} (${list.length})</b>\n\n`;
    list.forEach((n, i) => {
      const dt = new Date(n.reminder);
      const timeStr = dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      out += `${i+1}. <b>${n.title || '(без названия)'}</b> — ${timeStr}\n`;
    });
    await sendTelegramRaw(chatId, token, out.trim());
    return;
  }

  // ── /overdue — просроченные заметки ───────────────────────────────────────
  if (text === '/overdue') {
    if (!userData || !Array.isArray(userData.notes)) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных</b>\n\nОткройте приложение Nota, чтобы синхронизировать заметки.');
      return;
    }
    const now = Date.now();
    const list = userData.notes.filter(n => n.reminder && !n.done && new Date(n.reminder).getTime() < now);
    if (!list.length) {
      await sendTelegramRaw(chatId, token, '✨ <b>Просроченных заметок нет</b>');
      return;
    }
    let out = `⚠️ <b>Просрочено (${list.length})</b>\n\n`;
    list.slice(0, 20).forEach((n, i) => { out += `${i+1}. <b>${n.title || '(без названия)'}</b>\n`; });
    await sendTelegramRaw(chatId, token, out.trim());
    return;
  }

  // ── /done_list — последние выполненные заметки ────────────────────────────
  if (text === '/done_list') {
    if (!userData || !Array.isArray(userData.notes)) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных</b>\n\nОткройте приложение Nota, чтобы синхронизировать заметки.');
      return;
    }
    const list = userData.notes.filter(n => n.done).sort((a,b) => (b.updated||0) - (a.updated||0)).slice(0, 15);
    if (!list.length) {
      await sendTelegramRaw(chatId, token, '📭 <b>Выполненных заметок пока нет</b>');
      return;
    }
    let out = `✅ <b>Недавно выполненные</b>\n\n`;
    list.forEach((n, i) => { out += `${i+1}. ${n.title || '(без названия)'}\n`; });
    await sendTelegramRaw(chatId, token, out.trim());
    return;
  }

  // ── /search текст — поиск по заголовку и содержимому заметок ─────────────
  if (text.startsWith('/search ')) {
    const q = text.slice(8).trim().toLowerCase();
    if (!q) { await sendTelegramRaw(chatId, token, 'Напишите /search и текст для поиска.'); return; }
    if (!userData || !Array.isArray(userData.notes)) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных</b>\n\nОткройте приложение Nota, чтобы синхронизировать заметки.');
      return;
    }
    const list = userData.notes.filter(n =>
      (n.title||'').toLowerCase().includes(q) || (n.plainText||'').toLowerCase().includes(q)
    );
    if (!list.length) { await sendTelegramRaw(chatId, token, `🔍 По запросу «${q}» ничего не найдено`); return; }
    let out = `🔍 <b>Найдено: ${list.length}</b>\n\n`;
    list.slice(0, 15).forEach((n, i) => { out += `${i+1}. ${n.done ? '✅ ' : ''}${n.title || '(без названия)'}\n`; });
    await sendTelegramRaw(chatId, token, out.trim());
    return;
  }

  // ── /stats — статистика по заметкам ───────────────────────────────────────
  if (text === '/stats') {
    if (!userData || !Array.isArray(userData.notes)) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных</b>\n\nОткройте приложение Nota, чтобы синхронизировать заметки.');
      return;
    }
    const list = userData.notes;
    const active = list.filter(n => !n.done).length;
    const done = list.filter(n => n.done).length;
    const withReminder = list.filter(n => !n.done && n.reminder).length;
    const overdue = list.filter(n => n.reminder && !n.done && new Date(n.reminder).getTime() < Date.now()).length;
    const folders = new Set(list.map(n => n.folder).filter(Boolean)).size;
    const statsMsg = `📊 <b>Статистика</b>\n\n📋 Всего заметок: ${list.length}\n🟡 Активных: ${active}\n✅ Выполненных: ${done}\n⏰ С напоминанием: ${withReminder}\n⚠️ Просрочено: ${overdue}\n📁 Папок: ${folders}`;
    await sendTelegramRaw(chatId, token, statsMsg);
    return;
  }

  // ── /done N — отметить заметку номер N (из /notes) выполненной ────────────
  if (text.startsWith('/done ')) {
    const n = Number(text.slice(6).trim());
    if (!userData || !Array.isArray(userData.notes) || !n) { await sendTelegramRaw(chatId, token, 'Укажите номер заметки из /notes, например: /done 2'); return; }
    const active = userData.notes.filter(x => !x.done);
    const note = active[n - 1];
    if (!note) { await sendTelegramRaw(chatId, token, 'Заметка с таким номером не найдена — посмотрите /notes'); return; }
    userData.pendingChanges = userData.pendingChanges || [];
    userData.pendingChanges.push({ id: note.id, type: 'done' });
    await sendTelegramRaw(chatId, token, `✅ «${note.title || '(без названия)'}» отмечена выполненной`);
    return;
  }

  // ── /delete N — удалить заметку номер N (из /notes) ────────────────────────
  if (text.startsWith('/delete ')) {
    const n = Number(text.slice(8).trim());
    if (!userData || !Array.isArray(userData.notes) || !n) { await sendTelegramRaw(chatId, token, 'Укажите номер заметки из /notes, например: /delete 2'); return; }
    const active = userData.notes.filter(x => !x.done);
    const note = active[n - 1];
    if (!note) { await sendTelegramRaw(chatId, token, 'Заметка с таким номером не найдена — посмотрите /notes'); return; }
    userData.pendingChanges = userData.pendingChanges || [];
    userData.pendingChanges.push({ id: note.id, type: 'delete' });
    await sendTelegramRaw(chatId, token, `🗑 «${note.title || '(без названия)'}» будет удалена при следующей синхронизации приложения`);
    return;
  }

  // ── /create — пошаговое создание заметки с инлайн-кнопками ────────────────
  if (text === '/create') {
    const data = userData || { notes: [], account: null, fired: {}, pendingNew: [], pendingChanges: [], msgMap: {} };
    data.wizard = { step: 'title', data: {} };
    store.set(chatId, data);
    await sendWizardStep(chatId, token, data.wizard);
    return;
  }
  if (text === '/cancel') {
    const data = userData;
    if (data && data.wizard) { delete data.wizard; store.set(chatId, data); await sendTelegramRaw(chatId, token, '✖️ Создание заметки отменено'); }
    else if (data && data.pwReset) { delete data.pwReset; store.set(chatId, data); await sendTelegramRaw(chatId, token, '✖️ Смена пароля отменена'); }
    else await sendTelegramRaw(chatId, token, 'Нечего отменять');
    return;
  }

  // ── /priority N уровень — задать приоритет заметке номер N ────────────────
  if (text.startsWith('/priority ')) {
    const rest = text.slice(10).trim();
    const sp = rest.indexOf(' ');
    const n = Number(sp === -1 ? rest : rest.slice(0, sp));
    const level = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (!userData || !Array.isArray(userData.notes) || !n || !level) { await sendTelegramRaw(chatId, token, 'Формат: /priority номер уровень\nНапример: /priority 2 высокий'); return; }
    const active = userData.notes.filter(x => !x.done);
    const note = active[n - 1];
    if (!note) { await sendTelegramRaw(chatId, token, 'Заметка с таким номером не найдена — посмотрите /notes'); return; }
    userData.pendingChanges = userData.pendingChanges || [];
    userData.pendingChanges.push({ id: note.id, type: 'priority', priority: level });
    await sendTelegramRaw(chatId, token, `⚡ Приоритет «${note.title || '(без названия)'}» установлен: ${level}`);
    return;
  }

  // ── Неизвестная команда (случайные символы после "/") ─────────────────────
  // Вместо молчаливого игнорирования — показываем меню /start, чтобы
  // пользователь сразу видел список доступных команд.
  if (text.startsWith('/')) {
    const helpMsg = `🤔 <b>Неизвестная команда</b>\n\n👋 <b>Nota — сервер уведомлений</b>\n\nСоздание:\n/create — создать заметку по шагам (с кнопками)\n/cancel — отменить текущее создание заметки\n\nЗаметки:\n/notes — все активные заметки\n/today — заметки на сегодня\n/tomorrow — заметки на завтра\n/overdue — просроченные заметки\n/done_list — последние выполненные\n/search текст — поиск по заметкам\n/stats — статистика по заметкам\n\nУправление:\n/done N — отметить заметку №N выполненной\n/delete N — удалить заметку №N\n/priority N высокий — задать приоритет заметке №N\n\nАккаунт:\n/telegram — узнать ваш Chat ID\n/forgot_password — сменить пароль аккаунта Nota по коду`;
    await sendTelegramRaw(chatId, token, helpMsg);
    return;
  }

  const data = userData || { notes: [], account: null, fired: {}, pendingNew: [], pendingChanges: [], msgMap: {} };
  data.pendingNew = data.pendingNew || [];
  data.pendingChanges = data.pendingChanges || [];
  data.msgMap = data.msgMap || {};

  // Активный визард /create — текст идёт в текущий шаг, а не в создание обычной заметки
  if (data.wizard) {
    await handleWizardText(chatId, token, data, text);
    return;
  }

  // Активная смена пароля по шагам (/forgot_password) — тоже НЕ свободный текст:
  // это ожидаемый следующий шаг конкретного пошагового сценария.
  if (data.pwReset) {
    await handlePasswordResetText(chatId, token, data, text);
    return;
  }

  // Заметки создаются ТОЛЬКО по шагам через /create. Просто написанный текст
  // (и ответы/reply на сообщения бота) заметкой не становится — во избежание
  // случайных/непреднамеренных заметок и путаницы, что именно было отправлено.
  await sendTelegramRaw(chatId, token, 'ℹ️ Чтобы создать заметку, используйте команду /create — она проведёт вас по шагам с кнопками.\n\nПросто текстом или ответом (reply) заметки больше не создаются.');
}

function escapeHtmlServer(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Пошаговая смена пароля по коду из Telegram (/forgot_password) ──────────
async function handlePasswordResetText(chatId, token, data, text) {
  const stage = data.pwReset.stage;
  if (stage === 'login') {
    const login = text.trim();
    if (!login || login.length > 8) { await sendTelegramRaw(chatId, token, 'Логин должен быть до 8 символов. Попробуйте снова, или /cancel для отмены.'); return; }
    const key = login.toLowerCase();
    const result = await issuePasswordResetCode(key);
    data.pwReset = { stage: 'code', login: key };
    store.set(chatId, data);
    await sendTelegramRaw(chatId, token, '📨 Если у этого логина привязан Telegram, код уже отправлен туда. Введите полученный 6-значный код (или /cancel):');
    return;
  }
  if (stage === 'code') {
    const code = text.trim();
    data.pwReset = { stage: 'password', login: data.pwReset.login, code };
    store.set(chatId, data);
    await sendTelegramRaw(chatId, token, '🔒 Введите новый пароль (минимум 4 символа, или /cancel):');
    return;
  }
  if (stage === 'password') {
    const newPassword = text.trim();
    const { login, code } = data.pwReset;
    const rec = passwordResetCodes.get(login);
    delete data.pwReset;
    store.set(chatId, data);
    if (!rec || rec.used || Date.now() > rec.expiresAt || code !== rec.code) {
      await sendTelegramRaw(chatId, token, '❌ Неверный или истёкший код. Начните заново командой /forgot_password.');
      return;
    }
    if (newPassword.length < 4) { await sendTelegramRaw(chatId, token, '❌ Пароль слишком короткий. Начните заново командой /forgot_password.'); return; }
    const user = users.get(login);
    if (!user) { await sendTelegramRaw(chatId, token, '❌ Аккаунт не найден. Начните заново командой /forgot_password.'); return; }
    rec.used = true;
    const salt = crypto.randomBytes(16).toString('hex');
    user.salt = salt; user.hash = hashPassword(newPassword, salt);
    for (const [tok, k] of sessions.entries()) { if (k === login) sessions.delete(tok); }
    saveUsers();
    await sendTelegramRaw(chatId, token, '✅ Пароль изменён! Войдите в приложении Nota с новым паролем.');
  }
}

// ── /create — мастер создания заметки ───────────────────────────────────────
const WIZARD_MONTH_PRESETS = [
  { v:'day-1', l:'1-е число' }, { v:'day-10', l:'10-е число' }, { v:'day-15', l:'15-е число' },
  { v:'day-20', l:'20-е число' }, { v:'day-25', l:'25-е число' }, { v:'last-day', l:'Последний день месяца' },
  { v:'first-mon', l:'Первый понедельник' }, { v:'last-fri', l:'Последняя пятница' }
];
const WIZARD_WEEKDAYS = [
  { v:'weekly-mon', l:'Понедельник' }, { v:'weekly-tue', l:'Вторник' }, { v:'weekly-wed', l:'Среда' },
  { v:'weekly-thu', l:'Четверг' }, { v:'weekly-fri', l:'Пятница' }, { v:'weekly-sat', l:'Суббота' }, { v:'weekly-sun', l:'Воскресенье' }
];
function wizardNavRow(step) {
  const row = [];
  if (step !== 'title') row.push({ text: '⬅️ Назад', callback_data: 'wiz_back' });
  row.push({ text: '✖️ Отмена', callback_data: 'wiz_cancel' });
  return row;
}
function recurLabelFor(v) {
  if (!v) return 'без повторения';
  const all = [...WIZARD_WEEKDAYS, ...WIZARD_MONTH_PRESETS, { v:'daily', l:'Каждый день' }];
  return (all.find(o => o.v === v) || {}).l || v;
}
function parseRuDateTime(str) {
  const m = String(str).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, ddS, mmS, yyyyS, hhS, minS] = m;
  const dd = Number(ddS), mm = Number(mmS), yyyy = Number(yyyyS);
  const hh = hhS ? Number(hhS) : 9, min = minS ? Number(minS) : 0;
  if (hh > 23 || min > 59) return null;
  const d = new Date(yyyy, mm - 1, dd, hh, min);
  if (isNaN(d.getTime())) return null;
  // JS Date "перекатывает" несуществующие даты (напр. 31.02 → начало марта) —
  // проверяем, что после конструирования компоненты совпали с введёнными,
  // иначе дата не существует в календаре.
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return d;
}
async function sendWizardStep(chatId, token, wizard, menu) {
  const step = wizard.step;
  let text = '', keyboard = [];
  if (step === 'title') {
    text = '📝 <b>Новая заметка · шаг 1/5</b>\n\nВведите название заметки:';
    keyboard = [wizardNavRow(step)];
  } else if (step === 'description') {
    text = '📄 <b>Новая заметка · шаг 2/5</b>\n\nВведите описание, или нажмите «Не надо»:';
    keyboard = [[{ text: 'Не надо', callback_data: 'wiz_skip_desc' }], wizardNavRow(step)];
  } else if (step === 'date') {
    text = '📅 <b>Новая заметка · шаг 3/5</b>\n\nВведите дату и время в формате <code>ДД.ММ.ГГГГ ЧЧ:ММ</code> (например 25.12.2026 18:00), или нажмите «Оставить бездатной»:';
    keyboard = [[{ text: 'Оставить бездатной', callback_data: 'wiz_skip_date' }], wizardNavRow(step)];
  } else if (step === 'recur') {
    if (menu === 'week') {
      text = '🔄 <b>Новая заметка · шаг 4/5</b>\n\nПо какому дню недели?';
      keyboard = [
        WIZARD_WEEKDAYS.slice(0,4).map(o => ({ text: o.l, callback_data: 'wiz_recur_set_'+o.v })),
        WIZARD_WEEKDAYS.slice(4).map(o => ({ text: o.l, callback_data: 'wiz_recur_set_'+o.v })),
        [{ text: '⬅️ Назад', callback_data: 'wiz_recur_menu' }, { text: '✖️ Отмена', callback_data: 'wiz_cancel' }]
      ];
    } else if (menu === 'month') {
      text = '🔄 <b>Новая заметка · шаг 4/5</b>\n\nПо месяцу (часто используемые варианты; для другого числа — просто создайте заметку в приложении):';
      keyboard = [
        WIZARD_MONTH_PRESETS.slice(0,4).map(o => ({ text: o.l, callback_data: 'wiz_recur_set_'+o.v })),
        WIZARD_MONTH_PRESETS.slice(4).map(o => ({ text: o.l, callback_data: 'wiz_recur_set_'+o.v })),
        [{ text: '⬅️ Назад', callback_data: 'wiz_recur_menu' }, { text: '✖️ Отмена', callback_data: 'wiz_cancel' }]
      ];
    } else {
      text = '🔄 <b>Новая заметка · шаг 4/5</b>\n\nПовторение (все варианты):';
      keyboard = [
        [{ text: 'Не повторять', callback_data: 'wiz_recur_set_' }],
        [{ text: 'Каждый день', callback_data: 'wiz_recur_set_daily' }],
        [{ text: 'По дням недели ▸', callback_data: 'wiz_recur_week' }, { text: 'По числу месяца ▸', callback_data: 'wiz_recur_month' }],
        wizardNavRow(step)
      ];
    }
  } else if (step === 'folder') {
    const existing = [...new Set((userDataFoldersFor(chatId)||[]))].slice(0, 6);
    text = '🗂 <b>Новая заметка · шаг 5/5</b>\n\nВведите название папки, или выберите ниже:';
    keyboard = [];
    for (let i = 0; i < existing.length; i += 2) keyboard.push(existing.slice(i, i+2).map(f => ({ text: f, callback_data: 'wiz_folder_set_'+encodeURIComponent(f) })));
    keyboard.push([{ text: 'Без папки', callback_data: 'wiz_skip_folder' }]);
    keyboard.push(wizardNavRow(step));
  } else if (step === 'confirm') {
    const d = wizard.data;
    text = `✅ <b>Проверьте заметку:</b>\n\n📌 <b>${escapeHtmlServer(d.title||'')}</b>` +
      (d.description ? `\n📄 ${escapeHtmlServer(d.description)}` : '') +
      `\n📅 ${d.dateLabel ? escapeHtmlServer(d.dateLabel) : 'без даты'}` +
      `\n🔄 ${recurLabelFor(d.recurRule)}` +
      `\n🗂 ${d.folder ? escapeHtmlServer(d.folder) : 'без папки'}`;
    keyboard = [[{ text: '✅ Создать', callback_data: 'wiz_confirm' }], wizardNavRow(step)];
  }
  await sendTelegramRaw(chatId, token, text, null, null, { inline_keyboard: keyboard });
}
function userDataFoldersFor(chatId) {
  const d = store.get(chatId);
  if (!d || !Array.isArray(d.notes)) return [];
  return [...new Set(d.notes.map(n => n.folder).filter(Boolean))];
}
async function handleWizardText(chatId, token, data, text) {
  const w = data.wizard;
  if (w.step === 'title') {
    w.data.title = text.length > 80 ? text.slice(0,80) : text;
    w.step = 'description';
  } else if (w.step === 'description') {
    w.data.description = text;
    w.step = 'date';
  } else if (w.step === 'date') {
    const d = parseRuDateTime(text);
    if (!d) { await sendTelegramRaw(chatId, token, '⚠️ Такой даты не существует или формат неверный. Введите дату в формате ДД.ММ.ГГГГ ЧЧ:ММ (например 25.12.2026 18:00), или нажмите «Оставить бездатной».'); return; }
    w.data.reminder = d.toISOString();
    w.data.dateLabel = d.toLocaleString('ru-RU', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    w.step = 'recur';
  } else if (w.step === 'folder') {
    w.data.folder = text.trim();
    w.step = 'confirm';
  } else {
    return; // на этом шаге текст не ожидается — только кнопки
  }
  store.set(chatId, data);
  await sendWizardStep(chatId, token, w);
}
async function finishWizard(chatId, token, data) {
  const d = data.wizard.data;
  const newNote = {
    id: 'tg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    title: d.title || '(без названия)',
    html: escapeHtmlServer(d.description || ''), plainText: d.description || '',
    datetime: d.reminder ? d.reminder.slice(0,16) : '', date: d.reminder ? d.reminder.slice(0,10) : '', time: d.reminder ? d.reminder.slice(11,16) : '',
    reminder: d.reminder || '', color: 'default',
    recurRule: d.recurRule || '', tags: ['telegram'], priority: '', pinned: false, folder: d.folder || '',
    checklist: [], extraReminders: [], warnBeforeMinutes: 0, warnRepeatEveryMinutes: 0, warnRepeatTimes: 0, history: [],
    done: false, created: Date.now(), updated: Date.now()
  };
  data.pendingNew = data.pendingNew || [];
  data.pendingNew.push(newNote);
  delete data.wizard;
  store.set(chatId, data);
  await sendTelegramRaw(chatId, token, `🎉 Заметка «${escapeHtmlServer(newNote.title)}» создана и появится в приложении Nota при следующей синхронизации.`);
}

// ── Callback-кнопки под напоминаниями (✅ Готово / ⏰ +1 час) ───────────────────
async function handleCallbackQuery(cq) {
  const chatId = String(cq.message?.chat?.id || '');
  const data = cq.data || '';
  const userData = store.get(chatId);
  const token = userData?.account?.token || DEFAULT_BOT_TOKEN;

  if (data.startsWith('wiz_')) {
    await answerCallbackQuery(cq.id, token, '');
    await handleWizardCallback(chatId, token, userData, data);
    return;
  }

  const sep = data.indexOf('_');
  const action = sep === -1 ? data : data.slice(0, sep);
  const noteId = sep === -1 ? '' : data.slice(sep + 1);

  if (!userData || !noteId) {
    await answerCallbackQuery(cq.id, token, 'Нет данных — откройте приложение');
    return;
  }
  userData.pendingChanges = userData.pendingChanges || [];
  if (action === 'done') {
    userData.pendingChanges.push({ id: noteId, type: 'done' });
    await answerCallbackQuery(cq.id, token, '✅ Отмечено выполненным');
  } else if (action === 'snooze') {
    const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    userData.pendingChanges.push({ id: noteId, type: 'snooze', reminder: snoozeUntil });
    await answerCallbackQuery(cq.id, token, '⏰ Отложено на час');
  } else {
    await answerCallbackQuery(cq.id, token, '');
  }
}

// ── Обработка кнопок мастера /create ─────────────────────────────────────────
const WIZARD_STEP_ORDER = ['title', 'description', 'date', 'recur', 'folder', 'confirm'];
async function handleWizardCallback(chatId, token, userData, cbData) {
  const data = userData;
  if (!data || !data.wizard) { await sendTelegramRaw(chatId, token, 'Мастер создания заметки уже неактивен. Начните заново: /create'); return; }
  const w = data.wizard;

  if (cbData === 'wiz_cancel') { delete data.wizard; store.set(chatId, data); await sendTelegramRaw(chatId, token, '✖️ Создание заметки отменено'); return; }

  if (cbData === 'wiz_back') {
    const idx = WIZARD_STEP_ORDER.indexOf(w.step);
    if (idx > 0) w.step = WIZARD_STEP_ORDER[idx - 1];
    store.set(chatId, data);
    await sendWizardStep(chatId, token, w);
    return;
  }

  if (w.step === 'description' && cbData === 'wiz_skip_desc') { w.data.description = ''; w.step = 'date'; }
  else if (w.step === 'date' && cbData === 'wiz_skip_date') { w.data.reminder = ''; w.data.dateLabel = ''; w.step = 'recur'; }
  else if (w.step === 'recur' && cbData === 'wiz_recur_week') { store.set(chatId, data); await sendWizardStep(chatId, token, w, 'week'); return; }
  else if (w.step === 'recur' && cbData === 'wiz_recur_month') { store.set(chatId, data); await sendWizardStep(chatId, token, w, 'month'); return; }
  else if (w.step === 'recur' && cbData === 'wiz_recur_menu') { store.set(chatId, data); await sendWizardStep(chatId, token, w); return; }
  else if (w.step === 'recur' && cbData.startsWith('wiz_recur_set_')) { w.data.recurRule = cbData.slice('wiz_recur_set_'.length); w.step = 'folder'; }
  else if (w.step === 'folder' && cbData === 'wiz_skip_folder') { w.data.folder = ''; w.step = 'confirm'; }
  else if (w.step === 'folder' && cbData.startsWith('wiz_folder_set_')) { w.data.folder = decodeURIComponent(cbData.slice('wiz_folder_set_'.length)); w.step = 'confirm'; }
  else if (w.step === 'confirm' && cbData === 'wiz_confirm') { await finishWizard(chatId, token, data); return; }
  else { return; }

  store.set(chatId, data);
  await sendWizardStep(chatId, token, w);
}

function answerCallbackQuery(callbackId, token, text) {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  const body = JSON.stringify({ callback_query_id: callbackId, text });
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

async function sendTelegramRaw(chatId, token, text, fallbackToken, fallbackChatId, replyMarkup) {
  const tok = token || fallbackToken;
  if (!tok) return null;
  const id = chatId || fallbackChatId;
  if (!id) return null;
  const url = `https://api.telegram.org/bot${tok}/sendMessage`;
  const payload = { chat_id: id, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ── Уведомление владельца, когда получатель отмечает общую заметку выполненной ─
function notifyOwnersOfDoneSharedNotes(user, incomingNotes) {
  try {
    const oldById = new Map((user.notes || []).map(n => [n.id, n]));
    for (const n of incomingNotes) {
      if (!n || !n.shared || !n.sharedBy || !n.done) continue;
      const old = oldById.get(n.id);
      if (old && old.done) continue; // уже было выполнено — не дублируем уведомление
      if (n.doneNotified) continue;
      const owner = users.get(String(n.sharedBy).toLowerCase());
      if (owner && owner.telegramChatId) {
        sendTelegramRaw(owner.telegramChatId, DEFAULT_BOT_TOKEN,
          `✅ <b>${user.login}</b> отметил(а) вашу общую заметку «${n.title || '(без названия)'}» выполненной`);
      }
      n.doneNotified = true;
    }
  } catch (e) { console.error('[notify] error:', e.message); }
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
  const body = JSON.stringify({ url: webhookUrl, allowed_updates: ['message','callback_query'] });
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
    const body = JSON.stringify({ url: webhookUrl, allowed_updates: ['message','callback_query'] });
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
        res.end(`✅ Webhook зарегистрирован!\nURL: ${webhookUrl}\n\nТеперь команды /notes /ping /start работают в боте.`);
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

  // ── POST /auth/register {login, password} ─────────────────────────────────
  // ── POST /auth/register {login, password, regKey} ──────────────────────────
  // Регистрация закрыта: нужен секретный ключ REGISTRATION_KEY (переменная
  // окружения на сервере). Без него никто новый зарегистрироваться не может —
  // только тот, кто знает ключ (то есть владелец).
  if (req.method === 'POST' && req.url === '/auth/register') {
    try {
      const { login, password, regKey } = JSON.parse(await readBody(req));
      if (!isRegistrationKeyValid(regKey)) {
        res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Регистрация закрыта — нужен действующий секретный код'})); return;
      }
      const loginNorm = String(login||'').trim();
      const key = loginNorm.toLowerCase();
      if (!key || key.length < 3) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Логин минимум 3 символа'})); return; }
      if (key.length > 8) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Логин максимум 8 символов'})); return; }
      if (!password || String(password).trim().length < 4) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пароль минимум 4 символа (пробелы не считаются)'})); return; }
      if (users.has(key)) { res.writeHead(409,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Такой логин уже занят'})); return; }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(String(password), salt);
      const user = { login: loginNorm, salt, hash, incoming: [], verified: false, displayName: null, plan: 'free' };
      users.set(key, user);
      saveUsers();
      markRegCodeUsedIfMatches(regKey);
      const token = makeToken();
      sessions.set(token, key);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, token, login: loginNorm, verified: false, displayName: null, plan: 'free' }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── POST /auth/login {login, password} ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/auth/login') {
    try {
      const { login, password } = JSON.parse(await readBody(req));
      const key = String(login||'').trim().toLowerCase();
      const user = users.get(key);
      if (!user) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Неверный логин или пароль'})); return; }
      if (user.disabled) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Этот аккаунт отключён администратором'})); return; }
      const hash = hashPassword(String(password||''), user.salt);
      if (hash !== user.hash) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Неверный логин или пароль'})); return; }
      const token = makeToken();
      sessions.set(token, key);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, token, login: user.login, verified: !!user.verified, displayName: user.displayName || null, plan: user.plan || 'free' }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── POST /account/link-telegram {token, chatid} — привязать Chat ID к логину,
  // чтобы сервер мог слать владельцу уведомления (например «заметку выполнили») ─
  if (req.method === 'POST' && req.url === '/account/link-telegram') {
    try {
      const { token, chatid } = JSON.parse(await readBody(req));
      const key = sessions.get(token);
      if (!key) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Не авторизован'})); return; }
      const user = users.get(key);
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Аккаунт не найден'})); return; }
      user.telegramChatId = String(chatid || '').trim() || null;
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── POST /account/notes {token, notes} — сохранить все заметки аккаунта ────
  // Это и есть межустройственная синхронизация: один логин — одни заметки
  // (включая рисунки, вложения) на любом устройстве.
  if (req.method === 'POST' && req.url === '/account/notes') {
    try {
      const { token, notes } = JSON.parse(await readBody(req));
      const key = sessions.get(token);
      if (!key) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Не авторизован'})); return; }
      const user = users.get(key);
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Аккаунт не найден'})); return; }
      if (user.disabled) { sessions.delete(token); res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Аккаунт отключён'})); return; }
      const incomingNotes = Array.isArray(notes) ? notes : [];
      const limit = user.plan === 'plus' ? PLUS_NOTES_LIMIT : FREE_NOTES_LIMIT;
      if (incomingNotes.length > limit) {
        res.writeHead(413,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok:false, error: `Превышен лимит заметок (${limit}) для вашего тарифа. Удалите часть заметок${user.plan!=='plus' ? ' или оформите подписку Plus (до '+PLUS_NOTES_LIMIT+')' : ''}.` }));
        return;
      }
      notifyOwnersOfDoneSharedNotes(user, incomingNotes);
      user.notes = incomingNotes;
      user.notesUpdated = Date.now();
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, count: user.notes.length, updated: user.notesUpdated }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── GET /account/notes?token=XXX — забрать заметки аккаунта с сервера ──────
  if (req.method === 'GET' && req.url.startsWith('/account/notes')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const token = urlObj.searchParams.get('token');
    const key = sessions.get(token);
    if (!key) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Не авторизован'})); return; }
    const user = users.get(key);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true, notes: user?.notes || [], updated: user?.notesUpdated || 0 }));
    return;
  }

  // ── POST /notes/share {token, targetLogin, note} — отправить заметку другому логину ─
  if (req.method === 'POST' && req.url === '/notes/share') {
    try {
      const { token, targetLogin, note } = JSON.parse(await readBody(req));
      const fromKey = sessions.get(token);
      if (!fromKey) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Не авторизован'})); return; }
      const targetKey = String(targetLogin||'').trim().toLowerCase();
      const target = users.get(targetKey);
      if (!target) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пользователь с таким логином не найден'})); return; }
      if (!note || !note.id) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Нет заметки'})); return; }
      if (note.shared) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Эту заметку нельзя переслать дальше — вы получили её от другого пользователя'})); return; }
      const fromUser = users.get(fromKey);
      const sharedNote = { ...note, sharedBy: (fromUser?.verified && fromUser?.displayName) || fromUser?.login || fromKey, sharedByVerified: !!fromUser?.verified, sharedByPlan: fromUser?.plan || 'free', shared: true, id: note.id };
      target.incoming = target.incoming || [];
      target.incoming.push(sharedNote);
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── GET /notes/inbox?token=XXX — забрать заметки, которыми поделились ──────
  if (req.method === 'GET' && req.url.startsWith('/notes/inbox')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const token = urlObj.searchParams.get('token');
    const key = sessions.get(token);
    if (!key) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Не авторизован'})); return; }
    const user = users.get(key);
    const incoming = user?.incoming || [];
    if (user) { user.incoming = []; saveUsers(); }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true, notes: incoming }));
    return;
  }

  // ── Админ-эндпоинты: требуют переменную окружения ADMIN_KEY на сервере.
  // Пароли хранятся только как необратимый scrypt-хэш — «посмотреть» существующий
  // пароль невозможно технически (это и есть цель хэширования: даже если сервер
  // скомпрометируют, настоящие пароли никто не узнает). Для возврата доступа к
  // аккаунту сервер умеет только выдать НОВЫЙ временный пароль.
  // ── Код регистрации: создать / деактивировать / статус ─────────────────────
  if (req.method === 'POST' && req.url === '/admin/regcode/create') {
    try {
      const { adminKey } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      // Только цифры, 4 знака — легче продиктовать/ввести, чем буквы+цифры
      let code = '';
      const randBytes = crypto.randomBytes(4);
      for (let i = 0; i < 4; i++) code += String(randBytes[i] % 10);
      const now = Date.now();
      regCode = { code, createdAt: now, expiresAt: now + REG_CODE_TTL_MS, active: true, used: false };
      saveRegCode();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, code, expiresAt: regCode.expiresAt }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/admin/regcode/deactivate') {
    try {
      const { adminKey } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      if (regCode) { regCode.active = false; saveRegCode(); }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── Резервное копирование пользователей: статус / бэкап сейчас / восстановить ──
  if (req.method === 'GET' && req.url === '/admin/backup/status') {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({
      ok:true,
      configured: !!(GIST_BACKUP_TOKEN && GIST_BACKUP_ID),
      userCount: users.size,
      lastBackupAt: lastBackupAt || null,
      lastBackupError: lastBackupError || null
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/admin/backup/now') {
    try {
      const { adminKey } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      if (!GIST_BACKUP_TOKEN || !GIST_BACKUP_ID) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Резервное копирование не настроено на сервере (нет GIST_BACKUP_TOKEN/GIST_BACKUP_ID)'})); return; }
      const result = await backupUsersToGist();
      if (!result.ok) { res.writeHead(502,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error: result.error })); return; }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, userCount: users.size, lastBackupAt }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/admin/backup/restore') {
    try {
      const { adminKey } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      const result = await restoreUsersFromGistMerge();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, merged: result.merged, total: result.total }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/admin/regcode/status')) {
    try {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, active: isRegCodeActive(), expiresAt: (regCode && regCode.active) ? regCode.expiresAt : null, used: !!(regCode && regCode.used) }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/admin/users/toggle-disabled') {
    try {
      const { adminKey, login, disabled } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      const user = users.get(String(login||'').trim().toLowerCase());
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пользователь не найден'})); return; }
      user.disabled = !!disabled;
      if (user.disabled) { for (const [tok, key] of sessions.entries()) { if (key === user.login.toLowerCase()) sessions.delete(tok); } }
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, login:user.login, disabled:user.disabled }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── POST /admin/users/toggle-verified — выдать/снять галочку "официальный
  // аккаунт". Официальным аккаунтам открываются: прямой просмотр состояния
  // сервера (без похода на страницу мониторинга) и функции модерации.
  // Как только галочку снимают — эти пункты меню у пользователя сразу пропадают.
  if (req.method === 'POST' && req.url === '/admin/users/toggle-verified') {
    try {
      const { adminKey, login, verified } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      const user = users.get(String(login||'').trim().toLowerCase());
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пользователь не найден'})); return; }
      user.verified = !!verified;
      if (!user.verified) user.displayName = null; // без галочки второй никнейм не имеет смысла
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, login:user.login, verified:user.verified }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── POST /admin/users/toggle-plan — выдать/снять подписку Plus (зелёная
  // галочка, лимит заметок 1000 вместо 100, разблокированы все функции сразу).
  if (req.method === 'POST' && req.url === '/admin/users/toggle-plan') {
    try {
      const { adminKey, login, plan } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      const user = users.get(String(login||'').trim().toLowerCase());
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пользователь не найден'})); return; }
      user.plan = (plan === 'plus') ? 'plus' : 'free';
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, login:user.login, plan:user.plan }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── POST /admin/telegram/send-reset-code — отправить код смены пароля
  // конкретному пользователю в Telegram прямо из меню мониторинга (без того,
  // чтобы сам пользователь запрашивал код через приложение).
  if (req.method === 'POST' && req.url === '/admin/telegram/send-reset-code') {
    try {
      const { adminKey, login } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      const key = String(login||'').trim().toLowerCase();
      const result = await issuePasswordResetCode(key);
      if (!result.ok) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify(result)); return; }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── POST /account/set-displayname {token, displayName} — второй никнейм,
  // доступен только официальным (verified) аккаунтам. Используется вместо
  // логина везде, где показывается "от кого"/"кому" заметка.
  if (req.method === 'POST' && req.url === '/account/set-displayname') {
    try {
      const { token, displayName } = JSON.parse(await readBody(req));
      const key = sessions.get(token);
      if (!key) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Не авторизован'})); return; }
      const user = users.get(key);
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Аккаунт не найден'})); return; }
      if (!user.verified) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Второй никнейм доступен только официальным аккаунтам'})); return; }
      const name = String(displayName||'').trim();
      if (name && (name.length < 2 || name.length > 12)) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Никнейм должен быть от 2 до 12 символов'})); return; }
      user.displayName = name || null;
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, displayName: user.displayName }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── Смена пароля по коду из Telegram ────────────────────────────────────────
  // POST /auth/request-reset-code {login} — присылает 6-значный код в Telegram
  // владельца ЭТОГО логина (если у него привязан Chat ID). Код одноразовый,
  // короткоживущий, и действует только для того аккаунта, который его запросил.
  if (req.method === 'POST' && req.url === '/auth/request-reset-code') {
    try {
      const { login } = JSON.parse(await readBody(req));
      const key = String(login||'').trim().toLowerCase();
      const result = await issuePasswordResetCode(key);
      // Не сообщаем, существует ли логин / привязан ли Telegram — чтобы нельзя
      // было угадывать чужие логины перебором ответов.
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, message: 'Если у этого логина привязан Telegram, код отправлен.' }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── POST /auth/reset-password-with-code {login, code, newPassword} ─────────
  if (req.method === 'POST' && req.url === '/auth/reset-password-with-code') {
    try {
      const { login, code, newPassword } = JSON.parse(await readBody(req));
      const key = String(login||'').trim().toLowerCase();
      const rec = passwordResetCodes.get(key);
      if (!rec || rec.used || Date.now() > rec.expiresAt || String(code||'').trim() !== rec.code) {
        res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Неверный или истёкший код'})); return;
      }
      const pass = String(newPassword||'').trim();
      if (pass.length < 4) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пароль минимум 4 символа'})); return; }
      const user = users.get(key);
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Аккаунт не найден'})); return; }
      rec.used = true; // код одноразовый — сразу помечаем использованным, повторно применить нельзя
      const salt = crypto.randomBytes(16).toString('hex');
      user.salt = salt; user.hash = hashPassword(pass, salt);
      for (const [tok, k] of sessions.entries()) { if (k === key) sessions.delete(tok); }
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/admin/users/set-password') {
    try {
      const { adminKey, login, newPassword } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      const user = users.get(String(login||'').trim().toLowerCase());
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пользователь не найден'})); return; }
      const pass = String(newPassword||'').trim();
      if (pass.length < 4) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пароль слишком короткий (минимум 4 символа, без учёта пробелов)'})); return; }
      const salt = crypto.randomBytes(16).toString('hex');
      user.salt = salt; user.hash = hashPassword(pass, salt);
      for (const [tok, key] of sessions.entries()) { if (key === user.login.toLowerCase()) sessions.delete(tok); }
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, login:user.login }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  if (req.method === 'POST' && req.url === '/admin/users/reset-password') {
    try {
      const { adminKey, login } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, adminKey)) return;
      const user = users.get(String(login||'').trim().toLowerCase());
      if (!user) { res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пользователь не найден'})); return; }
      const newPassword = crypto.randomBytes(6).toString('base64url');
      const salt = crypto.randomBytes(16).toString('hex');
      user.salt = salt; user.hash = hashPassword(newPassword, salt);
      for (const [tok, key] of sessions.entries()) { if (key === user.login.toLowerCase()) sessions.delete(tok); }
      saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, login:user.login, newPassword }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── GET /users/search?q=… — публичный поиск логинов (для автодополнения при
  // расшаривании заметки и для страницы статуса). НИКОГДА не отдаёт пароль/хэш.
  if (req.method === 'GET' && req.url.startsWith('/users/search')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
    const results = [...users.values()]
      .filter(u => !q || u.login.toLowerCase().includes(q))
      .slice(0, 50)
      .map(u => ({ login: u.login, notesCount: (u.notes || []).length, updated: u.notesUpdated || 0, disabled: !!u.disabled, verified: !!u.verified, displayName: u.displayName || null, plan: u.plan || 'free' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, users: results }));
    return;
  }

  // ── GET /pending?chatid=XXX — забираем заметки и изменения из Telegram ────
  // (новые заметки, написанные боту текстом, и нажатия inline-кнопок под
  // напоминаниями). Отдаётся один раз и сразу очищается — как почтовый ящик.
  if (req.method === 'GET' && req.url.startsWith('/pending')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const chatid = urlObj.searchParams.get('chatid');
    if (!chatid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing chatid' }));
      return;
    }
    const data = store.get(chatid);
    const newNotes = data?.pendingNew || [];
    const changes = data?.pendingChanges || [];
    if (data) { data.pendingNew = []; data.pendingChanges = []; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, newNotes, changes }));
    return;
  }

  // ── GET /tg/getMe?token=XXX — прокси к Telegram API ───────────────────────
  // Нужен, потому что api.telegram.org часто блокируется провайдерами в РФ,
  // а этот сервер находится за границей и такой проблемы не имеет.
  if (req.method === 'GET' && req.url.startsWith('/tg/getMe')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const token = urlObj.searchParams.get('token');
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'missing token' }));
      return;
    }
    const apiUrl = `https://api.telegram.org/bot${token}/getMe`;
    https.get(apiUrl, apiRes => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode || 200, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    }).on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'proxy error' }));
    });
    return;
  }

  // ── POST /tg/sendMessage — прокси к Telegram API ──────────────────────────
  if (req.method === 'POST' && req.url === '/tg/sendMessage') {
    try {
      const raw = await readBody(req);
      const { token, chat_id, text, parse_mode } = JSON.parse(raw);
      if (!token || !chat_id || !text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'missing token/chat_id/text' }));
        return;
      }
      const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
      const body = JSON.stringify({ chat_id, text, parse_mode: parse_mode || 'HTML' });
      const apiReq = https.request(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, apiRes => {
        let data = '';
        apiRes.on('data', c => data += c);
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode || 200, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      apiReq.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'proxy error' }));
      });
      apiReq.write(body);
      apiReq.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
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
      const existing = store.get(account.chatid) || { fired: {}, pendingNew: [], pendingChanges: [], msgMap: {} };
      store.set(account.chatid, { notes: notes || [], account, fired: existing.fired, pendingNew: existing.pendingNew || [], pendingChanges: existing.pendingChanges || [], msgMap: existing.msgMap || {} });
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

  // ── GET /status/public — безопасная публичная статистика сервера, без
  // авторизации. Отдаёт ТОЛЬКО то, что не является чувствительной информацией
  // (никаких логинов, паролей, ключей). Используется: (1) страницей мониторинга
  // для любого логина кроме admin/admin1 — им показывается только это; (2)
  // официальными (verified) аккаунтами в приложении для прямого просмотра
  // состояния сервера без похода на страницу мониторинга.
  if (req.method === 'GET' && req.url === '/status/public') {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
    const totalNotes = [...store.values()].reduce((acc, d) => acc + (d.notes?.length || 0), 0);
    const activeNotes = [...store.values()].reduce((acc, d) => acc + (d.notes?.filter(n=>!n.done).length || 0), 0);
    const totalFired = [...store.values()].reduce((acc, d) => acc + Object.keys(d.fired || {}).length, 0);
    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({
      ok:true, uptimeStr: `${h}ч ${m}м ${s}с`, sessions: store.size, totalNotes, activeNotes,
      totalFired, memMB, serverTime: new Date().toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})
    }));
    return;
  }

  // ── POST /admin/gate-check {password} — второй шаг входа в меню мониторинга.
  // Логин "admin"/"admin1" проверяется только на клиенте (UX-развилка); реальная
  // защита — этот пароль (тот же ADMIN_KEY), с той же блокировкой при переборе.
  if (req.method === 'POST' && req.url === '/admin/gate-check') {
    try {
      const { password } = JSON.parse(await readBody(req));
      if (!checkAdminKey(req, res, password)) return;
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── GET /account/server-status?token=XXX — прямой просмотр состояния сервера
  // для официальных (verified) аккаунтов, без похода на отдельную страницу.
  if (req.method === 'GET' && req.url.startsWith('/account/server-status')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const token = urlObj.searchParams.get('token');
    const key = sessions.get(token);
    const user = key && users.get(key);
    if (!user || !user.verified) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Доступно только официальным аккаунтам'})); return; }
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:true, uptimeStr: `${h}ч ${m}м`, sessions: store.size, totalUsers: users.size,
      totalNotes: [...store.values()].reduce((a,d)=>a+(d.notes?.length||0),0) }));
    return;
  }

  // ── POST /account/moderation/broadcast {token, text} — функция модерации
  // для официальных аккаунтов: разослать сообщение всем пользователям в Telegram.
  if (req.method === 'POST' && req.url === '/account/moderation/broadcast') {
    try {
      const { token, text } = JSON.parse(await readBody(req));
      const key = sessions.get(token);
      const user = key && users.get(key);
      if (!user || !user.verified) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Доступно только официальным аккаунтам'})); return; }
      const msg = String(text||'').trim().slice(0, 500);
      if (!msg) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пустое сообщение'})); return; }
      let sent = 0;
      for (const u of users.values()) {
        if (!u.telegramChatId) continue;
        sent++;
        const body = JSON.stringify({ chat_id: u.telegramChatId, text: '📢 <b>Объявление Nota</b>\n\n' + msg, parse_mode: 'HTML' });
        const r = https.request(`https://api.telegram.org/bot${DEFAULT_BOT_TOKEN}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, resp=>{ resp.on('data',()=>{}); });
        r.on('error', ()=>{}); r.write(body); r.end();
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, sentTo: sent }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }
  // ── POST /account/moderation/hide-shared-note {token, noteId, fromLogin} —
  // скрыть (удалить из входящих) неподобающую заметку, присланную кем-то,
  // не дожидаясь, пока получатель сам её увидит.
  if (req.method === 'POST' && req.url === '/account/moderation/hide-shared-note') {
    try {
      const { token, noteId } = JSON.parse(await readBody(req));
      const key = sessions.get(token);
      const modUser = key && users.get(key);
      if (!modUser || !modUser.verified) { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Доступно только официальным аккаунтам'})); return; }
      let removed = 0;
      for (const u of users.values()) {
        if (!Array.isArray(u.incoming)) continue;
        const before = u.incoming.length;
        u.incoming = u.incoming.filter(n => n.id !== noteId);
        removed += before - u.incoming.length;
      }
      if (removed) saveUsers();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, removed }));
    } catch(e) {
      res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message}));
    }
    return;
  }

  // ── GET / — страница статуса / мониторинга ─────────────────────────────────
  if (req.method === 'GET' && req.url === '/') {
    // Раньше вход был через системное окно HTTP Basic Auth (логин игнорировался,
    // важен был только пароль). Теперь — свой двухшаговый вход в стиле сайта:
    // 1) вводится логин; 2) если это "admin" или "admin1" — просят пароль
    // (ADMIN_KEY) и открывают полную панель; любой другой логин сразу показывает
    // только статус сервера (без пароля, без чувствительных данных).
    // Никакие цифры/данные сервера в саму HTML-страницу больше не зашиваются —
    // всё подгружается через /status/public и /admin/gate-check уже в браузере.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache' });
    res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nota — сервер уведомлений</title>
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
.subtitle{font-size:12px;color:var(--text3);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:32px;font-weight:600;text-align:center;width:100%;}
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
/* Двухшаговый вход в стиле сайта: логин → (если admin/admin1) пароль */
#gate-wrap{width:100%;max-width:360px;margin:60px auto;display:flex;flex-direction:column;gap:14px;}
#gate-card{background:var(--glass-bg-strong);border:1px solid var(--glass-border);border-radius:18px;
  padding:26px 24px;box-shadow:0 8px 28px rgba(0,0,0,0.35),inset 0 1px 0 rgba(255,255,255,0.05);}
#gate-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-style:italic;color:var(--accent2);margin-bottom:4px;}
#gate-sub{font-size:11px;color:var(--text3);margin-bottom:16px;font-weight:600;}
.gate-input{width:100%;font-size:14px;padding:11px 13px;border-radius:10px;border:1px solid var(--glass-border);
  background:rgba(255,255,255,0.05);color:var(--text);margin-bottom:10px;font-family:inherit;box-sizing:border-box;}
#gate-error{font-size:11px;color:var(--red);font-weight:600;min-height:14px;margin-bottom:8px;}
.gate-btn{width:100%;font-size:13px;font-weight:700;padding:11px 16px;border-radius:10px;border:none;cursor:pointer;
  font-family:inherit;background:var(--accent);color:#1a1408;}
#main-content{display:none;width:100%;flex-direction:column;align-items:center;}
/* Кастомная модалка — не полагаемся на window.prompt/alert/confirm,
   которые не работают в некоторых мобильных браузерах и веб-вью */
#admin-modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;
  align-items:center;justify-content:center;padding:20px;}
#admin-modal-backdrop.open{display:flex;}
#admin-modal-card{background:var(--glass-bg-strong);border:1px solid var(--glass-border);border-radius:16px;
  padding:20px;max-width:360px;width:100%;box-shadow:0 20px 50px rgba(0,0,0,0.5);}
#admin-modal-title{font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px;}
#admin-modal-message{font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.5;font-weight:600;}
#admin-modal-input{width:100%;font-size:14px;padding:10px 12px;border-radius:10px;border:1px solid var(--glass-border);
  background:rgba(255,255,255,0.05);color:var(--text);margin-bottom:14px;font-family:inherit;box-sizing:border-box;}
#admin-modal-buttons{display:flex;gap:8px;justify-content:flex-end;}
.admin-modal-btn{font-size:13px;font-weight:700;padding:9px 16px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;}
.admin-modal-btn.primary{background:var(--accent);color:#1a1408;}
.admin-modal-btn.ghost{background:rgba(255,255,255,0.06);color:var(--text2);}
/* Полноэкранный показ кода регистрации — в стиле экрана входа основного
   приложения (Nota): на весь экран, крупно, чтобы было видно издалека
   или легко продиктовать по телефону. */
#regcode-fullscreen{display:none;position:fixed;inset:0;z-index:2000;background:var(--bg,#1a1408);
  flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;}
#regcode-fullscreen.open{display:flex;}
.regcode-fs-label{font-family:'IBM Plex Sans',sans-serif;font-size:13px;font-weight:700;letter-spacing:0.08em;
  text-transform:uppercase;color:var(--text3);margin-bottom:18px;}
.regcode-fs-code{font-family:'IBM Plex Mono',monospace;font-size:min(20vw,110px);font-weight:700;letter-spacing:0.12em;
  color:var(--accent2);line-height:1;word-break:break-all;}
.regcode-fs-timer{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:600;color:var(--text2);margin-top:26px;}
.regcode-fs-buttons{display:flex;gap:10px;margin-top:36px;flex-wrap:wrap;justify-content:center;}
</style>
</head>
<body>
  <div id="regcode-fullscreen">
    <div class="regcode-fs-label">Код регистрации Nota</div>
    <div class="regcode-fs-code" id="regcode-fs-code">— — — —</div>
    <div class="regcode-fs-timer" id="regcode-fs-timer">неактивен</div>
    <div class="regcode-fs-buttons">
      <button class="admin-modal-btn ghost" onclick="closeRegCodeFullscreen()">Закрыть</button>
      <button class="admin-modal-btn primary" onclick="deactivateRegCode()">⛔ Деактивировать</button>
    </div>
  </div>
  <div id="admin-modal-backdrop">
    <div id="admin-modal-card">
      <div id="admin-modal-title"></div>
      <div id="admin-modal-message"></div>
      <input id="admin-modal-input" type="text" style="display:none;">
      <div id="admin-modal-buttons"></div>
    </div>
  </div>
  <div id="gate-wrap">
    <div id="gate-card">
      <div id="gate-title">Nota</div>
      <div id="gate-sub">Вход в меню мониторинга сервера</div>
      <div id="gate-error"></div>
      <form id="gate-step1" onsubmit="return gateSubmitLogin(event)" autocomplete="off">
        <input class="gate-input" id="gate-login-input" type="text" placeholder="Логин" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="gate-btn" type="submit">Продолжить</button>
      </form>
      <form id="gate-step2" style="display:none;" onsubmit="return gateSubmitPassword(event)" autocomplete="off">
        <input class="gate-input" id="gate-password-input" type="password" placeholder="Пароль (ADMIN_KEY)" autocomplete="new-password" spellcheck="false">
        <button class="gate-btn" type="submit">Войти</button>
      </form>
    </div>
  </div>
  <div id="main-content">
  <h1>Nota</h1>
  <div class="subtitle" id="page-subtitle">Сервер уведомлений</div>
  <div class="grid">
    <div class="card">
      <div class="status-row"><span class="dot"></span><div class="card-label" style="margin:0;">Статус</div></div>
      <div class="card-value" style="font-size:16px;color:var(--done);margin-top:6px;">Работает</div>
      <div class="card-sub" id="stat-uptime">Uptime: —</div>
    </div>
    <div class="card">
      <div class="card-label">Пользователи</div>
      <div class="card-value" id="stat-sessions">—</div>
      <div class="card-sub">Активных сессий</div>
    </div>
    <div class="card">
      <div class="card-label">Заметки</div>
      <div class="card-value" id="stat-notes">—</div>
      <div class="card-sub" id="stat-notes-active">—</div>
    </div>
    <div class="card">
      <div class="card-label">Уведомлений отправлено</div>
      <div class="card-value" id="stat-fired">—</div>
      <div class="card-sub">За всё время</div>
    </div>
    <div class="card">
      <div class="card-label">Память</div>
      <div class="card-value" id="stat-mem">—</div>
      <div class="card-sub">RSS процесса</div>
    </div>
    <div class="card">
      <div class="card-label">Проверка</div>
      <div class="card-value" style="font-size:16px;">каждую</div>
      <div class="card-sub">минуту</div>
    </div>
  </div>
  <div id="admin-only-sections" style="display:none;width:100%;flex-direction:column;align-items:center;">
  <div class="info-card">
    <b>Ссылки:</b><br>
    <a class="ep" href="https://merttpamston.github.io/elegia/" target="_blank" rel="noopener">🌐 Сайт Nota</a>
    <a class="ep" href="https://dashboard.render.com/web/srv-d8qg5q0js32c7392pp2g/logs?t=app&r=1h" target="_blank" rel="noopener">📜 Логи сервера</a>
    <a class="ep" href="https://elegia-notifications.onrender.com/" target="_blank" rel="noopener">📡 Мониторинг сервера</a><br>
    <a class="ep" href="#" onclick="setWebhook(); return false;">🔗 Поставить Webhook</a>
    <a class="ep" href="#" onclick="deleteWebhook(); return false;">✂️ Удалить Webhook</a>
    <a class="ep" href="#" onclick="getUpdatesInfo(); return false;">👥 Инфо о пользователях бота</a>
  </div>
  <div class="info-card">
    <b>Telegram команды бота:</b><br>
    <span class="ep">/start</span> · <span class="ep">/help</span> — справка по всем командам<br>
    <span class="ep">/create</span> · <span class="ep">/cancel</span> — создать заметку по шагам с кнопками<br>
    <span class="ep">/notes</span> · <span class="ep">/today</span> · <span class="ep">/tomorrow</span> · <span class="ep">/overdue</span> · <span class="ep">/done_list</span><br>
    <span class="ep">/search текст</span> · <span class="ep">/stats</span><br>
    <span class="ep">/done N</span> · <span class="ep">/delete N</span> · <span class="ep">/priority N уровень</span><br>
    <span class="ep">/telegram</span>
  </div>
  <div class="info-card" style="max-width:820px;width:100%;">
    <b>💾 Резервное копирование аккаунтов:</b><br>
    <div id="backup-status" style="margin-top:8px;font-size:13px;font-weight:700;color:var(--text2);">Загрузка…</div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
      <button class="ep" style="cursor:pointer;border:none;" onclick="backupNow()">💾 Сделать бэкап сейчас</button>
      <button class="ep" style="cursor:pointer;border:none;" onclick="restoreBackup()">♻️ Восстановить из бэкапа</button>
    </div>
    <div style="font-size:10px;color:var(--text3);margin-top:8px;font-weight:600;">Это то, что гарантирует: старые аккаунты не пропадают при обновлении сервера на Render (там диск стирается при каждом деплое), и в любой старый аккаунт всегда можно зайти. Бэкап автоматически сохраняется в приватный GitHub Gist при каждой регистрации/смене пароля, и дополнительно каждые 10 минут в фоне. «Восстановить из бэкапа» — безопасная операция: она только добавляет аккаунты, которых сейчас нет на сервере, и никогда не трогает и не удаляет уже существующие. Требует переменные окружения GIST_BACKUP_TOKEN и GIST_BACKUP_ID на сервере — без них кнопки работать не будут.</div>
  </div>
  <div class="info-card" style="max-width:820px;width:100%;">
    <b>🔑 Код регистрации:</b><br>
    <div id="regcode-status" style="margin-top:8px;font-size:13px;font-weight:700;color:var(--text2);">Загрузка…</div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
      <button class="ep" style="cursor:pointer;border:none;" onclick="createRegCode()">✚ Создать новый код (1 день)</button>
      <button class="ep" style="cursor:pointer;border:none;" onclick="deactivateRegCode()">⛔ Деактивировать</button>
    </div>
    <div style="font-size:10px;color:var(--text3);margin-top:8px;font-weight:600;">Код — 4 цифры, действует 1 день (24 часа) с момента создания, после чего перестаёт работать сам по себе и не может быть возвращён. Он одноразовый: как только по нему создан хотя бы один аккаунт, код сразу помечается использованным и повторно применить его нельзя, даже если время ещё не вышло. Его можно деактивировать раньше вручную. Создать код может только тот, кто знает ключ администратора (ADMIN_KEY). Код не привязан к аккаунтам — если его деактивировать/он истечёт/будет использован, уже созданные через него аккаунты не удаляются.</div>
  </div>
  <div class="info-card" style="max-width:820px;width:100%;">
    <b>Поиск пользователей:</b><br>
    <div style="display:flex;gap:8px;margin-top:6px;">
      <input id="user-search-input" type="text" placeholder="Начните вводить логин…" autocomplete="off" inputmode="text" enterkeyhint="search"
        style="flex:1;min-width:0;padding:9px 12px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(255,255,255,0.04);color:var(--text);font-family:inherit;font-size:13px;box-sizing:border-box;">
      <button class="ep" style="cursor:pointer;border:none;white-space:nowrap;" onclick="runUserSearch(document.getElementById('user-search-input').value.trim())">🔍 Найти</button>
    </div>
    <div id="user-search-results" style="margin-top:10px;display:flex;flex-direction:column;gap:6px;"></div>
    <div style="font-size:10px;color:var(--text3);margin-top:8px;font-weight:600;">Показаны логин, число заметок и дата последней синхронизации, официальный статус (галочка), подписка Plus и второй никнейм. Пароли и хэши паролей здесь никогда не показываются. «Задать пароль» позволяет ввести конкретный новый пароль, «📨 Код в Telegram» — присылает пользователю код смены пароля прямо в Telegram, «✓ Официальный» — выдаёт/снимает галочку официального аккаунта, «⭐ Plus» — выдаёт/снимает подписку Plus. Все действия требуют ключ администратора (ADMIN_KEY).</div>
  </div>
  <div class="time" id="server-time"></div>
  </div>
  </div>
  <script>
    // ── Двухшаговый вход (логин → пароль для admin/admin1) ──────────────────
    let gateAdminKey = '';
    let gateIsAdmin = false;
    function gateSubmitLogin(e) {
      e.preventDefault();
      const login = document.getElementById('gate-login-input').value.trim().toLowerCase();
      document.getElementById('gate-error').textContent = '';
      if (login === 'admin' || login === 'admin1') {
        gateIsAdmin = true;
        document.getElementById('gate-step1').style.display = 'none';
        document.getElementById('gate-step2').style.display = '';
        setTimeout(() => document.getElementById('gate-password-input').focus(), 50);
      } else {
        gateIsAdmin = false;
        openStatusOnlyView();
      }
      return false;
    }
    async function gateSubmitPassword(e) {
      e.preventDefault();
      const password = document.getElementById('gate-password-input').value;
      const errEl = document.getElementById('gate-error');
      errEl.textContent = '';
      try {
        const r = await fetch('/admin/gate-check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password }) });
        const d = await r.json();
        if (!d.ok) { errEl.textContent = d.error || 'Ошибка'; return false; }
        gateAdminKey = password;
        openAdminView();
      } catch (e2) { errEl.textContent = 'Сервер недоступен'; }
      return false;
    }
    function openStatusOnlyView() {
      document.getElementById('gate-wrap').style.display = 'none';
      document.getElementById('main-content').style.display = 'flex';
      document.getElementById('page-subtitle').textContent = 'Статус сервера';
      loadPublicStatus();
    }
    function openAdminView() {
      document.getElementById('gate-wrap').style.display = 'none';
      document.getElementById('main-content').style.display = 'flex';
      document.getElementById('admin-only-sections').style.display = 'flex';
      document.getElementById('page-subtitle').textContent = 'Сервер уведомлений — панель администратора';
      loadPublicStatus();
      refreshBackupStatus();
      refreshRegCodeStatus();
      runUserSearch('');
    }
    async function loadPublicStatus() {
      try {
        const r = await fetch('/status/public');
        const d = await r.json();
        document.getElementById('stat-uptime').textContent = 'Uptime: ' + d.uptimeStr;
        document.getElementById('stat-sessions').textContent = d.sessions;
        document.getElementById('stat-notes').textContent = d.totalNotes;
        document.getElementById('stat-notes-active').textContent = d.activeNotes + ' активных';
        document.getElementById('stat-fired').textContent = d.totalFired;
        document.getElementById('stat-mem').innerHTML = d.memMB + ' <span style="font-size:14px;">МБ</span>';
        document.getElementById('server-time').textContent = 'Время сервера: ' + d.serverTime + ' (MSK)';
      } catch (e) {}
    }
    // ── Кастомная модалка вместо window.prompt/alert/confirm ────────────────
    // На части мобильных браузеров и веб-вью (например, встроенный браузер
    // некоторых приложений, PWA в режиме "на весь экран") нативные диалоги
    // window.prompt/alert/confirm либо не показываются, либо сразу возвращают
    // пустоту — из-за этого кнопки выглядят "нерабочими". Рисуем свои диалоги.
    function adminModalShow(title, message, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        const backdrop = document.getElementById('admin-modal-backdrop');
        const titleEl = document.getElementById('admin-modal-title');
        const msgEl = document.getElementById('admin-modal-message');
        const inputEl = document.getElementById('admin-modal-input');
        const btnsEl = document.getElementById('admin-modal-buttons');
        titleEl.textContent = title || '';
        msgEl.textContent = message || '';
        msgEl.style.display = message ? '' : 'none';
        let finished = false;
        function close(result) {
          if (finished) return;
          finished = true;
          backdrop.classList.remove('open');
          resolve(result);
        }
        if (opts.input) {
          inputEl.style.display = '';
          inputEl.type = opts.password ? 'password' : 'text';
          inputEl.value = opts.defaultValue || '';
          inputEl.placeholder = opts.placeholder || '';
          inputEl.autocomplete = 'off';
          inputEl.setAttribute('autocomplete', opts.password ? 'new-password' : 'off');
        } else {
          inputEl.style.display = 'none';
        }
        btnsEl.innerHTML = '';
        if (opts.showCancel !== false) {
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'admin-modal-btn ghost';
          cancelBtn.textContent = opts.cancelLabel || 'Отмена';
          cancelBtn.onclick = () => close(opts.input ? null : false);
          btnsEl.appendChild(cancelBtn);
        }
        const okBtn = document.createElement('button');
        okBtn.className = 'admin-modal-btn primary';
        okBtn.textContent = opts.okLabel || 'ОК';
        okBtn.onclick = () => close(opts.input ? inputEl.value : true);
        btnsEl.appendChild(okBtn);
        backdrop.classList.add('open');
        if (opts.input) setTimeout(() => inputEl.focus(), 50);
        inputEl.onkeydown = (e) => { if (e.key === 'Enter') okBtn.click(); };
      });
    }
    function adminPrompt(message, opts) { return adminModalShow(opts && opts.title || 'Введите значение', message, Object.assign({ input:true }, opts)); }
    function adminAlert(message, title) { return adminModalShow(title || 'Сообщение', message, { showCancel:false, okLabel:'Понятно' }); }
    function adminConfirm(message, title) { return adminModalShow(title || 'Подтверждение', message, { showCancel:true, okLabel:'Да', cancelLabel:'Отмена' }); }
    // Если уже вошли через шлюз (gate) с паролем admin/admin1 — не спрашиваем ключ повторно на каждое действие.
    async function getAdminKey(title) {
      if (gateAdminKey) return gateAdminKey;
      return adminPrompt('Ключ администратора (ADMIN_KEY)', { password:true, title });
    }

    let _lastCreatedRegCode = null; // код виден только сразу после создания — сервер его больше не отдаёт
    let _regcodeExpiresAt = null;
    let _regcodeTimer = null;
    function formatRegCodeRemaining(ms) {
      if (ms <= 0) return '00:00:00';
      const totalSec = Math.floor(ms / 1000);
      const hh = String(Math.floor(totalSec / 3600)).padStart(2,'0');
      const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2,'0');
      const ss = String(totalSec % 60).padStart(2,'0');
      return hh + ':' + mm + ':' + ss;
    }
    function renderRegCodeStatus(active, expiresAt, used) {
      const el = document.getElementById('regcode-status');
      clearTimeout(_regcodeTimer);
      if (used && !active) {
        el.innerHTML = '<span style="color:var(--text3);">Код уже использован (создан аккаунт) — повторно применить нельзя</span>';
        _lastCreatedRegCode = null;
        closeRegCodeFullscreen();
        return;
      }
      if (!active) {
        el.innerHTML = '<span style="color:var(--red);">Нет активного кода</span>';
        _lastCreatedRegCode = null;
        closeRegCodeFullscreen();
        return;
      }
      _regcodeExpiresAt = expiresAt;
      const fsCodeEl = document.getElementById('regcode-fs-code');
      const fsTimerEl = document.getElementById('regcode-fs-timer');
      const tick = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          el.innerHTML = '<span style="color:var(--red);">Код истёк</span>';
          if (fsTimerEl) fsTimerEl.textContent = 'код истёк';
          return;
        }
        el.innerHTML = 'Активен' + (_lastCreatedRegCode ? (': <code style="background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:6px;color:var(--accent2);">' + _lastCreatedRegCode + '</code>') : '') +
          ' · осталось <span style="color:var(--accent2);">' + formatRegCodeRemaining(remaining) + '</span>' +
          (_lastCreatedRegCode ? ' · <a href="#" onclick="openRegCodeFullscreen();return false;" style="color:var(--accent2);">🖥 на весь экран</a>' : '');
        if (fsTimerEl) fsTimerEl.textContent = 'осталось ' + formatRegCodeRemaining(remaining);
        _regcodeTimer = setTimeout(tick, 1000);
      };
      tick();
    }
    // ── Полноэкранный показ кода — во весь экран, крупным шрифтом, как окно
    // входа в основном приложении, чтобы код было легко прочитать/продиктовать.
    // Таймер внутри обновляется каждую секунду сам по себе (через tick() выше).
    function openRegCodeFullscreen() {
      if (!_lastCreatedRegCode) return;
      document.getElementById('regcode-fs-code').textContent = _lastCreatedRegCode;
      document.getElementById('regcode-fullscreen').classList.add('open');
    }
    function closeRegCodeFullscreen() {
      document.getElementById('regcode-fullscreen').classList.remove('open');
    }
    // fetch с таймаутом — если сервер не отвечает (например, "спит" на бесплатном
    // тарифе Render и не успел проснуться), через 15 секунд покажем ошибку
    // вместо вечной надписи "Загрузка…".
    async function fetchWithTimeout(url, opts, timeoutMs) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
      try {
        return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      } finally {
        clearTimeout(t);
      }
    }
    async function refreshRegCodeStatus() {
      try {
        const r = await fetchWithTimeout('/admin/regcode/status');
        const d = await r.json();
        renderRegCodeStatus(d.active, d.expiresAt, d.used);
      } catch(e) {
        document.getElementById('regcode-status').innerHTML = '<span style="color:var(--red);">Сервер не отвечает' + (e.name==='AbortError' ? ' (таймаут, возможно инстанс просыпается — попробуйте ещё раз через 20-30 сек)' : '') + '. <a href="#" onclick="refreshRegCodeStatus();return false;" style="color:var(--accent2);">Повторить</a></span>';
      }
    }
    async function createRegCode() {
      const adminKey = await getAdminKey('Создать код регистрации');
      if (!adminKey) return;
      try {
        const r = await fetchWithTimeout('/admin/regcode/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        _lastCreatedRegCode = d.code;
        renderRegCodeStatus(true, d.expiresAt);
        openRegCodeFullscreen();
      } catch(e) { await adminAlert(e.name==='AbortError' ? 'Сервер не ответил за 15 секунд (возможно инстанс просыпается) — попробуйте ещё раз' : 'Сервер недоступен', 'Ошибка'); }
    }
    async function deactivateRegCode() {
      const adminKey = await getAdminKey('Деактивировать код');
      if (!adminKey) return;
      try {
        const r = await fetchWithTimeout('/admin/regcode/deactivate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        refreshRegCodeStatus();
        await adminAlert('Код деактивирован. Уже созданные через него аккаунты остались.', 'Готово');
      } catch(e) { await adminAlert(e.name==='AbortError' ? 'Сервер не ответил за 15 секунд (возможно инстанс просыпается) — попробуйте ещё раз' : 'Сервер недоступен', 'Ошибка'); }
    }
    async function refreshBackupStatus() {
      const el = document.getElementById('backup-status');
      try {
        const r = await fetchWithTimeout('/admin/backup/status');
        const d = await r.json();
        if (!d.configured) {
          el.innerHTML = '<span style="color:var(--red);">⚠️ Не настроено</span> — задайте GIST_BACKUP_TOKEN и GIST_BACKUP_ID в переменных окружения на Render, иначе аккаунты не переживут обновление сервера';
        } else {
          const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          const when = d.lastBackupAt ? new Date(d.lastBackupAt).toLocaleString('ru-RU') : 'ещё ни разу';
          let html = '<span style="color:var(--accent2);">✅ Настроено</span> · аккаунтов на сервере: ' + d.userCount
            + '<br>последний успешный бэкап: ' + esc(when);
          if (d.lastBackupError) {
            html += '<br><span style="color:var(--red);">⚠️ последняя попытка не удалась: ' + esc(d.lastBackupError) + '</span>';
          }
          el.innerHTML = html;
        }
      } catch(e) { el.innerHTML = '<span style="color:var(--red);">Сервер не отвечает</span>'; }
    }
    async function backupNow() {
      const adminKey = await getAdminKey('Сделать бэкап сейчас');
      if (!adminKey) return;
      try {
        const r = await fetchWithTimeout('/admin/backup/now', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        await adminAlert('Сохранено в резервную копию: ' + d.userCount + ' аккаунтов.', 'Готово');
        refreshBackupStatus();
      } catch(e) { await adminAlert('Сервер недоступен', 'Ошибка'); }
    }
    async function restoreBackup() {
      const adminKey = await getAdminKey('Восстановить из бэкапа');
      if (!adminKey) return;
      const ok = await adminConfirm('Добавить на сервер все аккаунты из резервной копии, которых сейчас здесь нет? Существующие аккаунты не изменятся.', 'Подтвердите');
      if (!ok) return;
      try {
        const r = await fetchWithTimeout('/admin/backup/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        await adminAlert('Добавлено аккаунтов: ' + d.merged + '. Всего теперь на сервере: ' + d.total + '.', 'Готово');
        refreshBackupStatus();
      } catch(e) { await adminAlert('Сервер недоступен', 'Ошибка'); }
    }
    refreshBackupStatus();
    refreshRegCodeStatus();
    const searchInput = document.getElementById('user-search-input');
    const resultsEl = document.getElementById('user-search-results');
    let searchTimer = null;
    function renderUsers(list) {
      resultsEl.innerHTML = '';
      if (!list.length) { resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text3);">Ничего не найдено</div>'; return; }
      list.forEach(u => {
        const updated = u.updated ? new Date(u.updated).toLocaleString('ru-RU', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;';
        const info = document.createElement('div');
        const nameLine = document.createElement('div');
        nameLine.style.cssText = 'font-weight:700;font-size:13px;color:var(--accent2);';
        nameLine.textContent = (u.verified ? '✓ ' : '') + (u.plan==='plus' ? '⭐ ' : '') + u.login + (u.displayName ? ' («' + u.displayName + '»)' : '') + (u.disabled ? ' (отключён)' : '');
        const subLine = document.createElement('div');
        subLine.style.cssText = 'font-size:11px;color:var(--text2);font-weight:600;';
        subLine.textContent = u.notesCount + ' заметок · синхр. ' + updated;
        info.appendChild(nameLine);
        info.appendChild(subLine);
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
        function mkBtn(label, onClick) {
          const b = document.createElement('button');
          b.className = 'ep';
          b.style.cssText = 'cursor:pointer;border:none;';
          b.textContent = label;
          b.onclick = onClick;
          return b;
        }
        actions.appendChild(mkBtn(u.disabled ? '🔓 Включить' : '🔒 Отключить', () => toggleUserDisabled(u.login, !u.disabled)));
        actions.appendChild(mkBtn('✏️ Задать пароль', () => setUserPassword(u.login)));
        actions.appendChild(mkBtn('📨 Код в Telegram', () => sendTelegramResetCode(u.login)));
        actions.appendChild(mkBtn(u.verified ? '✓ Снять галочку' : '☆ Сделать официальным', () => toggleUserVerified(u.login, !u.verified)));
        actions.appendChild(mkBtn(u.plan==='plus' ? '⭐ Снять Plus' : '⭐ Выдать Plus', () => toggleUserPlan(u.login, u.plan==='plus' ? 'free' : 'plus')));
        card.appendChild(info);
        card.appendChild(actions);
        resultsEl.appendChild(card);
      });
    }
    async function runUserSearch(q) {
      resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text3);">Ищу…</div>';
      try {
        const r = await fetchWithTimeout('/users/search?q=' + encodeURIComponent(q));
        const d = await r.json();
        renderUsers(d.users || []);
      } catch (e) { resultsEl.innerHTML = '<div style="font-size:12px;color:var(--red);">' + (e.name==='AbortError' ? 'Сервер не ответил за 15 секунд (возможно инстанс просыпается) — нажмите «Найти» ещё раз' : 'Ошибка поиска') + '</div>'; }
    }
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runUserSearch(searchInput.value.trim()), 300);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); runUserSearch(searchInput.value.trim()); }
    });
    runUserSearch('');
    async function toggleUserDisabled(login, disabled) {
      const adminKey = await getAdminKey( disabled ? 'Отключить пользователя' : 'Включить пользователя');
      if (!adminKey) return;
      try {
        const r = await fetchWithTimeout('/admin/users/toggle-disabled', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey, login, disabled }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        runUserSearch(searchInput.value.trim());
      } catch(e) { await adminAlert('Сервер недоступен', 'Ошибка'); }
    }
    async function toggleUserVerified(login, verified) {
      const adminKey = await getAdminKey(verified ? 'Сделать официальным' : 'Снять галочку');
      if (!adminKey) return;
      try {
        const r = await fetchWithTimeout('/admin/users/toggle-verified', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey, login, verified }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        runUserSearch(searchInput.value.trim());
      } catch(e) { await adminAlert('Сервер недоступен', 'Ошибка'); }
    }
    async function toggleUserPlan(login, plan) {
      const adminKey = await getAdminKey(plan === 'plus' ? 'Выдать Plus' : 'Снять Plus');
      if (!adminKey) return;
      try {
        const r = await fetchWithTimeout('/admin/users/toggle-plan', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey, login, plan }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        runUserSearch(searchInput.value.trim());
      } catch(e) { await adminAlert('Сервер недоступен', 'Ошибка'); }
    }
    async function sendTelegramResetCode(login) {
      const adminKey = await getAdminKey('Прислать код в Telegram');
      if (!adminKey) return;
      try {
        const r = await fetchWithTimeout('/admin/telegram/send-reset-code', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey, login }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Не удалось отправить (возможно, у пользователя не привязан Telegram)', 'Ошибка'); return; }
        await adminAlert('Код смены пароля отправлен в Telegram пользователю ' + login + '.', 'Готово');
      } catch(e) { await adminAlert('Сервер недоступен', 'Ошибка'); }
    }
    async function setUserPassword(login) {
      const adminKey = await getAdminKey('Задать пароль');
      if (!adminKey) return;
      const newPassword = await adminPrompt('Новый пароль для ' + login + ' (минимум 4 символа)', { title:'Задать пароль' });
      if (!newPassword) return;
      try {
        const r = await fetchWithTimeout('/admin/users/set-password', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ adminKey, login, newPassword }) });
        const d = await r.json();
        if (!d.ok) { await adminAlert(d.error || 'Ошибка', 'Ошибка'); return; }
        await adminAlert('Пароль для ' + login + ' изменён.', 'Готово');
      } catch(e) { await adminAlert('Сервер недоступен', 'Ошибка'); }
    }
    async function setWebhook() {
      const token = await adminPrompt('Токен бота', { title:'Установить Webhook' });
      if (!token) return;
      window.open('/setup-webhook?token=' + encodeURIComponent(token), '_blank');
    }
    async function deleteWebhook() {
      const token = await adminPrompt('Токен бота', { title:'Удалить Webhook' });
      if (!token) return;
      window.open('https://api.telegram.org/bot' + token + '/deleteWebhook', '_blank');
    }
    async function getUpdatesInfo() {
      const token = await adminPrompt('Токен бота', { title:'Инфо о пользователях бота' });
      if (!token) return;
      window.open('https://api.telegram.org/bot' + token + '/getUpdates', '_blank');
    }
  </script>
</body>
</html>`);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Nota notification server listening on port ${PORT}`);
});
