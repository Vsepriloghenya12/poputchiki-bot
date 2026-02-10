// index.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { Telegraf } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const crypto = require('crypto');

const {
  db,
  upsertUserFromTelegram,
  createTrip,
  getLatestTrips,
  getUserByTelegramId,
  getDriverProfileByTelegramId,
  updateDriverCarProfile,
  getTripWithDriver,
  getDriverTripsByTelegramId,
  getTripBookingsForDriver,
  createBooking,
  markBookingNoShow,
  getAppSettings,
  updateAppSettings,
  getDriverDailyStats,
  hasDriverPaymentProofToday,
  saveDriverPaymentProof,
  getAdminStats,
  getAdminDailyDrivers,
  deleteTripByDriver,
  getPassengerBookingsByTelegramId,
  cancelBookingByPassenger,
  setUserBlockedByTelegramId,
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '504348666';
const APP_FEE_PERCENT_RAW =
  process.env.APP_FEE_PERCENT ?? process.env.SERVICE_FEE_PCT ?? '0.10';
const APP_FEE_PERCENT_PARSED = Number(APP_FEE_PERCENT_RAW);
const APP_FEE_PERCENT = Number.isFinite(APP_FEE_PERCENT_PARSED)
  ? Math.max(0, Math.min(1, APP_FEE_PERCENT_PARSED))
  : 0.10;


if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в .env или переменных окружения');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

async function sendMessageSafe(telegramId, text, extra = undefined) {
  try {
    if (!telegramId) return;
    await bot.telegram.sendMessage(String(telegramId), String(text).slice(0, 3500), extra);
  } catch (e) {
    console.warn('sendMessageSafe error:', e?.message || e);
  }
}

let BOT_USERNAME_RUNTIME = (process.env.BOT_USERNAME || '').replace('@', '').trim();
const WEBAPP_SHORTNAME = (process.env.WEBAPP_SHORTNAME || '').trim();

function withStartParamUrl(baseUrl, startParam) {
  const sp = String(startParam || '').trim();
  if (!sp) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}startapp=${encodeURIComponent(sp)}`;
}

function buildDeeplinkPrefix() {
  const u = (BOT_USERNAME_RUNTIME || '').replace('@', '').trim();
  // Prefer deep links that open the Mini App inside Telegram (so initData is always present)
  if (u && WEBAPP_SHORTNAME) {
    return `https://t.me/${u}/${WEBAPP_SHORTNAME}?startapp=`;
  }
  if (u) {
    // Bot's main Mini App link format (doesn't require shortname)
    return `https://t.me/${u}?startapp=`;
  }
  // Last resort (opens as a regular website, initData may be missing)
  const base = WEBAPP_URL;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}startapp=`;
}


function buildDeeplink(startParam) {
  return buildDeeplinkPrefix() + encodeURIComponent(String(startParam || '').trim());
}

function webAppOpenKeyboard(label = 'Открыть мини‑приложение', startParam = '') {
  // В личных сообщениях используем web_app (даёт initData). В URL добавляем startapp для удобного открытия конкретной карточки.
  const url = withStartParamUrl(WEBAPP_URL, startParam);
  return {
    reply_markup: {
      inline_keyboard: [[{ text: label, web_app: { url } }]],
    },
  };
}

// ---------------- CHANNEL AUTOPOST (красивые посты в публичный канал) ----------------
const PUBLIC_CHANNEL = (process.env.PUBLIC_CHANNEL || '').trim(); // пример: @sochi_adler_polana
const AUTOPOST_ENABLED = process.env.AUTOPOST_ENABLED !== '0';
const AUTOPOST_TRIPS = process.env.AUTOPOST_TRIPS !== '0';
const AUTOPOST_PLANS = process.env.AUTOPOST_PLANS !== '0';
const CHANNEL_BRAND = (process.env.CHANNEL_BRAND || '🏔️ Попутчики').trim();
const CHANNEL_TAGS = (process.env.CHANNEL_TAGS || '').trim();

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function compactText(s, max = 220) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function formatDT(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  return escapeHtml(s.replace('T', ' '));
}

function formatMoney(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n));
}

function userDisplayHtml(user) {
  const username = user?.username ? String(user.username).replace('@', '') : '';
  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() ||
    (username ? '@' + username : 'Пользователь');

  // ВАЖНО: без ссылок. Просто текст.
  if (username) return `<b>${escapeHtml('@' + username)}</b>`;
  return `<b>${escapeHtml(name)}</b>`;
}

function channelKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Открыть в приложении',
            url: WEBAPP_DEEPLINK, // или как у тебя называется deep-link
          },
        ],
      ],
    },
  };
}

async function sendToChannelSafe(html, keyboardExtra) {
  try {
    if (!PUBLIC_CHANNEL || !AUTOPOST_ENABLED) return;
    await bot.telegram.sendMessage(PUBLIC_CHANNEL, html, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboardExtra || {}),
    });
  } catch (e) {
    console.warn('CHANNELL AUTOPOST error:', e?.message || e);
  }
}

function buildTripPostHtml(trip, driver) {
  const from = escapeHtml(trip.from_city);
  const to = escapeHtml(trip.to_city);
  const time = formatDT(trip.departure_time);
  const seats = escapeHtml(trip.seats_total);
  const price = formatMoney(trip.price_per_seat);
  const note = compactText(trip.note || '', 240);

  let html = '';
  html += `<b>${escapeHtml(CHANNEL_BRAND)}</b>
`;
  html += `<b>🚗 Поездка</b>
`;
  html += `<b>${from} → ${to}</b>
`;
  html += `────────────
`;
  html += `🕒 <b>${time}</b>
`;
  html += `💺 Мест: <b>${seats}</b>
`;
  html += `💰 Цена: <b>${price} ₽/место</b>
`;
  if (note) html += `📝 <i>${escapeHtml(note)}</i>
`;
  html += `────────────
`;
  html += `👤 Водитель: ${userDisplayHtml(driver)}
`;
  if (CHANNEL_TAGS) html += `
${escapeHtml(CHANNEL_TAGS)}`;
  return html;
}

function buildPlanPostHtml(plan, passenger) {
  const from = escapeHtml(plan.from_city);
  const to = escapeHtml(plan.to_city);
  const time = formatDT(plan.desired_time);
  const seats = escapeHtml(plan.seats_needed);
  const price = formatMoney(plan.price_per_seat);
  const note = compactText(plan.note || '', 240);

  let html = '';
  html += `<b>${escapeHtml(CHANNEL_BRAND)}</b>
`;
  html += `<b>🙋 Ищу попутку</b>
`;
  html += `<b>${from} → ${to}</b>
`;
  html += `────────────
`;
  html += `🕒 <b>${time}</b>
`;
  html += `💺 Нужно мест: <b>${seats}</b>
`;
  html += `💰 Готов(а): <b>${price} ₽/место</b>
`;
  if (note) html += `📝 <i>${escapeHtml(note)}</i>
`;
  html += `────────────
`;
  html += `👤 Пассажир: ${userDisplayHtml(passenger)}
`;
  if (CHANNEL_TAGS) html += `
${escapeHtml(CHANNEL_TAGS)}`;
  return html;
}

async function autopostTripToChannel(trip, driver) {
  if (!AUTOPOST_ENABLED || !AUTOPOST_TRIPS) return;
  const html = buildTripPostHtml(trip, driver);
  const kb = channelKeyboard(driver && driver.username, `trip_${trip.id}`);
  await sendToChannelSafe(html, kb);
}

async function autopostPlanToChannel(plan, passenger) {
  if (!AUTOPOST_ENABLED || !AUTOPOST_PLANS) return;
  const html = buildPlanPostHtml(plan, passenger);
  const kb = channelKeyboard(passenger && passenger.username, `plan_${plan.id}`);
  await sendToChannelSafe(html, kb);
}

const app = express();

// Хранилище файлов чеков
const uploadDir = process.env.UPLOADS_PATH
  ? process.env.UPLOADS_PATH
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || '');
    cb(null, unique + ext);
  },
});
const upload = multer({ storage });

app.use(bodyParser.json());
app.disable('etag');

// ---------------- TELEGRAM INIT DATA AUTH (защита) ----------------
// По умолчанию в проде требуем валидный initData (запросы только из Telegram Mini App).
// Для тестов вне Telegram можно установить REQUIRE_INIT_DATA=0.
const REQUIRE_INIT_DATA = process.env.REQUIRE_INIT_DATA !== '0';
const INIT_DATA_MAX_AGE_SEC = Number(process.env.INIT_DATA_MAX_AGE_SEC || 86400); // 24 часа

function validateTelegramInitData(initData, botToken, maxAgeSec) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, error: 'hash missing' };

    params.delete('hash');

    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    // secret_key = HMAC_SHA256(bot_token, "WebAppData") (ключ — "WebAppData")
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculated = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calculated !== hash) return { ok: false, error: 'hash mismatch' };

    const authDate = Number(params.get('auth_date'));
    if (Number.isFinite(authDate) && maxAgeSec) {
      const age = Math.floor(Date.now() / 1000) - authDate;
      if (age > maxAgeSec) return { ok: false, error: 'initData expired' };
    }

    let user = null;
    const userStr = params.get('user');
    if (userStr) {
      try {
        user = JSON.parse(userStr);
      } catch (_) {}
    }

    return { ok: true, user, auth_date: authDate };
  } catch (e) {
    return { ok: false, error: 'bad initData' };
  }
}

// Мидлварь: если initData валидный — перетираем возможную подмену telegram_id в запросах.
app.use('/api', (req, res, next) => {
  const initData =
    req.headers['x-telegram-init-data'] ||
    req.headers['x-telegram-initdata'] ||
    (req.body && req.body.initData) ||
    (req.query && req.query.initData);

  if (!initData) {
    if (!REQUIRE_INIT_DATA) return next();
    return res.status(401).json({ error: 'Нет initData. Откройте мини‑приложение из Telegram.' });
  }

  const v = validateTelegramInitData(String(initData), BOT_TOKEN, INIT_DATA_MAX_AGE_SEC);
  if (!v.ok || !v.user || !v.user.id) {
    if (!REQUIRE_INIT_DATA) return next();
    return res.status(401).json({ error: 'initData не прошёл проверку' });
  }

  req.telegramUser = v.user;
  req.telegramId = String(v.user.id);

  if (req.body && typeof req.body === 'object') {
    req.body.telegram_id = req.telegramId;
    if (!req.body.user && req.path === '/init-user') req.body.user = v.user;
  }
  if (req.query && typeof req.query === 'object') {
    if (!req.query.telegram_id) req.query.telegram_id = req.telegramId;
  }

  next();
});


app.use((req, res, next) => {
  // Telegram WebView может агрессивно кэшировать HTML/JS/CSS
  if (req.method === 'GET') {
    // для HTML и корня — всегда без кэша
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// ---------------- ВСПОМОГАТЕЛЬНЫЕ ОБЁРТКИ ДЛЯ DB (для passenger_plans) ----------------

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// ---------------- ТАБЛИЦА ЗАПЛАНИРОВАННЫХ ПОЕЗДОК ПАССАЖИРОВ ----------------

db.serialize(() => {
  // 1) Таблица
  db.run(
    `
    CREATE TABLE IF NOT EXISTS passenger_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      passenger_id INTEGER NOT NULL,
      from_city TEXT NOT NULL,
      to_city TEXT NOT NULL,
      desired_time TEXT NOT NULL,
      seats_needed INTEGER NOT NULL,
      price_per_seat REAL NOT NULL DEFAULT 0,
      amount_total REAL NOT NULL DEFAULT 0,
      driver_amount REAL NOT NULL DEFAULT 0,
      app_fee REAL NOT NULL DEFAULT 0,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- active / taken / cancelled / expired
      driver_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      taken_at TEXT,
      FOREIGN KEY (passenger_id) REFERENCES users(id),
      FOREIGN KEY (driver_id) REFERENCES users(id)
    )
  `
  );

  // 2) Миграции колонок (если таблица уже существовала)
  [
    "ALTER TABLE passenger_plans ADD COLUMN price_per_seat REAL NOT NULL DEFAULT 0",
    "ALTER TABLE passenger_plans ADD COLUMN amount_total REAL NOT NULL DEFAULT 0",
    "ALTER TABLE passenger_plans ADD COLUMN driver_amount REAL NOT NULL DEFAULT 0",
    "ALTER TABLE passenger_plans ADD COLUMN app_fee REAL NOT NULL DEFAULT 0",
  ].forEach((sql) => {
    db.run(sql, (err) => {
      // игнорируем ошибки "duplicate column name" и подобные
      if (!err) return;
      const msg = String(err.message || '');
      if (msg.includes('duplicate column name') || msg.includes('already exists')) return;
      console.warn('Миграция passenger_plans не применена:', msg);
    });
  });

  // 3) Индекс
  db.run(
    `
    CREATE INDEX IF NOT EXISTS idx_passenger_plans_status_time
    ON passenger_plans (status, desired_time)
  `
  );
});

// ---------------- ТАБЛИЦЫ: ПОДТВЕРЖДЕНИЯ И ОТЗЫВЫ ----------------
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS ride_confirmations (
      context_type TEXT NOT NULL,          -- 'booking' | 'plan'
      context_id INTEGER NOT NULL,
      driver_confirmed_at TEXT,
      passenger_confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (context_type, context_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_type TEXT NOT NULL,          -- 'booking' | 'plan'
      context_id INTEGER NOT NULL,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,             -- 1..5
      tags TEXT,                           -- JSON
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (context_type, context_id, from_user_id),
      FOREIGN KEY (from_user_id) REFERENCES users(id),
      FOREIGN KEY (to_user_id) REFERENCES users(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_reviews_to_user ON reviews(to_user_id)`);

  // Колонки агрегированного рейтинга в users (мягкая миграция)
  const migrations = [
    "ALTER TABLE users ADD COLUMN rating_sum INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN rating_avg REAL NOT NULL DEFAULT 0"
  ];
  migrations.forEach((sql) => {
    db.run(sql, (err) => {
      if (!err) return;
      const msg = String(err.message || '');
      if (msg.includes('duplicate column name') || msg.includes('already exists')) return;
      console.warn('Миграция users (rating) не применена:', msg);
    });
  });
});

// ---------------- БОТ ----------------


bot.start((ctx) => {
  if (WEBAPP_URL.startsWith('http://localhost')) {
    return ctx.reply(
      'Привет! Это бот "попутчики".\n' +
        'Сейчас бот запущен локально.\n\n' +
        'Мини-приложение можно открыть в браузере по адресу:\n' +
        WEBAPP_URL
    );
  }

  return ctx.reply(
    'Привет! Это бот "попутчики". Нажмите кнопку ниже, чтобы открыть мини-приложение.',
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Открыть попутчики',
              web_app: { url: WEBAPP_URL },
            },
          ],
        ],
      },
    }
  );
});

bot.help((ctx) => {
  return ctx.reply(
    'Здесь водители создают поездки, а пассажиры бронируют места.\n' +
      'Нажмите /start и откройте мини-приложение по кнопке.'
  );
});

bot.on('text', (ctx) => {
  return ctx.reply(
    'Основной функционал доступен в мини-приложении.\n' +
      'Нажмите /start и откройте "попутчики" по кнопке.'
  );
});

// Определяем username бота (для deeplink в канал), если не задан в ENV
bot.telegram.getMe().then((me) => {
  if (me && me.username) {
    BOT_USERNAME_RUNTIME = String(me.username).replace('@', '').trim();
  }
}).catch((e) => {
  console.warn('getMe error:', e?.message || e);
});

// ---------------- API: ОБЩЕЕ ----------------

// Инициализация пользователя
app.post('/api/init-user', async (req, res) => {
  try {
    const { user } = req.body;
    if (!user || !user.id) {
      return res.status(400).json({ error: 'Некорректный объект user' });
    }

    const dbUser = await upsertUserFromTelegram(user);
    const settings = await getAppSettings();

    return res.json({ user: dbUser, settings });
  } catch (err) {
    console.error('Ошибка /api/init-user:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});


// Конфиг приложения для фронта (deeplink и настройки автопоста)
app.get('/api/app-config', async (req, res) => {
  try {
    // На всякий случай подтягиваем username бота перед отдачей deeplink_prefix
    if (!BOT_USERNAME_RUNTIME) {
      try {
        const me = await bot.telegram.getMe();
        if (me && me.username) {
          BOT_USERNAME_RUNTIME = String(me.username).replace('@', '').trim();
        }
      } catch (_) {}
    }

    return res.json({
      deeplink_prefix: buildDeeplinkPrefix(),
      bot_username: (BOT_USERNAME_RUNTIME || null),
      webapp_shortname: WEBAPP_SHORTNAME || null,
      autopost: {
        enabled: !!(PUBLIC_CHANNEL && AUTOPOST_ENABLED),
        channel: PUBLIC_CHANNEL || null,
        brand: CHANNEL_BRAND,
      },
    });
  } catch (e) {
    return res.json({ deeplink_prefix: buildDeeplinkPrefix() });
  }
});

// ---------------- API: ПОЕЗДКИ ----------------

// Создание поездки (с учётом платного режима и блокировок)
app.post('/api/trips', async (req, res) => {
  try {
    const { telegram_id, from_city, to_city, departure_time, seats_total, price_per_seat, note } =
      req.body;

    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const user = await getUserByTelegramId(telegram_id);
    if (!user) {
      return res.status(400).json({
        error: 'Пользователь не найден. Сначала откройте Mini App через /start.',
      });
    }

    if (user.is_blocked) {
      return res.status(403).json({
        error:
          'Ваш аккаунт заблокирован администратором. Создание новых поездок временно недоступно.',
      });
    }

    const settings = await getAppSettings();

    if (settings && settings.monetization_enabled) {
      const stats = await getDriverDailyStats(user.id);
      const hasProof = await hasDriverPaymentProofToday(user.id);

      const tripsToday = (stats && stats.trips_count) || 0;
      const appFeeToday = (stats && stats.app_fee_total) || 0;

      // Блокируем только если СЕГОДНЯ были поездки с комиссией и нет чека
      if (tripsToday > 0 && appFeeToday > 0 && !hasProof) {
        return res.status(403).json({
          error:
            'Сервис стал частично платным для водителей.\n' +
            'У вас есть комиссия за сегодняшние поездки. Оплатите её, прикрепите чек и после этого сможете создавать новые поездки.',
        });
      }
    }

    const trip = await createTrip({
      driverId: user.id,
      fromCity: from_city,
      toCity: to_city,
      departureTime: departure_time,
      seatsTotal: seats_total,
      pricePerSeat: price_per_seat,
      note,
    });

    // Автопост в публичный канал (если включено)
    autopostTripToChannel(trip, user).catch((e) =>
      console.warn('autopostTripToChannel error:', e?.message || e)
    );


    // Нотификация пассажирам: новый водитель под их план
    try {
      const rawPlans = await dbAll(
        `
        SELECT
          p.id,
          p.desired_time,
          p.seats_needed,
          p.price_per_seat,
          u.telegram_id AS passenger_telegram_id,
          u.username AS passenger_username,
          u.first_name AS passenger_first_name,
          u.last_name AS passenger_last_name
        FROM passenger_plans p
        JOIN users u ON u.id = p.passenger_id
        WHERE p.status = 'active'
          AND p.from_city = ?
          AND p.to_city = ?
        `,
        [from_city, to_city]
      );

      const depTs = Date.parse(departure_time);
      const windowMs = 4 * 60 * 60 * 1000; // +/- 4 часа
      const matched = (rawPlans || []).filter((p) => {
        const pt = Date.parse(p.desired_time);
        if (!Number.isFinite(depTs) || !Number.isFinite(pt)) return true;
        return Math.abs(pt - depTs) <= windowMs;
      });

      for (const p of matched.slice(0, 40)) {
        const msg =
          `🚗 Появилась поездка под ваш план\n` +
          `${from_city} → ${to_city}\n` +
          `Время: ${departure_time}\n` +
          `Цена: ${price_per_seat} ₽/место\n` +
          `Мест: ${seats_total}\n\n` +
          `Откройте мини‑приложение и забронируйте.`;
        await sendMessageSafe(p.passenger_telegram_id, msg, webAppOpenKeyboard());
      }
    } catch (e) {
      console.warn('notify plans error:', e?.message || e);
    }

    return res.json({ trip });
  } catch (err) {
    console.error('Ошибка /api/trips (POST):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Список поездок (пассажир) — только не полные и не устаревшие + фильтры
app.get('/api/trips', async (req, res) => {
  try {
    const rawTrips = await getLatestTrips(50);

    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000; // показываем до 10 минут после старта

    const qFrom = (req.query.from || '').toString().trim().toLowerCase();
    const qTo = (req.query.to || '').toString().trim().toLowerCase();
    const qDay = (req.query.day || 'any').toString().trim().toLowerCase();
    const qSort = (req.query.sort || 'time_asc').toString().trim().toLowerCase();

    // границы "сегодня/завтра" в локальном времени сервера
    const dNow = new Date();
    const startOfToday = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate()).getTime();
    const startOfTomorrow = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate() + 1).getTime();
    const startOfDayAfterTomorrow = new Date(dNow.getFullYear(), dNow.getMonth(), dNow.getDate() + 2).getTime();

    let trips = (rawTrips || []).filter((t) => {
      // базовая логика (как было)
      if (t.seats_available <= 0) return false;

      const ts = Date.parse(t.departure_time);
      if (Number.isFinite(ts) && ts < cutoff) return false;

      // from/to
      if (qFrom && String(t.from_city || '').trim().toLowerCase() !== qFrom) return false;
      if (qTo && String(t.to_city || '').trim().toLowerCase() !== qTo) return false;

      // day
      if (qDay && qDay !== 'any' && Number.isFinite(ts)) {
        if (qDay === 'today') {
          if (!(ts >= startOfToday && ts < startOfTomorrow)) return false;
        } else if (qDay === 'tomorrow') {
          if (!(ts >= startOfTomorrow && ts < startOfDayAfterTomorrow)) return false;
        } else if (qDay === 'weekend') {
          const dow = new Date(ts).getDay(); // 0=вс, 6=сб
          if (!(dow === 0 || dow === 6)) return false;
        }
      }

      return true;
    });

    // сортировка
    const timeValue = (t) => {
      const ts = Date.parse(t.departure_time);
      return Number.isFinite(ts) ? ts : 0;
    };
    const priceValue = (t) => Number(t.price_per_seat || 0);

    if (qSort === 'time_desc') {
      trips.sort((a, b) => timeValue(b) - timeValue(a));
    } else if (qSort === 'price_asc') {
      trips.sort((a, b) => priceValue(a) - priceValue(b));
    } else if (qSort === 'price_desc') {
      trips.sort((a, b) => priceValue(b) - priceValue(a));
    } else {
      // time_asc по умолчанию
      trips.sort((a, b) => timeValue(a) - timeValue(b));
    }

    return res.json({ trips });
  } catch (err) {
    console.error('Ошибка /api/trips (GET):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Удаление поездки водителем
app.post('/api/driver/delete-trip', async (req, res) => {
  try {
    const { telegram_id, trip_id } = req.body;
    if (!telegram_id || !trip_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или trip_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const trip = await deleteTripByDriver(trip_id, driver.id);
    return res.json({ success: true, trip });
  } catch (err) {
    console.error('Ошибка /api/driver/delete-trip:', err);

    if (err.code === 'TRIP_NOT_FOUND') {
      return res.status(400).json({ error: 'Поездка не найдена' });
    }
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Нет прав на удаление этой поездки' });
    }
    if (err.code === 'TOO_LATE') {
      return res
        .status(400)
        .json({ error: 'Нельзя отменить поездку после её начала.' });
    }
    if (err.code === 'HAS_BOOKINGS') {
      return res.status(400).json({
        error: 'Нельзя удалить поездку, по которой уже есть бронирования.',
      });
    }

    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// История поездок водителя
app.get('/api/driver/trips', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const trips = await getDriverTripsByTelegramId(telegram_id);
    return res.json({ trips });
  } catch (err) {
    console.error('Ошибка /api/driver/trips:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Активная поездка водителя (до 10 минут после начала)
app.get('/api/driver/active-trip', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const trips = await getDriverTripsByTelegramId(telegram_id);
    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000;

    const futureTrips = (trips || []).filter((t) => {
      const ts = Date.parse(t.departure_time);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    if (futureTrips.length === 0) {
      return res.json({ trip: null });
    }

    futureTrips.sort((a, b) => Date.parse(a.departure_time) - Date.parse(b.departure_time));
    const activeTrip = futureTrips[0];

    return res.json({ trip: activeTrip });
  } catch (err) {
    console.error('Ошибка /api/driver/active-trip:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Пассажиры конкретной поездки (для водителя)
app.get('/api/driver/trip-bookings', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    const trip_id = req.query.trip_id;

    if (!telegram_id || !trip_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или trip_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const tripIdNum = Number(trip_id);
    const bookings = await getTripBookingsForDriver(tripIdNum, driver.id);

    return res.json({ bookings });
  } catch (err) {
    console.error('Ошибка /api/driver/trip-bookings:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ---------------- API: ПРОФИЛЬ Водителя и ОПЛАТА ----------------

// Профиль водителя (машина)
app.get('/api/driver/profile', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const profile = await getDriverProfileByTelegramId(telegram_id);
    if (!profile) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    // рейтинг (если включен)
    try {
      const r = await dbGet(
        `SELECT rating_avg, rating_count FROM users WHERE telegram_id = ?`,
        [String(telegram_id)]
      );
      if (r) {
        profile.rating_avg = r.rating_avg || 0;
        profile.rating_count = r.rating_count || 0;
      }
    } catch (_) {}

    return res.json({ profile });

  } catch (err) {
    console.error('Ошибка /api/driver/profile (GET):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/driver/profile', async (req, res) => {
  try {
    const { telegram_id, car_make, car_color, car_plate } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const updated = await updateDriverCarProfile(telegram_id, {
      carMake: car_make,
      carColor: car_color,
      carPlate: car_plate,
    });

    return res.json({ profile: updated });
  } catch (err) {
    console.error('Ошибка /api/driver/profile (POST):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Дневная статистика водителя (для блока оплаты)
app.get('/api/driver/daily-stats', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const user = await getUserByTelegramId(telegram_id);
    if (!user) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const [settings, stats, hasProof] = await Promise.all([
      getAppSettings(),
      getDriverDailyStats(user.id),
      hasDriverPaymentProofToday(user.id),
    ]);

    return res.json({
      settings: {
        monetization_enabled: settings.monetization_enabled || 0,
        payment_details: settings.payment_details || '',
      },
      stats: stats,
      has_proof_today: !!hasProof,
      is_blocked: user.is_blocked || 0,
    });
  } catch (err) {
    console.error('Ошибка /api/driver/daily-stats:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Загрузка чека водителем
app.post(
  '/api/driver/payment-proof',
  upload.single('file'),
  async (req, res) => {
    try {
      const telegram_id = req.body.telegram_id;
      if (!telegram_id) {
        return res.status(400).json({ error: 'Не указан telegram_id' });
      }

      const user = await getUserByTelegramId(telegram_id);
      if (!user) {
        return res.status(400).json({ error: 'Водитель не найден' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Файл не получен' });
      }

      await saveDriverPaymentProof(
        user.id,
        req.file.originalname,
        req.file.filename
      );

  
    // notify passenger that driver took the plan
    try {
      const passengerRow = await dbGet(
        `SELECT u.telegram_id AS passenger_telegram_id, u.username AS passenger_username
         FROM passenger_plans p
         JOIN users u ON u.id = p.passenger_id
         WHERE p.id = ?`,
        [Number(plan_id)]
      );
      const driverRow = await dbGet(
        `SELECT username, first_name, last_name FROM users WHERE id = ?`,
        [driver.id]
      );

      const driverName =
        (driverRow?.username ? '@' + driverRow.username : null) ||
        [driverRow?.first_name, driverRow?.last_name].filter(Boolean).join(' ') ||
        'водитель';

      const msg =
        `✅ Ваш план поездки взят водителем\n` +
        `${plan.from_city} → ${plan.to_city}\n` +
        `Время: ${plan.desired_time}\n` +
        `Водитель: ${driverName}\n\n` +
        `Откройте мини‑приложение, чтобы посмотреть детали и подтвердить поездку после завершения.`;

      await sendMessageSafe(passengerRow?.passenger_telegram_id, msg, webAppOpenKeyboard());
    } catch (e) {
      console.warn('notify passenger error:', e?.message || e);
    }

    return res.json({ success: true });
    } catch (err) {
      console.error('Ошибка /api/driver/payment-proof:', err);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  }
);

// ---------------- API: БРОНИРОВАНИЯ ----------------

// Создание брони
app.post('/api/bookings', async (req, res) => {
  try {
    const { telegram_id, trip_id, seats } = req.body;

    if (!telegram_id || !trip_id || !seats) {
      return res.status(400).json({ error: 'Не все данные для бронирования переданы' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res
        .status(400)
        .json({ error: 'Пассажир не найден. Откройте Mini App через /start.' });
    }

    const tripIdNum = Number(trip_id);
    const seatsNum = Number(seats);

    const { booking, trip, passenger: bookingPassenger } = await createBooking({
      tripId: tripIdNum,
      passengerTelegramId: telegram_id,
      seatsBooked: seatsNum,
    });

    const tripFull = await getTripWithDriver(tripIdNum);

    // Уведомление водителю о новой брони
    if (tripFull && tripFull.driver_telegram_id) {
      const passengerName = `${passenger.first_name || ''} ${passenger.last_name || ''}`.trim();
      const passengerUsername = passenger.username ? `@${passenger.username}` : '';
      const noShowCount = passenger.no_show_count || 0;

      const textForDriver =
        'Новая бронь в "попутчики":\n\n' +
        `Маршрут: ${tripFull.from_city} → ${tripFull.to_city}\n` +
        `Выезд: ${tripFull.departure_time}\n\n` +
        `Пассажир: ${passengerName || 'без имени'} ${passengerUsername}\n` +
        `Забронировано мест: ${seatsNum}\n` +
        `Надёжность пассажира: ${noShowCount} неявок.\n\n` +
        `Сумма брони: ${booking.amount_total || 0} ₽\n` +
        `Ваш доход: ${booking.driver_amount || 0} ₽\n` +
        `Комиссия сервиса: ${booking.app_fee || 0} ₽\n\n` +
        'Свяжитесь с пассажиром в Telegram для подтверждения деталей.';

      bot.telegram
        .sendMessage(tripFull.driver_telegram_id, textForDriver)
        .catch((err) =>
          console.error('Ошибка отправки уведомления водителю:', err)
        );
    }

    // Уведомление пассажиру
    if (bookingPassenger && bookingPassenger.telegram_id && tripFull) {
      const driverName = `${tripFull.driver_first_name || ''} ${tripFull.driver_last_name || ''}`.trim();
      const driverUsername = tripFull.driver_username ? `@${tripFull.driver_username}` : '';

      let carText = '';
      if (tripFull.car_make || tripFull.car_color || tripFull.car_plate) {
        const parts = [];
        if (tripFull.car_color) parts.push(tripFull.car_color);
        if (tripFull.car_make) parts.push(tripFull.car_make);
        const main = parts.join(' ');
        if (tripFull.car_plate) {
          carText = `Авто: ${main} (${tripFull.car_plate})`;
        } else if (main) {
          carText = `Авто: ${main}`;
        }
      }

      const textForPassenger =
        'Ваша бронь в "попутчики":\n\n' +
        `Маршрут: ${tripFull.from_city} → ${tripFull.to_city}\n` +
        `Выезд: ${tripFull.departure_time}\n\n` +
        `Водитель: ${driverName || 'без имени'} ${driverUsername}\n` +
        `Забронировано мест: ${booking.seats_booked}\n` +
        `К оплате водителю: ${booking.amount_total || 0} ₽\n` +
        (carText ? carText + '\n\n' : '\n') +
        'Свяжитесь с водителем в Telegram для уточнения деталей.';

      bot.telegram
        .sendMessage(bookingPassenger.telegram_id, textForPassenger)
        .catch((err) =>
          console.error('Ошибка отправки уведомления пассажиру:', err)
        );
    }

    return res.json({ booking, trip });
  } catch (err) {
    console.error('Ошибка /api/bookings:', err);

    if (err.code === 'TRIP_NOT_FOUND') {
      return res.status(400).json({ error: 'Поездка не найдена' });
    }
    if (err.code === 'BAD_SEATS') {
      return res.status(400).json({ error: 'Некорректное количество мест' });
    }
    if (err.code === 'NOT_ENOUGH_SEATS') {
      return res.status(400).json({ error: 'Недостаточно свободных мест' });
    }
    if (err.code === 'PASSENGER_NOT_FOUND') {
      return res.status(400).json({ error: 'Пассажир не найден' });
    }

    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Отмена бронирования пассажиром
app.post('/api/bookings/cancel', async (req, res) => {
  try {
    const { telegram_id, booking_id } = req.body;

    if (!telegram_id || !booking_id) {
      return res
        .status(400)
        .json({ error: 'Не указаны telegram_id или booking_id' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res.status(400).json({ error: 'Пассажир не найден' });
    }

    const bookingIdNum = Number(booking_id);
    const row = await cancelBookingByPassenger({
      bookingId: bookingIdNum,
      passengerId: passenger.id,
    });

    // Уведомление водителю
    const tripFull = await getTripWithDriver(row.trip_id);
    if (tripFull && tripFull.driver_telegram_id) {
      const passengerName = `${passenger.first_name || ''} ${passenger.last_name || ''}`.trim();
      const passengerUsername = passenger.username ? `@${passenger.username}` : '';

      const textForDriver =
        'Отмена брони в "попутчики":\n\n' +
        `Маршрут: ${tripFull.from_city} → ${tripFull.to_city}\n` +
        `Выезд: ${tripFull.departure_time}\n\n` +
        `Пассажир: ${passengerName || 'без имени'} ${passengerUsername}\n` +
        `Отменено мест: ${row.seats_booked}\n\n` +
        'Места возвращены в свободные.';

      bot.telegram
        .sendMessage(tripFull.driver_telegram_id, textForDriver)
        .catch((err) =>
          console.error(
            'Ошибка отправки уведомления водителю об отмене:',
            err
          )
        );
    }

    return res.json({ success: true, booking: row });
  } catch (err) {
    console.error('Ошибка /api/bookings/cancel:', err);

    if (err.code === 'BOOKING_NOT_FOUND') {
      return res.status(400).json({ error: 'Бронирование не найдено' });
    }
    if (err.code === 'FORBIDDEN') {
      return res
        .status(403)
        .json({ error: 'Нет прав на отмену этого бронирования' });
    }
    if (err.code === 'BAD_STATUS') {
      return res
        .status(400)
        .json({ error: 'Эту бронь уже нельзя отменить' });
    }
    if (err.code === 'TOO_LATE') {
      return res
        .status(400)
        .json({ error: 'Нельзя отменить бронь после начала поездки.' });
    }

    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Активные брони пассажира (до 10 минут после начала)
app.get('/api/passenger/active-bookings', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res.status(400).json({ error: 'Пассажир не найден' });
    }

    const all = await getPassengerBookingsByTelegramId(telegram_id);
    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000;

    const active = (all || []).filter((b) => {
      if (b.status !== 'booked') return false;
      const ts = Date.parse(b.departure_time);
      if (!Number.isFinite(ts)) return true;
      return ts >= cutoff;
    });

    return res.json({ bookings: active });
  } catch (err) {
    console.error('Ошибка /api/passenger/active-bookings:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Отметка "не приехал"
app.post('/api/bookings/no-show', async (req, res) => {
  try {
    const { telegram_id, booking_id } = req.body;

    if (!telegram_id || !booking_id) {
      return res
        .status(400)
        .json({ error: 'Не указаны telegram_id или booking_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const bookingIdNum = Number(booking_id);
    await markBookingNoShow({ bookingId: bookingIdNum, driverId: driver.id });


    // notify passenger that driver took the plan
    try {
      const passengerRow = await dbGet(
        `SELECT u.telegram_id AS passenger_telegram_id, u.username AS passenger_username
         FROM passenger_plans p
         JOIN users u ON u.id = p.passenger_id
         WHERE p.id = ?`,
        [Number(plan_id)]
      );
      const driverRow = await dbGet(
        `SELECT username, first_name, last_name FROM users WHERE id = ?`,
        [driver.id]
      );

      const driverName =
        (driverRow?.username ? '@' + driverRow.username : null) ||
        [driverRow?.first_name, driverRow?.last_name].filter(Boolean).join(' ') ||
        'водитель';

      const msg =
        `✅ Ваш план поездки взят водителем\n` +
        `${plan.from_city} → ${plan.to_city}\n` +
        `Время: ${plan.desired_time}\n` +
        `Водитель: ${driverName}\n\n` +
        `Откройте мини‑приложение, чтобы посмотреть детали и подтвердить поездку после завершения.`;

      await sendMessageSafe(passengerRow?.passenger_telegram_id, msg, webAppOpenKeyboard());
    } catch (e) {
      console.warn('notify passenger error:', e?.message || e);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка /api/bookings/no-show:', err);

    if (err.code === 'BOOKING_NOT_FOUND') {
      return res.status(400).json({ error: 'Бронирование не найдено' });
    }
    if (err.code === 'FORBIDDEN') {
      return res
        .status(403)
        .json({ error: 'Нет прав на изменение этого бронирования' });
    }

    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ---------------- API: ПЛАНЫ ПОЕЗДОК ПАССАЖИРОВ ----------------

// Создание плана поездки пассажиром
app.post('/api/passenger/plans', async (req, res) => {
  try {
    const {
      telegram_id,
      from_city,
      to_city,
      desired_time,
      seats_needed,
      price_per_seat,
      note,
    } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    if (!from_city || !to_city || !desired_time || !seats_needed) {
      return res
        .status(400)
        .json({ error: 'Не все данные для плана поездки переданы' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res.status(400).json({ error: 'Пассажир не найден' });
    }

    const seatsNum = Number(seats_needed);
    if (!Number.isFinite(seatsNum) || seatsNum <= 0) {
      return res.status(400).json({ error: 'Некорректное количество мест' });
    }

    const priceNum = Number(price_per_seat);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'Некорректная цена за место' });
    }

    const amountTotal = priceNum * seatsNum;
    const appFee = Math.round(amountTotal * APP_FEE_PERCENT);
    const driverAmount = amountTotal - appFee;

    await dbRun(
      `
      INSERT INTO passenger_plans (
        passenger_id,
        from_city,
        to_city,
        desired_time,
        seats_needed,
        price_per_seat,
        amount_total,
        driver_amount,
        app_fee,
        note,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now','localtime'))
    `,
      [
        passenger.id,
        from_city,
        to_city,
        desired_time,
        seatsNum,
        priceNum,
        amountTotal,
        driverAmount,
        appFee,
        note || null,
      ]
    );

    const plan = await dbGet(
      `
      SELECT
        p.*,
        u.telegram_id AS passenger_telegram_id,
        u.first_name AS passenger_first_name,
        u.last_name AS passenger_last_name,
        u.username AS passenger_username
      FROM passenger_plans p
      JOIN users u ON u.id = p.passenger_id
      WHERE p.rowid = last_insert_rowid()
    `
    );

    // Автопост в публичный канал (если включено)
    autopostPlanToChannel(plan, passenger).catch((e) =>
      console.warn('autopostPlanToChannel error:', e?.message || e)
    );

    // Нотификация водителям: новый план пассажира под их поездку
    try {
      const rawTrips = await dbAll(
        `
        SELECT
          t.id,
          t.departure_time,
          t.seats_total,
          t.price_per_seat,
          u.telegram_id AS driver_telegram_id,
          u.username AS driver_username
        FROM trips t
        JOIN users u ON u.id = t.driver_id
        WHERE t.from_city = ?
          AND t.to_city = ?
        ORDER BY datetime(t.departure_time) ASC
        `,
        [from_city, to_city]
      );

      const planTs = Date.parse(desired_time);
      const windowMs = 4 * 60 * 60 * 1000; // +/- 4 часа
      const matched = (rawTrips || []).filter((t) => {
        const tt = Date.parse(t.departure_time);
        if (!Number.isFinite(planTs) || !Number.isFinite(tt)) return true;
        return Math.abs(tt - planTs) <= windowMs;
      });

      const seen = new Set();
      for (const t of matched.slice(0, 40)) {
        if (!t.driver_telegram_id || seen.has(t.driver_telegram_id)) continue;
        seen.add(t.driver_telegram_id);

        const msg =
          `🧍 Новый запрос пассажира\n` +
          `${from_city} → ${to_city}\n` +
          `Время: ${desired_time}\n` +
          `Мест нужно: ${seatsNum}\n` +
          `Цена: ${priceNum} ₽/место\n\n` +
          `Зайдите в мини‑приложение → «Планы пассажиров», чтобы забрать.`;
        await sendMessageSafe(t.driver_telegram_id, msg, webAppOpenKeyboard());
      }
    } catch (e) {
      console.warn('notify drivers error:', e?.message || e);
    }

    return res.json({ plan });

  } catch (err) {
    console.error('Ошибка /api/passenger/plans (POST):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Список планов пассажира
app.get('/api/passenger/plans', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res.status(400).json({ error: 'Пассажир не найден' });
    }

    const plans = await dbAll(
      `
      SELECT
        p.*,
        u.telegram_id AS passenger_telegram_id,
        u.first_name AS passenger_first_name,
        u.last_name AS passenger_last_name,
        u.username AS passenger_username,
        d.telegram_id AS driver_telegram_id,
        d.first_name AS driver_first_name,
        d.last_name AS driver_last_name,
        d.username AS driver_username
      FROM passenger_plans p
      JOIN users u ON u.id = p.passenger_id
      LEFT JOIN users d ON d.id = p.driver_id
      WHERE u.telegram_id = ?
      ORDER BY datetime(p.desired_time) ASC, p.id ASC
    `,
      [String(telegram_id)]
    );

    return res.json({ plans });
  } catch (err) {
    console.error('Ошибка /api/passenger/plans (GET):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Отмена плана пассажиром
app.post('/api/passenger/plans/cancel', async (req, res) => {
  try {
    const { telegram_id, plan_id } = req.body;

    if (!telegram_id || !plan_id) {
      return res
        .status(400)
        .json({ error: 'Не указаны telegram_id или plan_id' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res.status(400).json({ error: 'Пассажир не найден' });
    }

    const plan = await dbGet(
      `
      SELECT *
      FROM passenger_plans
      WHERE id = ?
    `,
      [Number(plan_id)]
    );

    if (!plan) {
      return res.status(400).json({ error: 'Запланированная поездка не найдена' });
    }

    if (plan.passenger_id !== passenger.id) {
      return res.status(403).json({ error: 'Нет прав на отмену этой поездки' });
    }

    if (plan.status !== 'active') {
      return res
        .status(400)
        .json({ error: 'Эту поездку уже нельзя отменить' });
    }

    const ts = Date.parse(plan.desired_time);
    const now = Date.now();
    if (Number.isFinite(ts) && now >= ts) {
      return res
        .status(400)
        .json({ error: 'Нельзя отменить поездку после желаемого времени' });
    }

    await dbRun(
      `
      UPDATE passenger_plans
      SET status = 'cancelled'
      WHERE id = ?
    `,
      [plan.id]
    );


    // notify passenger that driver took the plan
    try {
      const passengerRow = await dbGet(
        `SELECT u.telegram_id AS passenger_telegram_id, u.username AS passenger_username
         FROM passenger_plans p
         JOIN users u ON u.id = p.passenger_id
         WHERE p.id = ?`,
        [Number(plan_id)]
      );
      const driverRow = await dbGet(
        `SELECT username, first_name, last_name FROM users WHERE id = ?`,
        [driver.id]
      );

      const driverName =
        (driverRow?.username ? '@' + driverRow.username : null) ||
        [driverRow?.first_name, driverRow?.last_name].filter(Boolean).join(' ') ||
        'водитель';

      const msg =
        `✅ Ваш план поездки взят водителем\n` +
        `${plan.from_city} → ${plan.to_city}\n` +
        `Время: ${plan.desired_time}\n` +
        `Водитель: ${driverName}\n\n` +
        `Откройте мини‑приложение, чтобы посмотреть детали и подтвердить поездку после завершения.`;

      await sendMessageSafe(passengerRow?.passenger_telegram_id, msg, webAppOpenKeyboard());
    } catch (e) {
      console.warn('notify passenger error:', e?.message || e);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка /api/passenger/plans/cancel:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Список активных планов для водителей (свернутый блок)
app.get('/api/driver/passenger-plans', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const now = Date.now();

    const plans = await dbAll(
      `
      SELECT
        p.*,
        u.telegram_id AS passenger_telegram_id,
        u.first_name AS passenger_first_name,
        u.last_name AS passenger_last_name,
        u.username AS passenger_username,
        u.no_show_count AS passenger_no_show_count
      FROM passenger_plans p
      JOIN users u ON u.id = p.passenger_id
      WHERE p.status = 'active'
      ORDER BY datetime(p.desired_time) ASC, p.id ASC
    `
    );

    // Можно отфильтровать откровенно "просроченные" планы, если надо
    const filtered = plans.filter((p) => {
      const ts = Date.parse(p.desired_time);
      if (!Number.isFinite(ts)) return true;
      // показываем планы, которые ещё не начались или начались не более 1 часа назад
      const cutoff = now - 60 * 60 * 1000;
      return ts >= cutoff;
    });

    return res.json({ plans: filtered });
  } catch (err) {
    console.error('Ошибка /api/driver/passenger-plans:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Выбор плана водителем («вас заберёт водитель»)
app.post('/api/driver/passenger-plans/take', async (req, res) => {
  try {
    const { telegram_id, plan_id } = req.body;

    if (!telegram_id || !plan_id) {
      return res
        .status(400)
         .json({ error: 'Не указаны telegram_id или plan_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    if (driver.is_blocked) {
      return res.status(403).json({ error: 'Ваш профиль заблокирован администратором.' });
    }

    const plan = await dbGet(
      `
      SELECT *
      FROM passenger_plans
      WHERE id = ?
    `,
      [Number(plan_id)]
    );

    if (!plan) {
      return res.status(400).json({ error: 'Запланированная поездка не найдена' });
    }

    if (plan.status !== 'active') {
      return res
        .status(400)
        .json({ error: 'Эта поездка уже недоступна' });
    }

    const ts = Date.parse(plan.desired_time);
    const now = Date.now();
    if (Number.isFinite(ts) && now >= ts) {
      return res
        .status(400)
        .json({ error: 'Слишком поздно брать эту поездку' });
    }

    // Пытаемся взять план
    const upd = await dbRun(
      `
      UPDATE passenger_plans
      SET status = 'taken',
          driver_id = ?,
          taken_at = datetime('now','localtime')
      WHERE id = ?
        AND status = 'active'
    `,
      [driver.id, plan.id]
    );

    if (!upd || upd.changes === 0) {
      return res
        .status(400)
        .json({ error: 'Эту поездку уже забрал другой водитель' });
    }

    // Берём расширенную информацию о плане, пассажире и водителе
    const full = await dbGet(
      `
      SELECT
        p.*,
        pu.telegram_id AS passenger_telegram_id,
        pu.first_name AS passenger_first_name,
        pu.last_name AS passenger_last_name,
        pu.username AS passenger_username,
        du.telegram_id AS driver_telegram_id,
        du.first_name AS driver_first_name,
        du.last_name AS driver_last_name,
        du.username AS driver_username,
        du.car_make AS driver_car_make,
        du.car_color AS driver_car_color,
        du.car_plate AS driver_car_plate
      FROM passenger_plans p
      JOIN users pu ON pu.id = p.passenger_id
      LEFT JOIN users du ON du.id = p.driver_id
      WHERE p.id = ?
    `,
      [plan.id]
    );

    if (full && full.passenger_telegram_id) {
      const driverName = `${full.driver_first_name || ''} ${full.driver_last_name || ''}`.trim();
      const driverUsername = full.driver_username ? `@${full.driver_username}` : '';

      let carText = '';
      if (full.driver_car_make || full.driver_car_color || full.driver_car_plate) {
        const parts = [];
        if (full.driver_car_color) parts.push(full.driver_car_color);
        if (full.driver_car_make) parts.push(full.driver_car_make);
        const main = parts.join(' ');
        if (full.driver_car_plate) {
          carText = `Авто: ${main} (${full.driver_car_plate})`;
        } else if (main) {
          carText = `Авто: ${main}`;
        }
      }

      const textForPassenger =
        'Вас заберёт водитель в "попутчики":\n\n' +
        `Маршрут: ${full.from_city} → ${full.to_city}\n` +
        `Желаемое время: ${full.desired_time}\n\n` +
        `Водитель: ${driverName || 'без имени'} ${driverUsername}\n` +
        (carText ? carText + '\n\n' : '\n') +
        'Откройте мини-приложение "попутчики", чтобы договориться о деталях.';

      bot.telegram
        .sendMessage(full.passenger_telegram_id, textForPassenger)
        .catch((err) =>
          console.error('Ошибка отправки уведомления пассажиру о плане:', err)
        );
    }

    // Можно дополнительно уведомить водителя, что план успешно взят
    try {
      if (full && full.driver_telegram_id) {
        const passengerName = `${full.passenger_first_name || ''} ${full.passenger_last_name || ''}`.trim();
        const passengerUsername = full.passenger_username ? `@${full.passenger_username}` : '';

        const textForDriver =
          'Вы взяли запланированную поездку пассажира в "попутчики":\n\n' +
          `Маршрут: ${full.from_city} → ${full.to_city}\n` +
          `Желаемое время: ${full.desired_time}\n\n` +
          `Пассажир: ${passengerName || 'без имени'} ${passengerUsername}\n\n` +
          'Свяжитесь с пассажиром в Telegram для уточнения деталей.';

        bot.telegram
          .sendMessage(full.driver_telegram_id, textForDriver)
          .catch((err) =>
            console.error('Ошибка отправки уведомления водителю о плане:', err)
          );
      }
    } catch (err) {
      console.error('Ошибка уведомления водителя о взятом плане:', err);
    }


    // notify passenger that driver took the plan
    try {
      const passengerRow = await dbGet(
        `SELECT u.telegram_id AS passenger_telegram_id, u.username AS passenger_username
         FROM passenger_plans p
         JOIN users u ON u.id = p.passenger_id
         WHERE p.id = ?`,
        [Number(plan_id)]
      );
      const driverRow = await dbGet(
        `SELECT username, first_name, last_name FROM users WHERE id = ?`,
        [driver.id]
      );

      const driverName =
        (driverRow?.username ? '@' + driverRow.username : null) ||
        [driverRow?.first_name, driverRow?.last_name].filter(Boolean).join(' ') ||
        'водитель';

      const msg =
        `✅ Ваш план поездки взят водителем\n` +
        `${plan.from_city} → ${plan.to_city}\n` +
        `Время: ${plan.desired_time}\n` +
        `Водитель: ${driverName}\n\n` +
        `Откройте мини‑приложение, чтобы посмотреть детали и подтвердить поездку после завершения.`;

      await sendMessageSafe(passengerRow?.passenger_telegram_id, msg, webAppOpenKeyboard());
    } catch (e) {
      console.warn('notify passenger error:', e?.message || e);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка /api/driver/passenger-plans/take:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ---------------- API: ПОДТВЕРЖДЕНИЕ И ОТЗЫВЫ ----------------

async function getRideParticipants(contextType, contextId) {
  if (contextType === 'plan') {
    const row = await dbGet(
      `
      SELECT
        p.id,
        p.passenger_id,
        p.driver_id,
        p.status,
        pu.telegram_id AS passenger_telegram_id,
        du.telegram_id AS driver_telegram_id,
        pu.username AS passenger_username,
        du.username AS driver_username
      FROM passenger_plans p
      JOIN users pu ON pu.id = p.passenger_id
      LEFT JOIN users du ON du.id = p.driver_id
      WHERE p.id = ?
    `,
      [Number(contextId)]
    );
    return row || null;
  }

  if (contextType === 'booking') {
    // NOTE: предполагаем, что bookings.passenger_id существует (обычно так и есть).
    // Если в вашей схеме иначе — скажи, и я подстрою под вашу таблицу.
    const row = await dbGet(
      `
      SELECT
        b.id,
        b.status,
        b.passenger_id,
        t.driver_id,
        pu.telegram_id AS passenger_telegram_id,
        du.telegram_id AS driver_telegram_id,
        pu.username AS passenger_username,
        du.username AS driver_username
      FROM bookings b
      JOIN trips t ON t.id = b.trip_id
      JOIN users pu ON pu.id = b.passenger_id
      JOIN users du ON du.id = t.driver_id
      WHERE b.id = ?
    `,
      [Number(contextId)]
    );
    return row || null;
  }

  return null;
}

// получить состояние подтверждения + факт отзыва "уже оставлял"
app.get('/api/rides/confirmation', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    const { context_type, context_id } = req.query;

    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Нет context_type/context_id' });

    const me = await getUserByTelegramId(String(telegram_id));
    if (!me) return res.status(400).json({ error: 'Пользователь не найден' });

    const c = await dbGet(
      `SELECT * FROM ride_confirmations WHERE context_type = ? AND context_id = ?`,
      [String(context_type), Number(context_id)]
    );

    const completed = !!(c && c.driver_confirmed_at && c.passenger_confirmed_at);

    const reviewed = await dbGet(
      `SELECT 1 as ok FROM reviews WHERE context_type = ? AND context_id = ? AND from_user_id = ?`,
      [String(context_type), Number(context_id), me.id]
    );

    return res.json({
      confirmation: c || null,
      completed,
      already_reviewed: !!reviewed
    });
  } catch (err) {
    console.error('Ошибка /api/rides/confirmation:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// подтвердить поездку (со стороны пассажира или водителя)
app.post('/api/rides/confirm', async (req, res) => {
  try {
    const { telegram_id, context_type, context_id } = req.body;

    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Нет context_type/context_id' });

    const me = await getUserByTelegramId(String(telegram_id));
    if (!me) return res.status(400).json({ error: 'Пользователь не найден' });

    const p = await getRideParticipants(String(context_type), Number(context_id));
    if (!p) return res.status(400).json({ error: 'Поездка не найдена' });

    // определяем роль текущего
    let role = null;
    if (p.driver_id && me.id === p.driver_id) role = 'driver';
    if (p.passenger_id && me.id === p.passenger_id) role = 'passenger';
    if (!role) return res.status(403).json({ error: 'Нет прав' });

    // для plan — должен быть taken
    if (String(context_type) === 'plan' && p.status !== 'taken') {
      return res.status(400).json({ error: 'План ещё не взят водителем' });
    }
    // для booking — не должен быть cancelled/no_show
    if (String(context_type) === 'booking' && (p.status === 'cancelled' || p.status === 'no_show')) {
      return res.status(400).json({ error: 'Эту бронь нельзя подтвердить' });
    }

    // ensure row exists
    await dbRun(
      `INSERT INTO ride_confirmations (context_type, context_id) VALUES (?, ?)
       ON CONFLICT(context_type, context_id) DO NOTHING`,
      [String(context_type), Number(context_id)]
    );

    if (role === 'driver') {
      await dbRun(
        `UPDATE ride_confirmations
         SET driver_confirmed_at = COALESCE(driver_confirmed_at, datetime('now','localtime'))
         WHERE context_type = ? AND context_id = ?`,
        [String(context_type), Number(context_id)]
      );
    } else {
      await dbRun(
        `UPDATE ride_confirmations
         SET passenger_confirmed_at = COALESCE(passenger_confirmed_at, datetime('now','localtime'))
         WHERE context_type = ? AND context_id = ?`,
        [String(context_type), Number(context_id)]
      );
    }

    const c = await dbGet(
      `SELECT * FROM ride_confirmations WHERE context_type = ? AND context_id = ?`,
      [String(context_type), Number(context_id)]
    );

    const completed = !!(c && c.driver_confirmed_at && c.passenger_confirmed_at);

    return res.json({ success: true, confirmation: c, completed });
  } catch (err) {
    console.error('Ошибка /api/rides/confirm:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// оставить отзыв (можно только когда confirmed обеими сторонами)
app.post('/api/rides/review', async (req, res) => {
  try {
    const { telegram_id, context_type, context_id, rating, tags, comment } = req.body;

    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Нет context_type/context_id' });

    const r = Number(rating);
    if (!Number.isFinite(r) || r < 1 || r > 5) return res.status(400).json({ error: 'Рейтинг 1..5' });

    const me = await getUserByTelegramId(String(telegram_id));
    if (!me) return res.status(400).json({ error: 'Пользователь не найден' });

    const c = await dbGet(
      `SELECT * FROM ride_confirmations WHERE context_type = ? AND context_id = ?`,
      [String(context_type), Number(context_id)]
    );
    const completed = !!(c && c.driver_confirmed_at && c.passenger_confirmed_at);
    if (!completed) return res.status(400).json({ error: 'Сначала подтвердите поездку с двух сторон' });

    const p = await getRideParticipants(String(context_type), Number(context_id));
    if (!p) return res.status(400).json({ error: 'Поездка не найдена' });

    let toUserId = null;
    if (p.driver_id && me.id === p.passenger_id) toUserId = p.driver_id;      // пассажир оценивает водителя
    if (p.passenger_id && me.id === p.driver_id) toUserId = p.passenger_id;  // водитель оценивает пассажира
    if (!toUserId) return res.status(403).json({ error: 'Нет прав' });

    const tagsStr = Array.isArray(tags) ? JSON.stringify(tags.slice(0, 8)) : null;
    const commentStr = comment ? String(comment).slice(0, 600) : null;

    try {
      await dbRun(
        `INSERT INTO reviews (context_type, context_id, from_user_id, to_user_id, rating, tags, comment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [String(context_type), Number(context_id), me.id, toUserId, r, tagsStr, commentStr]
      );
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        return res.status(400).json({ error: 'Вы уже оставляли отзыв по этой поездке' });
      }
      throw e;
    }

    // обновим агрегаты
    await dbRun(
      `UPDATE users
       SET rating_sum   = COALESCE(rating_sum, 0) + ?,
           rating_count = COALESCE(rating_count, 0) + 1,
           rating_avg   = (COALESCE(rating_sum, 0) + ?) * 1.0 / (COALESCE(rating_count, 0) + 1)
       WHERE id = ?`,
      [r, r, toUserId]
    );


    // notify passenger that driver took the plan
    try {
      const passengerRow = await dbGet(
        `SELECT u.telegram_id AS passenger_telegram_id, u.username AS passenger_username
         FROM passenger_plans p
         JOIN users u ON u.id = p.passenger_id
         WHERE p.id = ?`,
        [Number(plan_id)]
      );
      const driverRow = await dbGet(
        `SELECT username, first_name, last_name FROM users WHERE id = ?`,
        [driver.id]
      );

      const driverName =
        (driverRow?.username ? '@' + driverRow.username : null) ||
        [driverRow?.first_name, driverRow?.last_name].filter(Boolean).join(' ') ||
        'водитель';

      const msg =
        `✅ Ваш план поездки взят водителем\n` +
        `${plan.from_city} → ${plan.to_city}\n` +
        `Время: ${plan.desired_time}\n` +
        `Водитель: ${driverName}\n\n` +
        `Откройте мини‑приложение, чтобы посмотреть детали и подтвердить поездку после завершения.`;

      await sendMessageSafe(passengerRow?.passenger_telegram_id, msg, webAppOpenKeyboard());
    } catch (e) {
      console.warn('notify passenger error:', e?.message || e);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка /api/rides/review:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ---------------- API: АДМИН ----------------

// Настройки для админа (платный режим, реквизиты)
app.get('/api/admin/settings', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    if (String(telegram_id) !== String(ADMIN_TELEGRAM_ID)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const settings = await getAppSettings();
    return res.json({ settings });
  } catch (err) {
    console.error('Ошибка /api/admin/settings (GET):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/admin/settings', async (req, res) => {
  try {
    const { telegram_id, monetization_enabled, payment_details } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    if (String(telegram_id) !== String(ADMIN_TELEGRAM_ID)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const updated = await updateAppSettings({
      monetizationEnabled:
        monetization_enabled === null ? undefined : !!monetization_enabled,
      paymentDetails: payment_details || '',
    });

    return res.json({ settings: updated });
  } catch (err) {
    console.error('Ошибка /api/admin/settings (POST):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Статистика сервиса
app.get('/api/admin/stats', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    if (String(telegram_id) !== String(ADMIN_TELEGRAM_ID)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const stats = await getAdminStats();
    return res.json({ stats });
  } catch (err) {
    console.error('Ошибка /api/admin/stats:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Водители за день + чеки
app.get('/api/admin/daily-drivers', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    const date = req.query.date; // 'YYYY-MM-DD' или undefined

    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    if (String(telegram_id) !== String(ADMIN_TELEGRAM_ID)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const drivers = await getAdminDailyDrivers(date);
    return res.json({ drivers });
  } catch (err) {
    console.error('Ошибка /api/admin/daily-drivers:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Блокировка / разблокировка водителя админом
app.post('/api/admin/block-driver', async (req, res) => {
  try {
    const { telegram_id, driver_telegram_id, block } = req.body;

    if (!telegram_id || !driver_telegram_id) {
      return res
        .status(400)
        .json({ error: 'Не указаны telegram_id или driver_telegram_id' });
    }

    if (String(telegram_id) !== String(ADMIN_TELEGRAM_ID)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    await setUserBlockedByTelegramId(driver_telegram_id, !!block);


    // notify passenger that driver took the plan
    try {
      const passengerRow = await dbGet(
        `SELECT u.telegram_id AS passenger_telegram_id, u.username AS passenger_username
         FROM passenger_plans p
         JOIN users u ON u.id = p.passenger_id
         WHERE p.id = ?`,
        [Number(plan_id)]
      );
      const driverRow = await dbGet(
        `SELECT username, first_name, last_name FROM users WHERE id = ?`,
        [driver.id]
      );

      const driverName =
        (driverRow?.username ? '@' + driverRow.username : null) ||
        [driverRow?.first_name, driverRow?.last_name].filter(Boolean).join(' ') ||
        'водитель';

      const msg =
        `✅ Ваш план поездки взят водителем\n` +
        `${plan.from_city} → ${plan.to_city}\n` +
        `Время: ${plan.desired_time}\n` +
        `Водитель: ${driverName}\n\n` +
        `Откройте мини‑приложение, чтобы посмотреть детали и подтвердить поездку после завершения.`;

      await sendMessageSafe(passengerRow?.passenger_telegram_id, msg, webAppOpenKeyboard());
    } catch (e) {
      console.warn('notify passenger error:', e?.message || e);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка /api/admin/block-driver:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ---------------- ЗАПУСК ----------------

bot.launch().then(() => {
  console.log('Бот запущен');
});

app.listen(PORT, () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

// Для корректной остановки бота
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
