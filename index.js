
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Telegraf } = require('telegraf');

const {
  dbRun,
  dbGet,
  dbAll,
  upsertUserFromTelegram,
  getUserByTelegramId,
  getDriverProfileByTelegramId,
  updateDriverCarProfile,
  setUserBlockedByTelegramId,
  createTrip,
  getLatestTrips,
  getTripWithDriver,
  getDriverTripsByTelegramId,
  deleteTripByDriver,
  createBooking,
  getTripBookingsForDriver,
  markBookingNoShow,
  getPassengerBookingsByTelegramId,
  cancelBookingByPassenger,
  createPassengerPlan,
  getPassengerPlanById,
  getPassengerPlansByTelegramId,
  cancelPassengerPlan,
  getActivePassengerPlans,
  takePassengerPlan,
  getDriverTakenPassengerPlansByTelegramId,
  getOwnerDashboardStats,
  getOwnerDriverActivity,
  getOwnerRecentTrips,
  getOwnerRecentPassengerPlans,
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';
const PORT = Number(process.env.PORT || 3000);
const OWNER_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '504348666';
const OWNER_PANEL_PASSWORD = (process.env.OWNER_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
const OWNER_SESSION_SECRET = (process.env.OWNER_SESSION_SECRET || process.env.SESSION_SECRET || BOT_TOKEN || 'owner-session-secret').trim();
const OWNER_SESSION_COOKIE = 'poputchiki_owner_session';
const OWNER_SESSION_TTL_MS = Math.max(1, Number(process.env.OWNER_SESSION_TTL_HOURS || 12)) * 60 * 60 * 1000;
const DISABLE_BOT = process.env.DISABLE_BOT === '1';

const PUBLIC_CHANNEL = (process.env.PUBLIC_CHANNEL || '').trim();
const AUTOPOST_ENABLED = process.env.AUTOPOST_ENABLED !== '0';
const AUTOPOST_TRIPS = process.env.AUTOPOST_TRIPS !== '0';
const AUTOPOST_PLANS = process.env.AUTOPOST_PLANS !== '0';
const CHANNEL_BRAND = (process.env.CHANNEL_BRAND || 'Попутчики').trim();

if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в .env или переменных окружения');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let BOT_USERNAME_RUNTIME = (process.env.BOT_USERNAME || '').replace('@', '').trim();
const WEBAPP_SHORTNAME = (process.env.WEBAPP_SHORTNAME || '').trim();

async function sendMessageSafe(telegramId, text, extra = undefined) {
  try {
    if (!telegramId) return;
    await bot.telegram.sendMessage(String(telegramId), String(text).slice(0, 3500), extra);
  } catch (error) {
    console.warn('sendMessageSafe error:', error?.message || error);
  }
}

function withStartParamUrl(baseUrl, startParam) {
  const value = String(startParam || '').trim();
  if (!value) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}startapp=${encodeURIComponent(value)}`;
}

function buildDeeplinkPrefix() {
  const username = (BOT_USERNAME_RUNTIME || '').replace('@', '').trim();
  if (username && WEBAPP_SHORTNAME) {
    return `https://t.me/${username}/${WEBAPP_SHORTNAME}?startapp=`;
  }
  if (username) {
    return `https://t.me/${username}?startapp=`;
  }
  const separator = WEBAPP_URL.includes('?') ? '&' : '?';
  return `${WEBAPP_URL}${separator}startapp=`;
}

function buildDeeplink(startParam) {
  return buildDeeplinkPrefix() + encodeURIComponent(String(startParam || '').trim());
}

function parseCookiesFromHeader(cookieHeader) {
  const source = String(cookieHeader || '');
  if (!source) return {};

  return source.split(';').reduce((acc, part) => {
    const [rawName, ...rest] = part.trim().split('=');
    if (!rawName) return acc;
    acc[rawName] = decodeURIComponent(rest.join('=') || '');
    return acc;
  }, {});
}

function signOwnerSessionPayload(encodedPayload) {
  return crypto.createHmac('sha256', OWNER_SESSION_SECRET).update(String(encodedPayload || ''), 'utf8').digest('base64url');
}

function hasValidOwnerSessionToken(token) {
  if (!token || !String(token).includes('.')) return false;

  const [encodedPayload, signature] = String(token).split('.');
  const expectedSignature = signOwnerSessionPayload(encodedPayload);
  if (!signature || !isSameSecret(signature, expectedSignature)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    return !!(payload && payload.role === 'owner' && payload.exp && Number(payload.exp) >= Date.now());
  } catch (_) {
    return false;
  }
}

function hasOwnerSessionFromRequest(req) {
  const token = parseCookiesFromHeader(req?.headers?.cookie)[OWNER_SESSION_COOKIE];
  return hasValidOwnerSessionToken(token);
}

function webAppOpenKeyboard(label = 'Открыть мини-приложение', startParam = '') {
  const url = withStartParamUrl(WEBAPP_URL, startParam);
  return {
    reply_markup: {
      inline_keyboard: [[{ text: label, web_app: { url } }]],
    },
  };
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function compactText(value, max = 220) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDT(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return escapeHtml(text.replace('T', ' '));
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number));
}

function channelKeyboard(openUrl) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Открыть в приложении', url: openUrl }]],
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
  } catch (error) {
    console.warn('channel autopost error:', error?.message || error);
  }
}

function buildTripPostHtml(trip) {
  const note = compactText(trip.note || '', 240);
  let html = '';
  html += `<b>${escapeHtml(CHANNEL_BRAND)}</b>\n`;
  html += `<b>🚗 Поездка</b>\n`;
  html += `<b>${escapeHtml(trip.from_city)} → ${escapeHtml(trip.to_city)}</b>\n`;
  html += `────────────\n`;
  html += `🕒 <b>${formatDT(trip.departure_time)}</b>\n`;
  html += `💺 Свободно мест: <b>${escapeHtml(trip.seats_available)}</b>\n`;
  html += `💰 Цена: <b>${formatMoney(trip.price_per_seat)} ₽/место</b>\n`;
  if (note) html += `📝 <i>${escapeHtml(note)}</i>\n`;
  return html;
}

function buildPlanPostHtml(plan) {
  const note = compactText(plan.note || '', 240);
  let html = '';
  html += `<b>${escapeHtml(CHANNEL_BRAND)}</b>\n`;
  html += `<b>🙋 Заявка пассажира</b>\n`;
  html += `<b>${escapeHtml(plan.from_city)} → ${escapeHtml(plan.to_city)}</b>\n`;
  html += `────────────\n`;
  html += `🕒 <b>${formatDT(plan.desired_time)}</b>\n`;
  html += `👥 Нужно мест: <b>${escapeHtml(plan.seats_needed)}</b>\n`;
  html += `💰 Бюджет: <b>${formatMoney(plan.price_per_seat)} ₽/место</b>\n`;
  if (note) html += `📝 <i>${escapeHtml(note)}</i>\n`;
  return html;
}

async function autopostTripToChannel(trip) {
  if (!AUTOPOST_TRIPS || !trip) return;
  const html = buildTripPostHtml(trip);
  const openUrl = buildDeeplink(`trip_${trip.id}`);
  await sendToChannelSafe(html, channelKeyboard(openUrl));
}

async function autopostPlanToChannel(plan) {
  if (!AUTOPOST_PLANS || !plan) return;
  const html = buildPlanPostHtml(plan);
  const openUrl = buildDeeplink(`plan_${plan.id}`);
  await sendToChannelSafe(html, channelKeyboard(openUrl));
}

const app = express();
app.disable('etag');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

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
    'Привет! Нажмите кнопку ниже, чтобы открыть мини-приложение "попутчики".',
    webAppOpenKeyboard('Открыть попутчики')
  );
});

if (!DISABLE_BOT) {
  bot.telegram
    .getMe()
    .then((me) => {
      if (me && me.username) {
        BOT_USERNAME_RUNTIME = String(me.username).replace('@', '').trim();
      }
    })
    .catch((error) => {
      console.warn('getMe error:', error?.message || error);
    });
}

const REQUIRE_INIT_DATA = process.env.REQUIRE_INIT_DATA !== '0';
const INIT_DATA_MAX_AGE_SEC = Number(process.env.INIT_DATA_MAX_AGE_SEC || 86400);

function validateTelegramInitData(initData, botToken, maxAgeSec) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, error: 'hash missing' };

    params.delete('hash');
    const pairs = [];
    for (const [key, value] of params.entries()) pairs.push(`${key}=${value}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calculated !== hash) return { ok: false, error: 'hash mismatch' };

    const authDate = Number(params.get('auth_date'));
    if (Number.isFinite(authDate) && maxAgeSec) {
      const age = Math.floor(Date.now() / 1000) - authDate;
      if (age > maxAgeSec) return { ok: false, error: 'initData expired' };
    }

    const userStr = params.get('user');
    let user = null;
    if (userStr) {
      try {
        user = JSON.parse(userStr);
      } catch (_) {
        user = null;
      }
    }

    return { ok: true, user, auth_date: authDate };
  } catch (_) {
    return { ok: false, error: 'bad initData' };
  }
}

app.use('/api', (req, res, next) => {
  const isOwnerApi = req.path === '/owner/login' || req.path === '/owner/logout' || req.path === '/owner/session' || req.path.startsWith('/owner/');
  if (isOwnerApi && (hasOwnerSessionFromRequest(req) || req.path === '/owner/login' || req.path === '/owner/session' || req.path === '/owner/logout')) {
    return next();
  }

  const initData =
    req.headers['x-telegram-init-data'] ||
    req.headers['x-telegram-initdata'] ||
    (req.body && req.body.initData) ||
    (req.query && req.query.initData);

  if (!initData) {
    if (!REQUIRE_INIT_DATA) return next();
    return res.status(401).json({ error: 'Нет initData. Откройте мини-приложение из Telegram.' });
  }

  const validation = validateTelegramInitData(String(initData), BOT_TOKEN, INIT_DATA_MAX_AGE_SEC);
  if (!validation.ok || !validation.user || !validation.user.id) {
    if (!REQUIRE_INIT_DATA) return next();
    return res.status(401).json({ error: 'initData не прошёл проверку' });
  }

  req.telegramUser = validation.user;
  req.telegramId = String(validation.user.id);

  if (req.body && typeof req.body === 'object') {
    req.body.telegram_id = req.telegramId;
    if (!req.body.user && req.path === '/init-user') req.body.user = validation.user;
  }

  if (req.query && typeof req.query === 'object' && !req.query.telegram_id) {
    req.query.telegram_id = req.telegramId;
  }

  next();
});

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/owner' || req.path.endsWith('.html'))) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.get('/owner', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

function isOwnerTelegramId(telegramId) {
  return String(telegramId || '') === String(OWNER_TELEGRAM_ID);
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function isSameSecret(left, right) {
  return crypto.timingSafeEqual(sha256Buffer(left), sha256Buffer(right));
}

function isSecureOwnerCookie(req) {
  if (process.env.NODE_ENV !== 'production') return false;
  if (req?.secure) return true;
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  return forwardedProto === 'https';
}

function parseCookies(req) {
  return parseCookiesFromHeader(req.headers.cookie || '');
}

function createOwnerSessionToken() {
  const payload = Buffer.from(
    JSON.stringify({
      role: 'owner',
      exp: Date.now() + OWNER_SESSION_TTL_MS,
    }),
    'utf8'
  ).toString('base64url');

  return `${payload}.${signOwnerSessionPayload(payload)}`;
}

function getOwnerSessionData(req) {
  const token = parseCookies(req)[OWNER_SESSION_COOKIE];
  if (!hasValidOwnerSessionToken(token)) return null;

  const [encodedPayload] = String(token).split('.');
  return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
}

function hasOwnerSession(req) {
  return !!getOwnerSessionData(req);
}

function setOwnerSessionCookie(req, res) {
  res.cookie(OWNER_SESSION_COOKIE, createOwnerSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureOwnerCookie(req),
    path: '/',
    maxAge: OWNER_SESSION_TTL_MS,
  });
}

function clearOwnerSessionCookie(req, res) {
  res.cookie(OWNER_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureOwnerCookie(req),
    path: '/',
    maxAge: 0,
  });
}

function ensureOwnerAccess(req, res) {
  if (hasOwnerSession(req)) {
    return true;
  }

  if (!isOwnerTelegramId(req.telegramId || req.query.telegram_id || req.body.telegram_id)) {
    res.status(403).json({ error: 'Нет доступа' });
    return false;
  }
  return true;
}

app.get('/api/owner/session', (req, res) => {
  const authenticated = hasOwnerSession(req) || isOwnerTelegramId(req.telegramId || req.query.telegram_id);
  return res.json({
    authenticated,
    password_configured: !!OWNER_PANEL_PASSWORD,
  });
});

app.post('/api/owner/login', (req, res) => {
  try {
    if (!OWNER_PANEL_PASSWORD) {
      return res.status(503).json({ error: 'Пароль панели владельца не настроен на сервере' });
    }

    const password = String(req.body.password || '');
    if (!password) {
      return res.status(400).json({ error: 'Введите пароль' });
    }

    if (!isSameSecret(password, OWNER_PANEL_PASSWORD)) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    setOwnerSessionCookie(req, res);
    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка /api/owner/login:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/owner/logout', (req, res) => {
  clearOwnerSessionCookie(req, res);
  return res.json({ success: true });
});

app.post('/api/init-user', async (req, res) => {
  try {
    const user = req.body.user || req.telegramUser;
    if (!user || !user.id) {
      return res.status(400).json({ error: 'Некорректный объект user' });
    }

    const dbUser = await upsertUserFromTelegram(user);
    return res.json({
      user: dbUser,
      is_owner: isOwnerTelegramId(dbUser.telegram_id),
    });
  } catch (error) {
    console.error('Ошибка /api/init-user:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/app-config', async (req, res) => {
  try {
    if (!BOT_USERNAME_RUNTIME && !DISABLE_BOT) {
      try {
        const me = await bot.telegram.getMe();
        if (me && me.username) {
          BOT_USERNAME_RUNTIME = String(me.username).replace('@', '').trim();
        }
      } catch (_) {}
    }

    return res.json({
      deeplink_prefix: buildDeeplinkPrefix(),
      bot_username: BOT_USERNAME_RUNTIME || null,
      webapp_shortname: WEBAPP_SHORTNAME || null,
      owner_telegram_id: OWNER_TELEGRAM_ID,
      autopost: {
        enabled: !!(PUBLIC_CHANNEL && AUTOPOST_ENABLED),
        channel: PUBLIC_CHANNEL || null,
        brand: CHANNEL_BRAND,
      },
    });
  } catch (_) {
    return res.json({ deeplink_prefix: buildDeeplinkPrefix() });
  }
});

app.post('/api/trips', async (req, res) => {
  try {
    const { telegram_id, from_city, to_city, departure_time, seats_total, price_per_seat, note } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Пользователь не найден. Сначала откройте приложение из Telegram.' });
    }
    if (driver.is_blocked) {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован владельцем сервиса.' });
    }

    const trip = await createTrip({
      driverId: driver.id,
      fromCity: from_city,
      toCity: to_city,
      departureTime: departure_time,
      seatsTotal: seats_total,
      pricePerSeat: price_per_seat,
      note,
    });

    autopostTripToChannel(trip).catch((error) => console.warn('autopost trip error:', error?.message || error));

    try {
      const plans = await getActivePassengerPlans(120);
      const departureTs = Date.parse(departure_time);
      const timeWindow = 4 * 60 * 60 * 1000;

      for (const plan of plans) {
        if (String(plan.from_city).trim().toLowerCase() !== String(from_city).trim().toLowerCase()) continue;
        if (String(plan.to_city).trim().toLowerCase() !== String(to_city).trim().toLowerCase()) continue;

        const planTs = Date.parse(plan.desired_time);
        if (Number.isFinite(departureTs) && Number.isFinite(planTs) && Math.abs(planTs - departureTs) > timeWindow) {
          continue;
        }

        const message =
          `🚗 Появилась поездка по вашему маршруту\n` +
          `${trip.from_city} → ${trip.to_city}\n` +
          `Время: ${trip.departure_time}\n` +
          `Цена: ${formatMoney(trip.price_per_seat)} ₽/место\n\n` +
          `Откройте мини-приложение и посмотрите детали.`;
        await sendMessageSafe(plan.passenger_telegram_id, message, webAppOpenKeyboard('Открыть поездку', `trip_${trip.id}`));
      }
    } catch (error) {
      console.warn('notify matching plans error:', error?.message || error);
    }

    return res.json({ trip });
  } catch (error) {
    console.error('Ошибка /api/trips (POST):', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/trips', async (req, res) => {
  try {
    const rawTrips = await getLatestTrips(80);
    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000;

    const queryFrom = String(req.query.from || '').trim().toLowerCase();
    const queryTo = String(req.query.to || '').trim().toLowerCase();
    const queryDay = String(req.query.day || 'any').trim().toLowerCase();
    const querySort = String(req.query.sort || 'time_asc').trim().toLowerCase();

    const currentDate = new Date();
    const startOfToday = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime();
    const startOfTomorrow = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 1).getTime();
    const startOfDayAfterTomorrow = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate() + 2).getTime();

    let trips = (rawTrips || []).filter((trip) => {
      if (trip.seats_available <= 0) return false;
      const tripTs = Date.parse(trip.departure_time);
      if (Number.isFinite(tripTs) && tripTs < cutoff) return false;
      if (queryFrom && String(trip.from_city || '').trim().toLowerCase() !== queryFrom) return false;
      if (queryTo && String(trip.to_city || '').trim().toLowerCase() !== queryTo) return false;

      if (queryDay !== 'any' && Number.isFinite(tripTs)) {
        if (queryDay === 'today' && !(tripTs >= startOfToday && tripTs < startOfTomorrow)) return false;
        if (queryDay === 'tomorrow' && !(tripTs >= startOfTomorrow && tripTs < startOfDayAfterTomorrow)) return false;
        if (queryDay === 'weekend') {
          const day = new Date(tripTs).getDay();
          if (!(day === 0 || day === 6)) return false;
        }
      }

      return true;
    });

    const timeValue = (trip) => {
      const ts = Date.parse(trip.departure_time);
      return Number.isFinite(ts) ? ts : 0;
    };
    const priceValue = (trip) => Number(trip.price_per_seat || 0);

    if (querySort === 'time_desc') trips.sort((a, b) => timeValue(b) - timeValue(a));
    else if (querySort === 'price_asc') trips.sort((a, b) => priceValue(a) - priceValue(b));
    else if (querySort === 'price_desc') trips.sort((a, b) => priceValue(b) - priceValue(a));
    else trips.sort((a, b) => timeValue(a) - timeValue(b));

    return res.json({ trips });
  } catch (error) {
    console.error('Ошибка /api/trips (GET):', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/driver/delete-trip', async (req, res) => {
  try {
    const { telegram_id, trip_id } = req.body;
    if (!telegram_id || !trip_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или trip_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });

    const trip = await deleteTripByDriver(trip_id, driver.id);
    return res.json({ success: true, trip });
  } catch (error) {
    console.error('Ошибка /api/driver/delete-trip:', error);
    if (error.code === 'TRIP_NOT_FOUND') return res.status(400).json({ error: 'Поездка не найдена' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Нет прав на удаление этой поездки' });
    if (error.code === 'TOO_LATE') return res.status(400).json({ error: 'Нельзя отменить поездку после её начала.' });
    if (error.code === 'HAS_BOOKINGS') return res.status(400).json({ error: 'Нельзя удалить поездку, по которой уже есть бронирования.' });
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/driver/trips', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });

    const trips = await getDriverTripsByTelegramId(telegram_id);
    return res.json({ trips });
  } catch (error) {
    console.error('Ошибка /api/driver/trips:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/driver/active-trip', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });

    const trips = await getDriverTripsByTelegramId(telegram_id);
    const cutoff = Date.now() - 10 * 60 * 1000;
    const activeTrips = (trips || []).filter((trip) => {
      const ts = Date.parse(trip.departure_time);
      return Number.isFinite(ts) ? ts >= cutoff : false;
    });

    activeTrips.sort((a, b) => Date.parse(a.departure_time) - Date.parse(b.departure_time));
    return res.json({ trip: activeTrips[0] || null });
  } catch (error) {
    console.error('Ошибка /api/driver/active-trip:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/driver/trip-bookings', async (req, res) => {
  try {
    const { telegram_id, trip_id } = req.query;
    if (!telegram_id || !trip_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или trip_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });

    const bookings = await getTripBookingsForDriver(Number(trip_id), driver.id);
    return res.json({ bookings });
  } catch (error) {
    console.error('Ошибка /api/driver/trip-bookings:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/driver/profile', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const profile = await getDriverProfileByTelegramId(telegram_id);
    if (!profile) return res.status(404).json({ error: 'Профиль не найден' });

    return res.json({ profile });
  } catch (error) {
    console.error('Ошибка /api/driver/profile (GET):', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/driver/profile', async (req, res) => {
  try {
    const { telegram_id, car_make, car_color, car_plate } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const profile = await updateDriverCarProfile(telegram_id, {
      carMake: car_make,
      carColor: car_color,
      carPlate: car_plate,
    });

    return res.json({ profile });
  } catch (error) {
    console.error('Ошибка /api/driver/profile (POST):', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { telegram_id, trip_id, seats } = req.body;
    if (!telegram_id || !trip_id || !seats) {
      return res.status(400).json({ error: 'Не все данные для бронирования переданы' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res.status(400).json({ error: 'Пассажир не найден. Откройте приложение из Telegram.' });
    }

    const { booking, trip } = await createBooking({
      tripId: Number(trip_id),
      passengerTelegramId: telegram_id,
      seatsBooked: Number(seats),
    });

    const tripFull = await getTripWithDriver(trip_id);
    if (tripFull?.driver_telegram_id) {
      const passengerName = `${passenger.first_name || ''} ${passenger.last_name || ''}`.trim();
      const passengerUsername = passenger.username ? `@${passenger.username}` : '';
      const textForDriver =
        'Новая бронь в "попутчики":\n\n' +
        `Маршрут: ${tripFull.from_city} → ${tripFull.to_city}\n` +
        `Выезд: ${tripFull.departure_time}\n` +
        `Пассажир: ${passengerName || 'без имени'} ${passengerUsername}\n` +
        `Мест забронировано: ${booking.seats_booked}`;
      await sendMessageSafe(tripFull.driver_telegram_id, textForDriver, webAppOpenKeyboard('Открыть бронь', `trip_${tripFull.id}`));
    }

    return res.json({ booking, trip });
  } catch (error) {
    console.error('Ошибка /api/bookings:', error);
    if (error.code === 'TRIP_NOT_FOUND') return res.status(400).json({ error: 'Поездка не найдена' });
    if (error.code === 'BAD_SEATS') return res.status(400).json({ error: 'Некорректное количество мест' });
    if (error.code === 'NOT_ENOUGH_SEATS') return res.status(400).json({ error: 'Недостаточно свободных мест' });
    if (error.code === 'PASSENGER_NOT_FOUND') return res.status(400).json({ error: 'Пассажир не найден' });
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/bookings/cancel', async (req, res) => {
  try {
    const { telegram_id, booking_id } = req.body;
    if (!telegram_id || !booking_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или booking_id' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) return res.status(400).json({ error: 'Пассажир не найден' });

    const booking = await cancelBookingByPassenger({
      bookingId: Number(booking_id),
      passengerId: passenger.id,
    });

    const tripFull = await getTripWithDriver(booking.trip_id);
    if (tripFull?.driver_telegram_id) {
      const passengerName = `${passenger.first_name || ''} ${passenger.last_name || ''}`.trim();
      const passengerUsername = passenger.username ? `@${passenger.username}` : '';
      const message =
        'Пассажир отменил бронь в "попутчики":\n\n' +
        `Маршрут: ${tripFull.from_city} → ${tripFull.to_city}\n` +
        `Выезд: ${tripFull.departure_time}\n` +
        `Пассажир: ${passengerName || 'без имени'} ${passengerUsername}\n` +
        `Освобождено мест: ${booking.seats_booked}`;
      await sendMessageSafe(tripFull.driver_telegram_id, message, webAppOpenKeyboard('Открыть поездку', `trip_${tripFull.id}`));
    }

    return res.json({ success: true, booking });
  } catch (error) {
    console.error('Ошибка /api/bookings/cancel:', error);
    if (error.code === 'BOOKING_NOT_FOUND') return res.status(400).json({ error: 'Бронирование не найдено' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Нет прав на отмену этого бронирования' });
    if (error.code === 'BAD_STATUS') return res.status(400).json({ error: 'Эту бронь уже нельзя отменить' });
    if (error.code === 'TOO_LATE') return res.status(400).json({ error: 'Нельзя отменить бронь после начала поездки.' });
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/passenger/bookings', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) return res.status(400).json({ error: 'Пассажир не найден' });

    const bookings = await getPassengerBookingsByTelegramId(telegram_id);
    return res.json({ bookings });
  } catch (error) {
    console.error('Ошибка /api/passenger/bookings:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/passenger/active-bookings', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) return res.status(400).json({ error: 'Пассажир не найден' });

    const allBookings = await getPassengerBookingsByTelegramId(telegram_id);
    const cutoff = Date.now() - 10 * 60 * 1000;
    const bookings = (allBookings || []).filter((booking) => {
      if (booking.status !== 'booked') return false;
      const ts = Date.parse(booking.departure_time);
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });

    return res.json({ bookings });
  } catch (error) {
    console.error('Ошибка /api/passenger/active-bookings:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/bookings/no-show', async (req, res) => {
  try {
    const { telegram_id, booking_id } = req.body;
    if (!telegram_id || !booking_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или booking_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });

    await markBookingNoShow({ bookingId: Number(booking_id), driverId: driver.id });
    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка /api/bookings/no-show:', error);
    if (error.code === 'BOOKING_NOT_FOUND') return res.status(400).json({ error: 'Бронирование не найдено' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Нет прав на изменение этого бронирования' });
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});
app.post('/api/passenger/plans', async (req, res) => {
  try {
    const { telegram_id, from_city, to_city, desired_time, seats_needed, price_per_seat, note } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) return res.status(400).json({ error: 'Пассажир не найден' });

    const plan = await createPassengerPlan({
      passengerId: passenger.id,
      fromCity: from_city,
      toCity: to_city,
      desiredTime: desired_time,
      seatsNeeded: seats_needed,
      pricePerSeat: price_per_seat,
      note,
    });

    autopostPlanToChannel(plan).catch((error) => console.warn('autopost plan error:', error?.message || error));

    try {
      const trips = await getLatestTrips(120);
      const planTs = Date.parse(plan.desired_time);
      const timeWindow = 4 * 60 * 60 * 1000;
      const seen = new Set();

      for (const trip of trips) {
        if (String(trip.from_city).trim().toLowerCase() !== String(plan.from_city).trim().toLowerCase()) continue;
        if (String(trip.to_city).trim().toLowerCase() !== String(plan.to_city).trim().toLowerCase()) continue;

        const tripTs = Date.parse(trip.departure_time);
        if (Number.isFinite(planTs) && Number.isFinite(tripTs) && Math.abs(tripTs - planTs) > timeWindow) {
          continue;
        }

        if (!trip.driver_telegram_id || seen.has(trip.driver_telegram_id)) continue;
        seen.add(trip.driver_telegram_id);

        const message =
          `🙋 Появилась заявка пассажира\n` +
          `${plan.from_city} → ${plan.to_city}\n` +
          `Время: ${plan.desired_time}\n` +
          `Нужно мест: ${plan.seats_needed}\n\n` +
          `Откройте мини-приложение и заберите заявку.`;
        await sendMessageSafe(trip.driver_telegram_id, message, webAppOpenKeyboard('Открыть заявку', `plan_${plan.id}`));
      }
    } catch (error) {
      console.warn('notify matching trips error:', error?.message || error);
    }

    return res.json({ plan });
  } catch (error) {
    console.error('Ошибка /api/passenger/plans (POST):', error);
    if (error.code === 'BAD_INPUT') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/passenger/plans', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) return res.status(400).json({ error: 'Пассажир не найден' });

    const plans = await getPassengerPlansByTelegramId(telegram_id);
    return res.json({ plans });
  } catch (error) {
    console.error('Ошибка /api/passenger/plans (GET):', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/passenger/plans/cancel', async (req, res) => {
  try {
    const { telegram_id, plan_id } = req.body;
    if (!telegram_id || !plan_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или plan_id' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) return res.status(400).json({ error: 'Пассажир не найден' });

    const plan = await cancelPassengerPlan({ planId: Number(plan_id), passengerId: passenger.id });
    return res.json({ success: true, plan });
  } catch (error) {
    console.error('Ошибка /api/passenger/plans/cancel:', error);
    if (error.code === 'PLAN_NOT_FOUND') return res.status(400).json({ error: 'Запланированная поездка не найдена' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Нет прав на отмену этой поездки' });
    if (error.code === 'BAD_STATUS') return res.status(400).json({ error: 'Эту поездку уже нельзя отменить' });
    if (error.code === 'TOO_LATE') return res.status(400).json({ error: 'Нельзя отменить поездку после желаемого времени' });
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/driver/passenger-plans', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });

    const plans = await getActivePassengerPlans(100);
    const cutoff = Date.now() - 60 * 60 * 1000;
    const filtered = plans.filter((plan) => {
      const ts = Date.parse(plan.desired_time);
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });

    return res.json({ plans: filtered });
  } catch (error) {
    console.error('Ошибка /api/driver/passenger-plans:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/driver/taken-plans', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });

    const plans = await getDriverTakenPassengerPlansByTelegramId(telegram_id);
    return res.json({ plans });
  } catch (error) {
    console.error('Ошибка /api/driver/taken-plans:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/driver/passenger-plans/take', async (req, res) => {
  try {
    const { telegram_id, plan_id } = req.body;
    if (!telegram_id || !plan_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или plan_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) return res.status(400).json({ error: 'Водитель не найден' });
    if (driver.is_blocked) return res.status(403).json({ error: 'Ваш профиль заблокирован владельцем сервиса.' });

    const plan = await takePassengerPlan({ planId: Number(plan_id), driverId: driver.id });

    if (plan?.passenger_telegram_id) {
      const driverName = `${plan.driver_first_name || ''} ${plan.driver_last_name || ''}`.trim();
      const driverUsername = plan.driver_username ? `@${plan.driver_username}` : '';
      const carParts = [plan.driver_car_color, plan.driver_car_make].filter(Boolean).join(' ');
      const carText = plan.driver_car_plate ? `${carParts} (${plan.driver_car_plate})`.trim() : carParts;
      const message =
        'Ваша заявка взята водителем в "попутчики":\n\n' +
        `Маршрут: ${plan.from_city} → ${plan.to_city}\n` +
        `Время: ${plan.desired_time}\n` +
        `Водитель: ${(driverName || 'без имени').trim()} ${driverUsername}` +
        (carText ? `\nАвто: ${carText}` : '');
      await sendMessageSafe(plan.passenger_telegram_id, message, webAppOpenKeyboard('Открыть заявку', `plan_${plan.id}`));
    }

    return res.json({ success: true, plan });
  } catch (error) {
    console.error('Ошибка /api/driver/passenger-plans/take:', error);
    if (error.code === 'PLAN_NOT_FOUND') return res.status(400).json({ error: 'Запланированная поездка не найдена' });
    if (error.code === 'PLAN_ALREADY_TAKEN') return res.status(400).json({ error: error.message || 'Эту поездку уже забрал другой водитель' });
    if (error.code === 'TOO_LATE') return res.status(400).json({ error: 'Слишком поздно брать эту поездку' });
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

async function getRideParticipants(contextType, contextId) {
  if (contextType === 'plan') {
    return dbGet(
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
  }

  if (contextType === 'booking') {
    return dbGet(
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
  }

  return null;
}

app.get('/api/rides/confirmation', async (req, res) => {
  try {
    const { telegram_id, context_type, context_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Нет context_type/context_id' });

    const me = await getUserByTelegramId(telegram_id);
    if (!me) return res.status(400).json({ error: 'Пользователь не найден' });

    const confirmation = await dbGet(
      `SELECT * FROM ride_confirmations WHERE context_type = ? AND context_id = ?`,
      [String(context_type), Number(context_id)]
    );

    const alreadyReviewed = await dbGet(
      `SELECT 1 AS ok FROM reviews WHERE context_type = ? AND context_id = ? AND from_user_id = ?`,
      [String(context_type), Number(context_id), me.id]
    );

    return res.json({
      confirmation: confirmation || null,
      completed: !!(confirmation && confirmation.driver_confirmed_at && confirmation.passenger_confirmed_at),
      already_reviewed: !!alreadyReviewed,
    });
  } catch (error) {
    console.error('Ошибка /api/rides/confirmation:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/rides/confirm', async (req, res) => {
  try {
    const { telegram_id, context_type, context_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Нет context_type/context_id' });

    const me = await getUserByTelegramId(telegram_id);
    if (!me) return res.status(400).json({ error: 'Пользователь не найден' });

    const participants = await getRideParticipants(String(context_type), Number(context_id));
    if (!participants) return res.status(400).json({ error: 'Поездка не найдена' });

    let role = null;
    if (participants.driver_id && me.id === participants.driver_id) role = 'driver';
    if (participants.passenger_id && me.id === participants.passenger_id) role = 'passenger';
    if (!role) return res.status(403).json({ error: 'Нет прав' });

    if (String(context_type) === 'plan' && participants.status !== 'taken') {
      return res.status(400).json({ error: 'План ещё не взят водителем' });
    }
    if (String(context_type) === 'booking' && (participants.status === 'cancelled' || participants.status === 'no_show')) {
      return res.status(400).json({ error: 'Эту бронь нельзя подтвердить' });
    }

    await dbRun(
      `
        INSERT INTO ride_confirmations (context_type, context_id)
        VALUES (?, ?)
        ON CONFLICT(context_type, context_id) DO NOTHING
      `,
      [String(context_type), Number(context_id)]
    );

    if (role === 'driver') {
      await dbRun(
        `
          UPDATE ride_confirmations
          SET driver_confirmed_at = COALESCE(driver_confirmed_at, datetime('now','localtime'))
          WHERE context_type = ? AND context_id = ?
        `,
        [String(context_type), Number(context_id)]
      );
    } else {
      await dbRun(
        `
          UPDATE ride_confirmations
          SET passenger_confirmed_at = COALESCE(passenger_confirmed_at, datetime('now','localtime'))
          WHERE context_type = ? AND context_id = ?
        `,
        [String(context_type), Number(context_id)]
      );
    }

    const confirmation = await dbGet(
      `SELECT * FROM ride_confirmations WHERE context_type = ? AND context_id = ?`,
      [String(context_type), Number(context_id)]
    );

    return res.json({
      success: true,
      confirmation,
      completed: !!(confirmation && confirmation.driver_confirmed_at && confirmation.passenger_confirmed_at),
    });
  } catch (error) {
    console.error('Ошибка /api/rides/confirm:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/rides/review', async (req, res) => {
  try {
    const { telegram_id, context_type, context_id, rating, tags, comment } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Нет context_type/context_id' });

    const numericRating = Number(rating);
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: 'Рейтинг должен быть от 1 до 5' });
    }

    const me = await getUserByTelegramId(telegram_id);
    if (!me) return res.status(400).json({ error: 'Пользователь не найден' });

    const confirmation = await dbGet(
      `SELECT * FROM ride_confirmations WHERE context_type = ? AND context_id = ?`,
      [String(context_type), Number(context_id)]
    );
    if (!(confirmation && confirmation.driver_confirmed_at && confirmation.passenger_confirmed_at)) {
      return res.status(400).json({ error: 'Сначала подтвердите поездку с двух сторон' });
    }

    const participants = await getRideParticipants(String(context_type), Number(context_id));
    if (!participants) return res.status(400).json({ error: 'Поездка не найдена' });

    let toUserId = null;
    if (participants.driver_id && me.id === participants.passenger_id) toUserId = participants.driver_id;
    if (participants.passenger_id && me.id === participants.driver_id) toUserId = participants.passenger_id;
    if (!toUserId) return res.status(403).json({ error: 'Нет прав' });

    try {
      await dbRun(
        `
          INSERT INTO reviews (context_type, context_id, from_user_id, to_user_id, rating, tags, comment)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          String(context_type),
          Number(context_id),
          me.id,
          toUserId,
          numericRating,
          Array.isArray(tags) ? JSON.stringify(tags.slice(0, 8)) : null,
          comment ? String(comment).slice(0, 600) : null,
        ]
      );
    } catch (error) {
      const msg = String(error?.message || '');
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        return res.status(400).json({ error: 'Вы уже оставляли отзыв по этой поездке' });
      }
      throw error;
    }

    await dbRun(
      `
        UPDATE users
        SET rating_sum = COALESCE(rating_sum, 0) + ?,
            rating_count = COALESCE(rating_count, 0) + 1,
            rating_avg = (COALESCE(rating_sum, 0) + ?) * 1.0 / (COALESCE(rating_count, 0) + 1)
        WHERE id = ?
      `,
      [numericRating, numericRating, toUserId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка /api/rides/review:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});
app.get('/api/owner/overview', async (req, res) => {
  try {
    if (!ensureOwnerAccess(req, res)) return;

    const [stats, recentTrips, recentPlans] = await Promise.all([
      getOwnerDashboardStats(),
      getOwnerRecentTrips(8),
      getOwnerRecentPassengerPlans(8),
    ]);

    return res.json({ stats, recent_trips: recentTrips, recent_plans: recentPlans });
  } catch (error) {
    console.error('Ошибка /api/owner/overview:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/owner/drivers', async (req, res) => {
  try {
    if (!ensureOwnerAccess(req, res)) return;

    const date = req.query.date ? String(req.query.date) : undefined;
    const drivers = await getOwnerDriverActivity(date);
    return res.json({ drivers });
  } catch (error) {
    console.error('Ошибка /api/owner/drivers:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/owner/block-driver', async (req, res) => {
  try {
    if (!ensureOwnerAccess(req, res)) return;

    const { driver_telegram_id, block } = req.body;
    if (!driver_telegram_id) {
      return res.status(400).json({ error: 'Не указан driver_telegram_id' });
    }

    await setUserBlockedByTelegramId(driver_telegram_id, !!block);
    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка /api/owner/block-driver:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

if (!DISABLE_BOT) {
  bot.launch().then(() => {
    console.log('Бот запущен');
  });
} else {
  console.log('Бот не запущен (DISABLE_BOT=1)');
}

app.listen(PORT, () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
