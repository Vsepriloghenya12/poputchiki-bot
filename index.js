
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Telegraf } = require('telegraf');
const webpush = require('web-push');

const {
  dbRun,
  dbGet,
  dbAll,
  upsertUserFromTelegram,
  createStandaloneUser,
  authenticateStandaloneUser,
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
  savePushSubscription,
  getPushSubscriptionsByUserIds,
  deletePushSubscriptionByEndpoint,
  deletePushSubscription,
  registerAutopostChat,
  deactivateAutopostChat,
  getActiveAutopostChats,
  getAppSettings,
  setAppSettings,
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = String(process.env.WEBAPP_URL || '').trim();
const PORT = Number(process.env.PORT || 3000);
const OWNER_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '504348666';
const OWNER_PANEL_PASSWORD = (process.env.OWNER_PANEL_PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
const OWNER_SESSION_SECRET = (process.env.OWNER_SESSION_SECRET || process.env.SESSION_SECRET || BOT_TOKEN || 'owner-session-secret').trim();
const OWNER_SESSION_COOKIE = 'poputchiki_owner_session';
const OWNER_SESSION_TTL_MS = Math.max(1, Number(process.env.OWNER_SESSION_TTL_HOURS || 12)) * 60 * 60 * 1000;
const USER_SESSION_SECRET = (process.env.USER_SESSION_SECRET || process.env.SESSION_SECRET || OWNER_SESSION_SECRET || BOT_TOKEN || 'user-session-secret').trim();
const USER_SESSION_COOKIE = 'poputchiki_user_session';
const USER_SESSION_TTL_MS = Math.max(1, Number(process.env.USER_SESSION_TTL_DAYS || 180)) * 24 * 60 * 60 * 1000;

function readEnvValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

const WEB_PUSH_PUBLIC_KEY = readEnvValue('WEB_PUSH_PUBLIC_KEY', 'VAPID_PUBLIC_KEY', 'PUBLIC_VAPID_KEY');
const WEB_PUSH_PRIVATE_KEY = readEnvValue('WEB_PUSH_PRIVATE_KEY', 'VAPID_PRIVATE_KEY', 'PRIVATE_VAPID_KEY');
const WEB_PUSH_SUBJECT = readEnvValue('WEB_PUSH_SUBJECT', 'VAPID_SUBJECT') || 'mailto:admin@example.com';
const DISABLE_BOT = process.env.DISABLE_BOT === '1';

function parseTelegramChatTargets(rawValue) {
  return [...new Set(
    String(rawValue || '')
      .split(/[,\n;]/)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

const PUBLIC_CHANNEL = (process.env.PUBLIC_CHANNEL || '').trim();
const PUBLIC_CHANNELS = parseTelegramChatTargets(process.env.PUBLIC_CHANNELS || PUBLIC_CHANNEL);
const AUTOPOST_ENABLED = process.env.AUTOPOST_ENABLED !== '0';
const AUTOPOST_TRIPS = process.env.AUTOPOST_TRIPS !== '0';
const AUTOPOST_PLANS = process.env.AUTOPOST_PLANS !== '0';
const CHANNEL_BRAND = (process.env.CHANNEL_BRAND || 'Попутчики').trim();
const PUSH_ENABLED = !!(WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY);
const PUSH_MISSING_ENV = [
  ...(!WEB_PUSH_PUBLIC_KEY ? ['WEB_PUSH_PUBLIC_KEY или VAPID_PUBLIC_KEY'] : []),
  ...(!WEB_PUSH_PRIVATE_KEY ? ['WEB_PUSH_PRIVATE_KEY или VAPID_PRIVATE_KEY'] : []),
];
const TELEGRAM_LOGIN_TTL_MS = Math.max(1, Number(process.env.TELEGRAM_LOGIN_TTL_MINUTES || 15)) * 60 * 1000;
const telegramLoginStore = new Map();
let lastKnownPublicOrigin = '';

if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в .env или переменных окружения');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
let BOT_USERNAME_RUNTIME = (process.env.BOT_USERNAME || '').replace('@', '').trim();
const WEBAPP_SHORTNAME = (process.env.WEBAPP_SHORTNAME || '').trim();
const SUPPORT_URL = (process.env.SUPPORT_URL || '').trim();
const SUPPORT_LABEL = (process.env.SUPPORT_LABEL || 'Поддержка').trim() || 'Поддержка';
const SUPPORT_TEXT = (process.env.SUPPORT_TEXT || 'Если что-то не работает или нужен ответ по поездке, напишите в поддержку сервиса.').trim();

if (PUSH_ENABLED) {
  webpush.setVapidDetails(WEB_PUSH_SUBJECT, WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY);
} else {
  console.warn(`Push-уведомления выключены: не заданы ${PUSH_MISSING_ENV.join(', ')}`);
}

async function sendMessageSafe(telegramId, text, extra = undefined) {
  try {
    if (!telegramId || !/^-?\d+$/.test(String(telegramId).trim())) return;
    await bot.telegram.sendMessage(String(telegramId), String(text).slice(0, 3500), extra);
  } catch (error) {
    console.warn('sendMessageSafe error:', error?.message || error);
  }
}

const SUPPORT_SETTING_KEYS = ['support_label', 'support_url', 'support_text'];

function isSupportedContactUrl(value) {
  const contact = String(value || '').trim();
  if (!contact) return true;
  return /^(https?:\/\/|tg:\/\/|mailto:|tel:)/i.test(contact);
}

function normalizeSupportUrl(value) {
  const contact = String(value || '').trim();
  if (!contact) return '';
  const telegramUsername = contact.match(/^@([a-zA-Z][a-zA-Z0-9_]{4,31})$/);
  if (telegramUsername) return `https://t.me/${telegramUsername[1]}`;
  if (/^t\.me\/[a-zA-Z][a-zA-Z0-9_]{4,31}(?:[/?#].*)?$/i.test(contact)) return `https://${contact}`;
  return contact;
}

function isGenericTelegramPlaceholder(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'telegram.org' || (host === 't.me' && !parsed.pathname.replace(/\//g, '').trim());
  } catch (_) {
    return false;
  }
}

async function getSupportSettings() {
  const storedSettings = await getAppSettings(SUPPORT_SETTING_KEYS).catch(() => ({}));
  const hasStoredUrl = Object.prototype.hasOwnProperty.call(storedSettings, 'support_url');
  const hasStoredText = Object.prototype.hasOwnProperty.call(storedSettings, 'support_text');
  const label = String(storedSettings.support_label || SUPPORT_LABEL || 'Поддержка').trim() || 'Поддержка';
  const text = String(hasStoredText ? storedSettings.support_text : SUPPORT_TEXT || '').trim();
  const configuredUrl = normalizeSupportUrl(hasStoredUrl ? (storedSettings.support_url || '') : SUPPORT_URL);
  const supportUrl = isGenericTelegramPlaceholder(configuredUrl) ? '' : configuredUrl;

  return {
    enabled: !!(supportUrl || text),
    label,
    text,
    url: supportUrl || null,
  };
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '0.0.0.0' || normalized === '::1';
}

function getRequestOrigin(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req?.protocol || 'http');
  const host = req?.get ? req.get('host') : req?.headers?.host;
  return `${protocol}://${host}`;
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return '';
  }
}

function rememberPublicOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    if (isLoopbackHostname(parsed.hostname)) return '';
    lastKnownPublicOrigin = normalized.replace(/\/$/, '');
    return lastKnownPublicOrigin;
  } catch (_) {
    return '';
  }
}

function getPublicOriginFromRequest(req) {
  return rememberPublicOrigin(getRequestOrigin(req));
}

function resolveWebAppBaseUrl(req = null) {
  const configuredUrl = WEBAPP_URL;

  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl);
      if (req && isLoopbackHostname(parsed.hostname)) {
        return getPublicOriginFromRequest(req) || getRequestOrigin(req);
      }
      if (isLoopbackHostname(parsed.hostname) && lastKnownPublicOrigin) return lastKnownPublicOrigin;
      if (isLoopbackHostname(parsed.hostname)) {
        return `${parsed.protocol}//localhost:${PORT}`;
      }
      return rememberPublicOrigin(parsed.toString()) || parsed.toString().replace(/\/$/, '');
    } catch (_) {}
  }

  if (req) return getPublicOriginFromRequest(req) || getRequestOrigin(req);
  if (lastKnownPublicOrigin) return lastKnownPublicOrigin;
  return `http://localhost:${PORT}`;
}

function buildWebAppUrl(startParam = '', req = null) {
  return withStartParamUrl(resolveWebAppBaseUrl(req), startParam);
}

function buildResolvedWebAppUrl(req, startParam = '') {
  return withStartParamUrl(resolveWebAppBaseUrl(req), startParam);
}

function cleanupTelegramLoginStore() {
  const now = Date.now();
  for (const [token, entry] of telegramLoginStore.entries()) {
    if (!entry || Number(entry.exp || 0) < now) {
      telegramLoginStore.delete(token);
    }
  }
}

function createTelegramLoginToken() {
  cleanupTelegramLoginStore();
  const token = crypto.randomBytes(18).toString('base64url');
  telegramLoginStore.set(token, {
    status: 'pending',
    telegram_id: '',
    exp: Date.now() + TELEGRAM_LOGIN_TTL_MS,
  });
  return token;
}

function getTelegramLoginTokenState(token) {
  cleanupTelegramLoginStore();
  const entry = telegramLoginStore.get(String(token || ''));
  if (!entry) return null;
  return entry;
}

function approveTelegramLoginToken(token, telegramId) {
  cleanupTelegramLoginStore();
  const entry = telegramLoginStore.get(String(token || ''));
  if (!entry || Number(entry.exp || 0) < Date.now()) {
    telegramLoginStore.delete(String(token || ''));
    return null;
  }

  entry.status = 'approved';
  entry.telegram_id = String(telegramId || '');
  entry.exp = Date.now() + Math.min(TELEGRAM_LOGIN_TTL_MS, 5 * 60 * 1000);
  telegramLoginStore.set(String(token || ''), entry);
  return entry;
}

function clearTelegramLoginToken(token) {
  telegramLoginStore.delete(String(token || ''));
}

async function sendPushPayloadToUserIds(userIds, payload) {
  if (!PUSH_ENABLED || !Array.isArray(userIds) || !userIds.length || !payload) return;

  const ids = [...new Set(userIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
  if (!ids.length) return;

  try {
    const subscriptions = await getPushSubscriptionsByUserIds(ids);
    if (!subscriptions.length) return;

    await Promise.allSettled(
      subscriptions.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify(payload));
        } catch (error) {
          const statusCode = Number(error?.statusCode || 0);
          if (statusCode === 404 || statusCode === 410) {
            await deletePushSubscriptionByEndpoint(row.endpoint).catch(() => {});
            return;
          }
          console.warn('push send error:', error?.message || error);
        }
      })
    );
  } catch (error) {
    console.warn('push broadcast error:', error?.message || error);
  }
}

function withStartParamUrl(baseUrl, startParam) {
  const value = String(startParam || '').trim();
  if (!value) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}startapp=${encodeURIComponent(value)}`;
}

function buildDeeplinkPrefix(req = null) {
  const username = (BOT_USERNAME_RUNTIME || '').replace('@', '').trim();
  if (username && WEBAPP_SHORTNAME) {
    return `https://t.me/${username}/${WEBAPP_SHORTNAME}?startapp=`;
  }
  if (username) {
    return `https://t.me/${username}?startapp=`;
  }
  const fallbackUrl = resolveWebAppBaseUrl(req);
  const separator = fallbackUrl.includes('?') ? '&' : '?';
  return `${fallbackUrl}${separator}startapp=`;
}

function buildDeeplink(startParam, req = null) {
  return buildDeeplinkPrefix(req) + encodeURIComponent(String(startParam || '').trim());
}

async function getBotUsernameRuntime() {
  if (BOT_USERNAME_RUNTIME) return BOT_USERNAME_RUNTIME;
  if (DISABLE_BOT) return '';

  try {
    const me = await bot.telegram.getMe();
    if (me?.username) {
      BOT_USERNAME_RUNTIME = String(me.username).replace('@', '').trim();
    }
  } catch (error) {
    console.warn('getBotUsernameRuntime error:', error?.message || error);
  }

  return BOT_USERNAME_RUNTIME;
}

function getStartPayloadFromContext(ctx) {
  const directPayload = String(ctx?.startPayload || '').trim();
  if (directPayload) return directPayload;

  const messageText = String(ctx?.message?.text || '').trim();
  const match = messageText.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  return String(match?.[1] || '').trim();
}

async function handleTelegramStandaloneLogin(ctx, token) {
  if (!token) {
    return ctx.reply('Ссылка для входа не распознана. Вернитесь в приложение и нажмите «Войти через Telegram» ещё раз.');
  }

  const approved = approveTelegramLoginToken(token, ctx.from?.id);
  if (!approved?.telegram_id) {
    return ctx.reply('Ссылка для входа устарела. Вернитесь в приложение и запросите вход ещё раз.');
  }

  await upsertUserFromTelegram(ctx.from);
  return ctx.reply(
    'Вход подтверждён. Вернитесь в установленное приложение «Попутчики» — оно продолжит вход автоматически.',
    webAppOpenKeyboard('Открыть попутчики')
  );
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

function signSessionPayload(secret, encodedPayload) {
  return crypto.createHmac('sha256', String(secret || '')).update(String(encodedPayload || ''), 'utf8').digest('base64url');
}

function signOwnerSessionPayload(encodedPayload) {
  return signSessionPayload(OWNER_SESSION_SECRET, encodedPayload);
}

function signUserSessionPayload(encodedPayload) {
  return signSessionPayload(USER_SESSION_SECRET, encodedPayload);
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

function hasValidUserSessionToken(token) {
  if (!token || !String(token).includes('.')) return false;

  const [encodedPayload, signature] = String(token).split('.');
  const expectedSignature = signUserSessionPayload(encodedPayload);
  if (!signature || !isSameSecret(signature, expectedSignature)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    return !!(payload && payload.role === 'user' && payload.telegram_id && payload.exp && Number(payload.exp) >= Date.now());
  } catch (_) {
    return false;
  }
}

function parseUserSessionToken(token) {
  if (!hasValidUserSessionToken(token)) return null;

  try {
    const [encodedPayload] = String(token).split('.');
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function hasOwnerSessionFromRequest(req) {
  const token = parseCookiesFromHeader(req?.headers?.cookie)[OWNER_SESSION_COOKIE];
  return hasValidOwnerSessionToken(token);
}

function webAppOpenKeyboard(label = 'Открыть мини-приложение', startParam = '', req = null) {
  const url = withStartParamUrl(resolveWebAppBaseUrl(req), startParam);
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

async function getAutopostTargets() {
  const dbChats = await getActiveAutopostChats().catch(() => []);
  const combinedTargets = [...new Set([
    ...dbChats.map((row) => String(row.chat_id || '').trim()).filter(Boolean),
    ...PUBLIC_CHANNELS,
  ])];

  return {
    dbChats,
    targets: combinedTargets,
  };
}

function isRegisterableChat(ctx) {
  return ctx?.chat?.type === 'group' || ctx?.chat?.type === 'supergroup' || ctx?.chat?.type === 'channel';
}

function formatChatName(chat) {
  const title = String(chat?.title || '').trim();
  if (title) return title;
  const username = String(chat?.username || '').trim().replace(/^@/, '');
  if (username) return `@${username}`;
  return String(chat?.id || 'эта группа');
}

async function isChatAdmin(ctx) {
  const chatId = ctx?.chat?.id;
  const userId = ctx?.from?.id;
  if (ctx?.chat?.type === 'channel' && !userId) {
    return true;
  }
  if (!chatId || !userId) return false;

  try {
    const member = await ctx.getChatMember(userId);
    return member?.status === 'creator' || member?.status === 'administrator';
  } catch (error) {
    console.warn('isChatAdmin error:', error?.message || error);
    return false;
  }
}

async function handleSetChannel(ctx) {
  if (!isRegisterableChat(ctx)) {
    return ctx.reply('Эту команду нужно отправлять прямо в той группе или канале, куда бот должен публиковать поездки и заявки.');
  }

  const isAdmin = await isChatAdmin(ctx);
  if (!isAdmin) {
    return ctx.reply('Подключать группу или канал может только администратор.');
  }

  const saved = await registerAutopostChat({
    chatId: ctx.chat.id,
    title: ctx.chat.title,
    type: ctx.chat.type,
    username: ctx.chat.username,
    addedByTelegramId: ctx.from?.id,
  });

  return ctx.reply(
    `Чат «${formatChatName(saved || ctx.chat)}» подключён.\nТеперь бот будет публиковать сюда новые поездки и заявки пассажиров.`
  );
}

async function handleUnsetChannel(ctx) {
  if (!isRegisterableChat(ctx)) {
    return ctx.reply('Эту команду нужно отправлять прямо в группе или канале, который нужно отключить.');
  }

  const isAdmin = await isChatAdmin(ctx);
  if (!isAdmin) {
    return ctx.reply('Отключать группу или канал может только администратор.');
  }

  await deactivateAutopostChat(ctx.chat.id);
  return ctx.reply(`Чат «${formatChatName(ctx.chat)}» отключён от автопубликации.`);
}

function extractCommandText(ctx) {
  const text = String(ctx?.message?.text || ctx?.channelPost?.text || ctx?.update?.channel_post?.text || '').trim();
  return text;
}

function matchBotCommand(ctx, commandName) {
  const text = extractCommandText(ctx);
  if (!text) return false;

  const escaped = String(commandName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const username = String(BOT_USERNAME_RUNTIME || '').replace(/^@/, '').trim();
  const pattern = username
    ? new RegExp(`^/${escaped}(?:@${username})?(?:\\s|$)`, 'i')
    : new RegExp(`^/${escaped}(?:@\\w+)?(?:\\s|$)`, 'i');

  return pattern.test(text);
}

async function handleChannelPostCommand(ctx) {
  if (!isRegisterableChat(ctx)) return;

  if (matchBotCommand(ctx, 'setchannel') || matchBotCommand(ctx, 'setchanel')) {
    await handleSetChannel(ctx);
    return;
  }

  if (matchBotCommand(ctx, 'unsetchannel')) {
    await handleUnsetChannel(ctx);
    return;
  }

  if (matchBotCommand(ctx, 'channels')) {
    await handleChannelsList(ctx);
  }
}

async function handleChannelsList(ctx) {
  const { dbChats, targets } = await getAutopostTargets();
  if (!targets.length) {
    return ctx.reply('Пока не подключено ни одной группы для автопубликации.');
  }

  const fromDb = new Set(dbChats.map((row) => String(row.chat_id)));
  const lines = targets.map((target, index) => {
    const chat = dbChats.find((row) => String(row.chat_id) === String(target));
    const label = chat ? formatChatName(chat) : String(target);
    const source = fromDb.has(String(target)) ? 'подключена командой' : 'из переменных окружения';
    return `${index + 1}. ${label} — ${source}`;
  });

  return ctx.reply(`Подключённые группы для автопоста:\n\n${lines.join('\n')}`);
}

async function sendToChannelsSafe(html, keyboardExtra) {
  const { targets } = await getAutopostTargets();
  if (!targets.length || !AUTOPOST_ENABLED) return;

  await Promise.allSettled(
    targets.map(async (target) => {
      try {
        await bot.telegram.sendMessage(target, html, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(keyboardExtra || {}),
        });
      } catch (error) {
        console.warn(`channel autopost error for ${target}:`, error?.message || error);
      }
    })
  );
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

async function autopostTripToChannel(trip, req = null) {
  if (!AUTOPOST_TRIPS || !trip) return;
  const html = buildTripPostHtml(trip);
  const openUrl = buildDeeplink(`trip_${trip.id}`, req);
  await sendToChannelsSafe(html, channelKeyboard(openUrl));
}

async function autopostPlanToChannel(plan, req = null) {
  if (!AUTOPOST_PLANS || !plan) return;
  const html = buildPlanPostHtml(plan);
  const openUrl = buildDeeplink(`plan_${plan.id}`, req);
  await sendToChannelsSafe(html, channelKeyboard(openUrl));
}

const app = express();
app.set('trust proxy', true);
app.disable('etag');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  getPublicOriginFromRequest(req);
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

bot.start(async (ctx) => {
  const startPayload = getStartPayloadFromContext(ctx);
  const loginMatch = startPayload.match(/^login_([A-Za-z0-9_-]+)$/i);
  if (loginMatch) {
    return handleTelegramStandaloneLogin(ctx, loginMatch[1]);
  }

  const resolvedBaseUrl = resolveWebAppBaseUrl();
  if (resolvedBaseUrl.startsWith('http://localhost') || resolvedBaseUrl.startsWith('http://127.0.0.1')) {
    return ctx.reply(
      'Привет! Это бот "попутчики".\n' +
        'Сейчас бот запущен локально.\n\n' +
        'Мини-приложение можно открыть в браузере по адресу:\n' +
        resolvedBaseUrl
    );
  }

  return ctx.reply(
    'Привет! Нажмите кнопку ниже, чтобы открыть мини-приложение "попутчики".',
    webAppOpenKeyboard('Открыть попутчики')
  );
});

bot.command('setchannel', (ctx) => handleSetChannel(ctx).catch((error) => {
  console.warn('setchannel error:', error?.message || error);
  return ctx.reply('Не удалось подключить группу. Проверьте, что бот имеет доступ к этой группе.');
}));

bot.command('setchanel', (ctx) => handleSetChannel(ctx).catch((error) => {
  console.warn('setchanel error:', error?.message || error);
  return ctx.reply('Не удалось подключить группу. Проверьте, что бот имеет доступ к этой группе.');
}));

bot.command('unsetchannel', (ctx) => handleUnsetChannel(ctx).catch((error) => {
  console.warn('unsetchannel error:', error?.message || error);
  return ctx.reply('Не удалось отключить группу от автопубликации.');
}));

bot.command('channels', (ctx) => handleChannelsList(ctx).catch((error) => {
  console.warn('channels error:', error?.message || error);
  return ctx.reply('Не удалось получить список подключённых групп.');
}));

bot.on('channel_post', (ctx) => handleChannelPostCommand(ctx).catch((error) => {
  console.warn('channel_post command error:', error?.message || error);
}));

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

function applyTelegramIdentityToRequest(req, telegramId, telegramUser = null) {
  req.telegramId = String(telegramId || '');
  if (telegramUser) {
    req.telegramUser = telegramUser;
  }

  if (req.body && typeof req.body === 'object') {
    req.body.telegram_id = req.telegramId;
    if (!req.body.user && req.path === '/init-user' && telegramUser) req.body.user = telegramUser;
  }

  if (req.query && typeof req.query === 'object' && !req.query.telegram_id) {
    req.query.telegram_id = req.telegramId;
  }
}

app.use('/api', (req, res, next) => {
  const isOwnerApi = req.path === '/owner/login' || req.path === '/owner/logout' || req.path === '/owner/session' || req.path.startsWith('/owner/');
  const isPublicApi =
    req.path === '/session' ||
    req.path === '/session/logout' ||
    req.path === '/app-config' ||
    req.path === '/push/public-key' ||
    req.path === '/auth/register' ||
    req.path === '/auth/login' ||
    req.path === '/auth/telegram/start' ||
    req.path === '/auth/telegram/status';
  if (isPublicApi) return next();

  if (isOwnerApi && (hasOwnerSessionFromRequest(req) || req.path === '/owner/login' || req.path === '/owner/session' || req.path === '/owner/logout')) {
    return next();
  }

  const userSession = getUserSessionData(req);
  if (userSession?.telegram_id) {
    applyTelegramIdentityToRequest(req, userSession.telegram_id, userSession.user || null);
    return next();
  }

  const initData =
    req.headers['x-telegram-init-data'] ||
    req.headers['x-telegram-initdata'] ||
    (req.body && req.body.initData) ||
    (req.query && req.query.initData);

  if (!initData) {
    if (!REQUIRE_INIT_DATA) return next();
    return res.status(401).json({ error: 'Нет активной сессии. Войдите или зарегистрируйтесь в приложении.' });
  }

  const validation = validateTelegramInitData(String(initData), BOT_TOKEN, INIT_DATA_MAX_AGE_SEC);
  if (!validation.ok || !validation.user || !validation.user.id) {
    if (!REQUIRE_INIT_DATA) return next();
    return res.status(401).json({ error: 'initData не прошёл проверку' });
  }

  applyTelegramIdentityToRequest(req, validation.user.id, validation.user);
  next();
});

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/owner' || req.path.endsWith('.html') || req.path === '/sw.js' || req.path === '/manifest.webmanifest')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.get('/handoff', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  return res.redirect('/?install=guide');
});

app.get('/launch', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  return res.redirect('/?standalone=1');
});

app.get('/manifest.webmanifest', (req, res) => {
  const startUrl = '/?standalone=1';

  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  return res.json({
    name: 'Попутчики',
    short_name: 'Попутчики',
    id: '/',
    description: 'Поиск поездок водителей и заявок пассажиров',
    start_url: startUrl,
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: '#e8eef8',
    theme_color: '#1f66d6',
    lang: 'ru',
    icons: [
      {
        src: '/assets/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/assets/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/assets/icons/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  });
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

function createUserSessionToken(telegramId) {
  const payload = Buffer.from(
    JSON.stringify({
      role: 'user',
      telegram_id: String(telegramId || ''),
      exp: Date.now() + USER_SESSION_TTL_MS,
    }),
    'utf8'
  ).toString('base64url');

  return `${payload}.${signUserSessionPayload(payload)}`;
}

function getUserSessionData(req) {
  const token = parseCookies(req)[USER_SESSION_COOKIE];
  return parseUserSessionToken(token);
}

function hasUserSession(req) {
  return !!getUserSessionData(req);
}

function setUserSessionCookie(req, res, telegramId) {
  res.cookie(USER_SESSION_COOKIE, createUserSessionToken(telegramId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureOwnerCookie(req),
    path: '/',
    maxAge: USER_SESSION_TTL_MS,
  });
}

function clearUserSessionCookie(req, res) {
  res.cookie(USER_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureOwnerCookie(req),
    path: '/',
    maxAge: 0,
  });
}

function presentUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    telegram_id: user.telegram_id,
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    username: user.username || '',
    language_code: user.language_code || '',
    no_show_count: Number(user.no_show_count || 0),
    car_make: user.car_make || '',
    car_color: user.car_color || '',
    car_plate: user.car_plate || '',
    is_blocked: Number(user.is_blocked || 0),
    auth_provider: user.auth_provider || 'telegram',
    contact_phone: user.contact_phone || '',
    rating_sum: Number(user.rating_sum || 0),
    rating_count: Number(user.rating_count || 0),
    rating_avg: Number(user.rating_avg || 0),
  };
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

app.get('/api/session', async (req, res) => {
  try {
    const session = getUserSessionData(req);
    if (!session?.telegram_id) {
      return res.json({
        authenticated: false,
        user: null,
        is_owner: false,
        push_enabled: PUSH_ENABLED,
      });
    }

    const user = await getUserByTelegramId(session.telegram_id);
    if (!user) {
      clearUserSessionCookie(req, res);
      return res.json({
        authenticated: false,
        user: null,
        is_owner: false,
        push_enabled: PUSH_ENABLED,
      });
    }

    return res.json({
      authenticated: true,
      user: presentUser(user),
      is_owner: isOwnerTelegramId(user.telegram_id),
      push_enabled: PUSH_ENABLED,
    });
  } catch (error) {
    console.error('Ошибка /api/session:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/session/logout', (req, res) => {
  clearUserSessionCookie(req, res);
  return res.json({ success: true });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const user = await createStandaloneUser({
      firstName: req.body.first_name,
      lastName: req.body.last_name,
      username: req.body.username,
      phone: req.body.phone,
      password: req.body.password,
    });

    setUserSessionCookie(req, res, user.telegram_id);
    return res.json({
      authenticated: true,
      user: presentUser(user),
      is_owner: isOwnerTelegramId(user.telegram_id),
      push_enabled: PUSH_ENABLED,
    });
  } catch (error) {
    if (error.code === 'BAD_INPUT' || error.code === 'PHONE_EXISTS' || error.code === 'USERNAME_EXISTS') {
      return res.status(400).json({ error: error.message });
    }

    console.error('Ошибка /api/auth/register:', error);
    return res.status(500).json({ error: 'Не удалось создать аккаунт' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    if (!phone || !password) {
      return res.status(400).json({ error: 'Введите номер телефона и пароль' });
    }

    const user = await authenticateStandaloneUser({ phone, password });
    if (!user) {
      return res.status(401).json({ error: 'Неверный номер телефона или пароль' });
    }

    if (Number(user.is_blocked || 0)) {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован владельцем сервиса.' });
    }

    setUserSessionCookie(req, res, user.telegram_id);
    return res.json({
      authenticated: true,
      user: presentUser(user),
      is_owner: isOwnerTelegramId(user.telegram_id),
      push_enabled: PUSH_ENABLED,
    });
  } catch (error) {
    console.error('Ошибка /api/auth/login:', error);
    return res.status(500).json({ error: 'Не удалось выполнить вход' });
  }
});

app.post('/api/session/handoff', async (req, res) => {
  try {
    const url = `${resolveWebAppBaseUrl(req)}/?install=guide`;

    return res.json({ success: true, url });
  } catch (error) {
    console.error('Ошибка /api/session/handoff:', error);
    return res.status(500).json({ error: 'Не удалось подготовить переход в браузер' });
  }
});

app.post('/api/auth/telegram/start', async (req, res) => {
  try {
    const botUsername = await getBotUsernameRuntime();
    if (!botUsername) {
      return res.status(503).json({ error: 'Telegram-бот сейчас недоступен. Попробуйте ещё раз чуть позже.' });
    }

    const token = createTelegramLoginToken();
    const url = `https://t.me/${botUsername}?start=${encodeURIComponent(`login_${token}`)}`;

    return res.json({
      success: true,
      token,
      url,
      expires_in_seconds: Math.round(TELEGRAM_LOGIN_TTL_MS / 1000),
    });
  } catch (error) {
    console.error('Ошибка /api/auth/telegram/start:', error);
    return res.status(500).json({ error: 'Не удалось подготовить вход через Telegram' });
  }
});

app.get('/api/auth/telegram/status', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'Не передан токен входа' });
    }

    const authState = getTelegramLoginTokenState(token);
    if (!authState) {
      return res.json({ status: 'expired' });
    }

    if (authState.status !== 'approved' || !authState.telegram_id) {
      return res.json({ status: 'pending' });
    }

    const user = await getUserByTelegramId(authState.telegram_id);
    if (!user) {
      clearTelegramLoginToken(token);
      return res.json({ status: 'expired' });
    }

    setUserSessionCookie(req, res, user.telegram_id);
    clearTelegramLoginToken(token);

    return res.json({
      status: 'approved',
      user: presentUser(user),
      is_owner: isOwnerTelegramId(user.telegram_id),
      push_enabled: PUSH_ENABLED,
    });
  } catch (error) {
    console.error('Ошибка /api/auth/telegram/status:', error);
    return res.status(500).json({ error: 'Не удалось проверить вход через Telegram' });
  }
});

app.post('/api/init-user', async (req, res) => {
  try {
    const user = req.body.user || req.telegramUser;
    if (!user || !user.id) {
      return res.status(400).json({ error: 'Некорректный объект user' });
    }

    const dbUser = await upsertUserFromTelegram(user);
    setUserSessionCookie(req, res, dbUser.telegram_id);
    return res.json({
      user: presentUser(dbUser),
      is_owner: isOwnerTelegramId(dbUser.telegram_id),
      standalone_enabled: true,
      push_enabled: PUSH_ENABLED,
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

    const autopostTargets = await getAutopostTargets();
    const support = await getSupportSettings();

    return res.json({
      deeplink_prefix: buildDeeplinkPrefix(req),
      bot_username: BOT_USERNAME_RUNTIME || null,
      webapp_shortname: WEBAPP_SHORTNAME || null,
      owner_telegram_id: OWNER_TELEGRAM_ID,
      pwa: {
        enabled: true,
        start_url: `${resolveWebAppBaseUrl(req)}/?standalone=1`,
        install_url: `${resolveWebAppBaseUrl(req)}/?install=guide`,
      },
      support,
      push: {
        enabled: PUSH_ENABLED,
        missing: PUSH_ENABLED ? [] : PUSH_MISSING_ENV,
      },
      autopost: {
        enabled: !!(autopostTargets.targets.length && AUTOPOST_ENABLED),
        channel: autopostTargets.targets[0] || PUBLIC_CHANNEL || null,
        channels: autopostTargets.targets,
        registered_chats: autopostTargets.dbChats,
        brand: CHANNEL_BRAND,
      },
    });
  } catch (_) {
    return res.json({ deeplink_prefix: buildDeeplinkPrefix(req) });
  }
});

app.get('/api/push/public-key', (req, res) => {
  return res.json({
    enabled: PUSH_ENABLED,
    public_key: PUSH_ENABLED ? WEB_PUSH_PUBLIC_KEY : null,
    missing: PUSH_ENABLED ? [] : PUSH_MISSING_ENV,
  });
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    if (!PUSH_ENABLED) {
      return res.status(503).json({ error: 'Push-уведомления ещё не настроены на сервере' });
    }

    const telegramId = req.telegramId || req.body.telegram_id;
    if (!telegramId) {
      return res.status(401).json({ error: 'Сначала войдите или зарегистрируйтесь в приложении' });
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      return res.status(400).json({ error: 'Пользователь не найден. Войдите в приложение заново.' });
    }

    const subscription = req.body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Не передана push-подписка браузера' });
    }

    await savePushSubscription({
      userId: user.id,
      subscription,
      userAgent: req.headers['user-agent'] || '',
      platform: req.body.platform || '',
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка /api/push/subscribe:', error);
    return res.status(500).json({ error: 'Не удалось сохранить push-подписку' });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const telegramId = req.telegramId || req.body.telegram_id;
    if (!telegramId) {
      return res.json({ success: true });
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      return res.json({ success: true });
    }

    const endpoint = String(req.body.endpoint || '').trim();
    if (!endpoint) {
      return res.json({ success: true });
    }

    await deletePushSubscription({ userId: user.id, endpoint });
    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка /api/push/unsubscribe:', error);
    return res.status(500).json({ error: 'Не удалось удалить push-подписку' });
  }
});

app.post('/api/trips', async (req, res) => {
  try {
    const { telegram_id, from_city, to_city, departure_time, seats_total, price_per_seat, note } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Пользователь не найден. Войдите или зарегистрируйтесь в приложении.' });
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

    autopostTripToChannel(trip, req).catch((error) => console.warn('autopost trip error:', error?.message || error));

    try {
      const plans = await getActivePassengerPlans(120);
      const departureTs = Date.parse(departure_time);
      const timeWindow = 4 * 60 * 60 * 1000;
      const matchedPassengerIds = new Set();

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
        await sendMessageSafe(plan.passenger_telegram_id, message, webAppOpenKeyboard('Открыть поездку', `trip_${trip.id}`, req));
        if (plan.passenger_id) matchedPassengerIds.add(Number(plan.passenger_id));
      }

      await sendPushPayloadToUserIds([...matchedPassengerIds], {
        title: 'Найдена поездка по вашему маршруту',
        body: `${trip.from_city} → ${trip.to_city} · ${trip.departure_time}`,
        tag: `trip-match-${trip.id}`,
        url: buildWebAppUrl(`trip_${trip.id}`, req),
        icon: '/assets/icons/icon-192.png',
        badge: '/assets/icons/badge-72.png',
      });
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
      return res.status(400).json({ error: 'Пассажир не найден. Войдите или зарегистрируйтесь в приложении.' });
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
      await sendMessageSafe(tripFull.driver_telegram_id, textForDriver, webAppOpenKeyboard('Открыть бронь', `trip_${tripFull.id}`, req));
    }

    await sendPushPayloadToUserIds([tripFull?.driver_id], {
      title: 'Новая бронь',
      body: `${tripFull?.from_city || trip.from_city} → ${tripFull?.to_city || trip.to_city} · ${booking.seats_booked} мест`,
      tag: `booking-${booking.id}`,
      url: buildWebAppUrl(`trip_${tripFull?.id || trip.id}`, req),
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/badge-72.png',
    });

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
      await sendMessageSafe(tripFull.driver_telegram_id, message, webAppOpenKeyboard('Открыть поездку', `trip_${tripFull.id}`, req));
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

    autopostPlanToChannel(plan, req).catch((error) => console.warn('autopost plan error:', error?.message || error));

    try {
      const trips = await getLatestTrips(120);
      const planTs = Date.parse(plan.desired_time);
      const timeWindow = 4 * 60 * 60 * 1000;
      const seen = new Set();
      const matchedDriverIds = new Set();

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
        await sendMessageSafe(trip.driver_telegram_id, message, webAppOpenKeyboard('Открыть заявку', `plan_${plan.id}`, req));
        if (trip.driver_id) matchedDriverIds.add(Number(trip.driver_id));
      }

      await sendPushPayloadToUserIds([...matchedDriverIds], {
        title: 'Появилась новая заявка пассажира',
        body: `${plan.from_city} → ${plan.to_city} · ${plan.desired_time}`,
        tag: `plan-match-${plan.id}`,
        url: buildWebAppUrl(`plan_${plan.id}`, req),
        icon: '/assets/icons/icon-192.png',
        badge: '/assets/icons/badge-72.png',
      });
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
      await sendMessageSafe(plan.passenger_telegram_id, message, webAppOpenKeyboard('Открыть заявку', `plan_${plan.id}`, req));
    }

    await sendPushPayloadToUserIds([plan?.passenger_id], {
      title: 'Водитель забрал вашу заявку',
      body: `${plan?.from_city || ''} → ${plan?.to_city || ''} · ${plan?.desired_time || ''}`.trim(),
      tag: `taken-plan-${plan.id}`,
      url: buildWebAppUrl(`plan_${plan.id}`, req),
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/badge-72.png',
    });

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
          p.from_city,
          p.to_city,
          p.desired_time AS ride_time,
          pu.telegram_id AS passenger_telegram_id,
          du.telegram_id AS driver_telegram_id,
          pu.first_name AS passenger_first_name,
          pu.last_name AS passenger_last_name,
          du.first_name AS driver_first_name,
          du.last_name AS driver_last_name,
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
          b.trip_id,
          b.passenger_id,
          t.driver_id,
          t.from_city,
          t.to_city,
          t.departure_time AS ride_time,
          pu.telegram_id AS passenger_telegram_id,
          du.telegram_id AS driver_telegram_id,
          pu.first_name AS passenger_first_name,
          pu.last_name AS passenger_last_name,
          du.first_name AS driver_first_name,
          du.last_name AS driver_last_name,
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

function normalizeChatContextType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'booking' || normalized === 'plan' ? normalized : '';
}

function formatChatPerson(firstName, lastName, username, fallback = 'Собеседник') {
  const fullName = `${firstName || ''} ${lastName || ''}`.trim();
  if (fullName) return fullName;
  if (username) return `@${String(username).replace('@', '')}`;
  return fallback;
}

async function getChatAccess({ telegramId, contextType, contextId }) {
  const type = normalizeChatContextType(contextType);
  if (!type) {
    const error = new Error('Некорректный тип чата');
    error.code = 'BAD_CONTEXT';
    throw error;
  }

  const me = await getUserByTelegramId(telegramId);
  if (!me) {
    const error = new Error('Пользователь не найден');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  const participants = await getRideParticipants(type, Number(contextId));
  if (!participants) {
    const error = new Error('Поездка не найдена');
    error.code = 'CONTEXT_NOT_FOUND';
    throw error;
  }

  let role = '';
  if (participants.driver_id && Number(me.id) === Number(participants.driver_id)) role = 'driver';
  if (participants.passenger_id && Number(me.id) === Number(participants.passenger_id)) role = 'passenger';
  if (!role) {
    const error = new Error('Нет доступа к этому чату');
    error.code = 'FORBIDDEN';
    throw error;
  }

  if (type === 'plan' && participants.status !== 'taken') {
    const error = new Error('Чат откроется после того, как водитель заберёт заявку');
    error.code = 'CHAT_NOT_READY';
    throw error;
  }

  if (type === 'booking' && (participants.status === 'cancelled' || participants.status === 'no_show')) {
    const error = new Error('Чат по этой броне уже недоступен');
    error.code = 'CHAT_CLOSED';
    throw error;
  }

  const otherId = role === 'driver' ? participants.passenger_id : participants.driver_id;
  if (!otherId) {
    const error = new Error('Собеседник пока не назначен');
    error.code = 'CHAT_NOT_READY';
    throw error;
  }

  const otherName = role === 'driver'
    ? formatChatPerson(participants.passenger_first_name, participants.passenger_last_name, participants.passenger_username, 'Пассажир')
    : formatChatPerson(participants.driver_first_name, participants.driver_last_name, participants.driver_username, 'Водитель');
  const route = `${participants.from_city || ''} → ${participants.to_city || ''}`.trim();

  return {
    me,
    role,
    otherId: Number(otherId),
    otherTelegramId: role === 'driver' ? participants.passenger_telegram_id : participants.driver_telegram_id,
    otherName,
    thread: {
      context_type: type,
      context_id: Number(contextId),
      title: otherName,
      subtitle: route,
      ride_time: participants.ride_time || '',
      role,
    },
    participants,
  };
}

function normalizeChatMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mapChatMessage(row) {
  return {
    id: Number(row.id),
    context_type: row.context_type,
    context_id: Number(row.context_id),
    sender_id: Number(row.sender_id),
    recipient_id: Number(row.recipient_id),
    text: row.message_text || '',
    created_at: row.created_at || '',
    read_at: row.read_at || '',
    sender_first_name: row.sender_first_name || '',
    sender_last_name: row.sender_last_name || '',
    sender_username: row.sender_username || '',
  };
}

app.get('/api/chat/messages', async (req, res) => {
  try {
    const { telegram_id, context_type, context_id } = req.query;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Не указан чат' });

    const access = await getChatAccess({ telegramId: telegram_id, contextType: context_type, contextId: context_id });

    await dbRun(
      `
        UPDATE chat_messages
        SET read_at = COALESCE(read_at, datetime('now','localtime'))
        WHERE context_type = ?
          AND context_id = ?
          AND recipient_id = ?
          AND read_at IS NULL
      `,
      [access.thread.context_type, access.thread.context_id, access.me.id]
    );

    const messages = await dbAll(
      `
        SELECT *
        FROM (
          SELECT
            m.*,
            u.first_name AS sender_first_name,
            u.last_name AS sender_last_name,
            u.username AS sender_username
          FROM chat_messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.context_type = ?
            AND m.context_id = ?
          ORDER BY m.id DESC
          LIMIT 80
        )
        ORDER BY id ASC
      `,
      [access.thread.context_type, access.thread.context_id]
    );

    return res.json({
      thread: access.thread,
      me: { id: access.me.id },
      messages: messages.map(mapChatMessage),
    });
  } catch (error) {
    console.error('Ошибка /api/chat/messages:', error);
    if (['BAD_CONTEXT', 'USER_NOT_FOUND', 'CONTEXT_NOT_FOUND', 'CHAT_NOT_READY', 'CHAT_CLOSED'].includes(error.code)) {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: error.message });
    return res.status(500).json({ error: 'Не удалось загрузить чат' });
  }
});

app.post('/api/chat/messages', async (req, res) => {
  try {
    const { telegram_id, context_type, context_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Не указан telegram_id' });
    if (!context_type || !context_id) return res.status(400).json({ error: 'Не указан чат' });

    const text = normalizeChatMessage(req.body.message || req.body.text);
    if (!text) return res.status(400).json({ error: 'Введите сообщение' });
    if (text.length > 800) return res.status(400).json({ error: 'Сообщение слишком длинное' });

    const access = await getChatAccess({ telegramId: telegram_id, contextType: context_type, contextId: context_id });
    const insert = await dbRun(
      `
        INSERT INTO chat_messages (
          context_type,
          context_id,
          sender_id,
          recipient_id,
          message_text,
          created_at
        ) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
      `,
      [access.thread.context_type, access.thread.context_id, access.me.id, access.otherId, text]
    );

    const row = await dbGet(
      `
        SELECT
          m.*,
          u.first_name AS sender_first_name,
          u.last_name AS sender_last_name,
          u.username AS sender_username
        FROM chat_messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?
      `,
      [insert.lastID]
    );

    const openParam = access.thread.context_type === 'plan'
      ? `plan_${access.thread.context_id}`
      : `trip_${access.participants.trip_id || access.thread.context_id}`;

    await sendPushPayloadToUserIds([access.otherId], {
      title: `Новое сообщение: ${formatChatPerson(access.me.first_name, access.me.last_name, access.me.username, 'Попутчики')}`,
      body: text,
      tag: `chat-${access.thread.context_type}-${access.thread.context_id}`,
      url: buildWebAppUrl(openParam, req),
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/badge-72.png',
    });

    return res.json({
      success: true,
      thread: access.thread,
      message: mapChatMessage(row),
    });
  } catch (error) {
    console.error('Ошибка /api/chat/messages POST:', error);
    if (['BAD_CONTEXT', 'USER_NOT_FOUND', 'CONTEXT_NOT_FOUND', 'CHAT_NOT_READY', 'CHAT_CLOSED'].includes(error.code)) {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: error.message });
    return res.status(500).json({ error: 'Не удалось отправить сообщение' });
  }
});

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

app.get('/api/owner/support', async (req, res) => {
  try {
    if (!ensureOwnerAccess(req, res)) return;

    const support = await getSupportSettings();
    return res.json({ support });
  } catch (error) {
    console.error('Ошибка /api/owner/support:', error);
    return res.status(500).json({ error: `Не удалось загрузить контакт поддержки: ${error.message || 'ошибка сервера'}` });
  }
});

app.post('/api/owner/support', async (req, res) => {
  try {
    if (!ensureOwnerAccess(req, res)) return;

    const supportLabel = String(req.body.support_label || req.body.label || '').trim() || 'Поддержка';
    const supportUrl = normalizeSupportUrl(req.body.support_url || req.body.url || '');
    const supportText = String(req.body.support_text || req.body.text || '').trim();

    if (!isSupportedContactUrl(supportUrl)) {
      return res.status(400).json({ error: 'Введите ссылку поддержки или Telegram username в формате @username.' });
    }

    await setAppSettings({
      support_label: supportLabel,
      support_url: supportUrl,
      support_text: supportText,
    });

    const support = await getSupportSettings();
    return res.json({ success: true, support });
  } catch (error) {
    console.error('Ошибка /api/owner/support:', error);
    return res.status(500).json({ error: `Не удалось сохранить контакт поддержки: ${error.message || 'ошибка сервера'}` });
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
