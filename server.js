// server.js — Nota: фоновые Telegram-уведомления
// Деплоится на Render.com (бесплатно).
// Хранит заметки в памяти (получает их от браузера через /sync).
// Каждую минуту проверяет напоминания и шлёт в Telegram.

const http = require('http');
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
}
loadUsers();

const sessions = new Map(); // token -> login(lowercase)

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

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
    const helpMsg = `👋 <b>Nota — сервер уведомлений</b>\n\nЗаметки:\n/notes — все активные заметки\n/today — заметки на сегодня\n/tomorrow — заметки на завтра\n/overdue — просроченные заметки\n/done_list — последние выполненные\n/search текст — поиск по заметкам\n/stats — статистика по заметкам\n\nУправление:\n/done N — отметить заметку №N выполненной\n/delete N — удалить заметку №N\n/priority N высокий — задать приоритет заметке №N\n\nАккаунт и синхронизация:\n/sync — информация о синхронизации\n/telegram — узнать ваш Chat ID\n\n💬 Просто напишите мне текст — и я добавлю его как новую заметку.\n✏️ Ответьте (reply) на моё сообщение о созданной заметке или на напоминание — и я обновлю текст этой заметки.`;
    await sendTelegramRaw(chatId, token, helpMsg);
    return;
  }

  if (text === '/telegram') {
    await sendTelegramRaw(chatId, token, `🆔 <b>Ваш Chat ID:</b>\n<code>${chatId}</code>\n\nВставьте его в приложении Nota → вкладка Telegram, чтобы привязать бота к этому сайту.`);
    return;
  }

  if (text === '/sync') {
    if (!userData) {
      await sendTelegramRaw(chatId, token, '📭 <b>Нет данных синхронизации</b>\n\nОткройте приложение Nota — оно автоматически синхронизирует заметки с сервером.');
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

  // ── Любой другой текст ──────────────────────────────────────────────────
  if (text.startsWith('/')) return; // неизвестная команда — игнорируем

  const data = userData || { notes: [], account: null, fired: {}, pendingNew: [], pendingChanges: [], msgMap: {} };
  data.pendingNew = data.pendingNew || [];
  data.pendingChanges = data.pendingChanges || [];
  data.msgMap = data.msgMap || {};

  // Ответ (reply) на сообщение о заметке/напоминании — редактируем эту заметку
  const replyToId = msg.reply_to_message ? String(msg.reply_to_message.message_id) : null;
  const targetNoteId = replyToId ? data.msgMap[replyToId] : null;
  if (targetNoteId) {
    data.pendingChanges.push({ id: targetNoteId, type: 'edit', text });
    store.set(chatId, data);
    await sendTelegramRaw(chatId, token, `✏️ Заметка обновлена новым текстом.`);
    return;
  }

  // Иначе — создаём новую заметку
  const title = text.length > 60 ? text.slice(0, 60) + '…' : text;
  const newNote = {
    id: 'tg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    title, html: escapeHtmlServer(text), plainText: text,
    datetime: '', date: '', time: '', reminder: '', color: 'default',
    recurRule: '', tags: ['telegram'], priority: '', pinned: false, folder: '',
    checklist: [], extraReminders: [], warnBeforeMinutes: 0, warnRepeatEveryMinutes: 0, warnRepeatTimes: 0, history: [],
    done: false, created: Date.now(), updated: Date.now()
  };
  data.pendingNew.push(newNote);
  store.set(chatId, data);
  const sent = await sendTelegramRaw(chatId, token, `🔔 <i>Сервер уведомлений Nota</i>\n📝 Заметка добавлена: «${title}»\n\nОна появится в приложении Nota при следующем открытии/синхронизации.\n✏️ Ответьте на это сообщение, чтобы изменить текст заметки.`);
  if (sent?.ok && sent.result?.message_id) {
    data.msgMap[String(sent.result.message_id)] = newNote.id;
    store.set(chatId, data);
  }
}

function escapeHtmlServer(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Callback-кнопки под напоминаниями (✅ Готово / ⏰ +1 час) ───────────────────
async function handleCallbackQuery(cq) {
  const chatId = String(cq.message?.chat?.id || '');
  const data = cq.data || '';
  const userData = store.get(chatId);
  const token = userData?.account?.token || DEFAULT_BOT_TOKEN;
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

function answerCallbackQuery(callbackId, token, text) {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  const body = JSON.stringify({ callback_query_id: callbackId, text });
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

async function sendTelegramRaw(chatId, token, text, fallbackToken, fallbackChatId) {
  const tok = token || fallbackToken;
  if (!tok) return null;
  const id = chatId || fallbackChatId;
  if (!id) return null;
  const url = `https://api.telegram.org/bot${tok}/sendMessage`;
  const body = JSON.stringify({ chat_id: id, text, parse_mode: 'HTML' });
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

  // ── POST /auth/register {login, password} ─────────────────────────────────
  if (req.method === 'POST' && req.url === '/auth/register') {
    try {
      const { login, password } = JSON.parse(await readBody(req));
      const loginNorm = String(login||'').trim();
      const key = loginNorm.toLowerCase();
      if (!key || key.length < 3) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Логин минимум 3 символа'})); return; }
      if (!password || String(password).length < 4) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Пароль минимум 4 символа'})); return; }
      if (users.has(key)) { res.writeHead(409,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Такой логин уже занят'})); return; }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(String(password), salt);
      const user = { login: loginNorm, salt, hash, incoming: [] };
      users.set(key, user);
      saveUsers();
      const token = makeToken();
      sessions.set(token, key);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, token, login: loginNorm }));
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
      const hash = hashPassword(String(password||''), user.salt);
      if (hash !== user.hash) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Неверный логин или пароль'})); return; }
      const token = makeToken();
      sessions.set(token, key);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, token, login: user.login }));
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
      user.notes = Array.isArray(notes) ? notes : [];
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
      const fromUser = users.get(fromKey);
      const sharedNote = { ...note, sharedBy: fromUser?.login || fromKey, shared: true, id: note.id };
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

  // ── GET /users/search?q=… — публичный поиск логинов (для автодополнения при
  // расшаривании заметки и для страницы статуса). НИКОГДА не отдаёт пароль/хэш.
  if (req.method === 'GET' && req.url.startsWith('/users/search')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
    const results = [...users.values()]
      .filter(u => !q || u.login.toLowerCase().includes(q))
      .slice(0, 50)
      .map(u => ({ login: u.login, notesCount: (u.notes || []).length, updated: u.notesUpdated || 0 }));
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
  <h1>Nota</h1>
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
    <span class="ep">/notes</span> · <span class="ep">/today</span> · <span class="ep">/tomorrow</span> · <span class="ep">/overdue</span> · <span class="ep">/done_list</span><br>
    <span class="ep">/search текст</span> · <span class="ep">/stats</span><br>
    <span class="ep">/done N</span> · <span class="ep">/delete N</span> · <span class="ep">/priority N уровень</span><br>
    <span class="ep">/sync</span> · <span class="ep">/telegram</span>
  </div>
  <div class="info-card" style="max-width:820px;width:100%;">
    <b>Поиск пользователей:</b><br>
    <input id="user-search-input" type="text" placeholder="Начните вводить логин…" autocomplete="off"
      style="width:100%;margin-top:6px;padding:9px 12px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(255,255,255,0.04);color:var(--text);font-family:inherit;font-size:13px;box-sizing:border-box;">
    <div id="user-search-results" style="margin-top:10px;display:flex;flex-direction:column;gap:6px;"></div>
    <div style="font-size:10px;color:var(--text3);margin-top:8px;font-weight:600;">Показаны логин, число заметок и дата последней синхронизации. Пароли и хэши паролей здесь никогда не показываются.</div>
  </div>
  <div class="time">Время сервера: ${new Date().toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})} (MSK)</div>
  <script>
    const searchInput = document.getElementById('user-search-input');
    const resultsEl = document.getElementById('user-search-results');
    let searchTimer = null;
    function renderUsers(list) {
      if (!list.length) { resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text3);">Ничего не найдено</div>'; return; }
      resultsEl.innerHTML = list.map(u => {
        const updated = u.updated ? new Date(u.updated).toLocaleString('ru-RU', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
        return '<div class="card" style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;">'
          + '<div style="font-weight:700;font-size:13px;color:var(--accent2);">' + u.login + '</div>'
          + '<div style="font-size:11px;color:var(--text2);font-weight:600;">' + u.notesCount + ' заметок · синхр. ' + updated + '</div>'
          + '</div>';
      }).join('');
    }
    async function runUserSearch(q) {
      try {
        const r = await fetch('/users/search?q=' + encodeURIComponent(q));
        const d = await r.json();
        renderUsers(d.users || []);
      } catch (e) { resultsEl.innerHTML = '<div style="font-size:12px;color:var(--red);">Ошибка поиска</div>'; }
    }
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runUserSearch(searchInput.value.trim()), 300);
    });
    runUserSearch('');
    function setWebhook() {
      const token = prompt('Токен бота:');
      if (!token) return;
      window.open('/setup-webhook?token=' + encodeURIComponent(token), '_blank');
    }
    function deleteWebhook() {
      const token = prompt('Токен бота:');
      if (!token) return;
      window.open('https://api.telegram.org/bot' + token + '/deleteWebhook', '_blank');
    }
    function getUpdatesInfo() {
      const token = prompt('Токен бота:');
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
