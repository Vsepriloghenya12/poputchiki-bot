require('dotenv').config();

const { Telegraf } = require('telegraf');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

const {
  upsertUserFromTelegram,
  createTrip,
  getLatestTrips,
  getUserByTelegramId,
} = require('./db');

// ====== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ======

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в .env или переменных окружения');
  process.exit(1);
}

// ====== ИНИЦИАЛИЗАЦИЯ БОТА И СЕРВЕРА ======

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Парсим JSON в запросах API
app.use(bodyParser.json());

// Раздача статики для Mini App (папка public)
app.use(express.static(path.join(__dirname, 'public')));

// ====== ЛОГИКА БОТА ======

// /start — приветствие + кнопка открытия Mini App
bot.start((ctx) => {
  // Если URL локальный (http://localhost) — НЕ отправляем web_app кнопку
  if (WEBAPP_URL.startsWith('http://localhost')) {
    return ctx.reply(
      'Привет! Это бот "попутчики".\n' +
      'Сейчас вы запустили его локально.\n\n' +
      'Мини-приложение можно открыть в браузере по адресу:\n' +
      WEBAPP_URL
    );
  }

  // Боевой режим: HTTPS-URL, можно слать web_app кнопку
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

// На любые текстовые сообщения — подсказка использовать Mini App
bot.on('text', (ctx) => {
  return ctx.reply(
    'Основной функционал доступен в мини-приложении.\n' +
    'Нажмите /start и откройте "попутчики" по кнопке.'
  );
});

// ====== API ДЛЯ MINI APP ======

// 1) Инициализация/регистрация пользователя из Telegram WebApp
app.post('/api/init-user', async (req, res) => {
  try {
    const { user } = req.body;

    if (!user || !user.id) {
      return res.status(400).json({ error: 'Некорректный объект user' });
    }

    const dbUser = await upsertUserFromTelegram(user);
    return res.json({ user: dbUser });
  } catch (err) {
    console.error('Ошибка /api/init-user:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 2) Создание поездки водителем
app.post('/api/trips', async (req, res) => {
  try {
    const {
      telegram_id,
      from_city,
      to_city,
      departure_time,
      seats_total,
      price_per_seat,
    } = req.body;

    if (
      !telegram_id ||
      !from_city ||
      !to_city ||
      !departure_time ||
      !seats_total ||
      !price_per_seat
    ) {
      return res.status(400).json({ error: 'Не все поля заполнены' });
    }

    const user = await getUserByTelegramId(telegram_id);
    if (!user) {
      return res.status(400).json({
        error: 'Пользователь не найден. Сначала откройте Mini App через /start.',
      });
    }

    const trip = await createTrip({
      driverId: user.id,
      fromCity: from_city,
      toCity: to_city,
      departureTime: departure_time,
      seatsTotal: seats_total,
      pricePerSeat: price_per_seat,
    });

    return res.json({ trip });
  } catch (err) {
    console.error('Ошибка /api/trips (POST):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 3) Получение списка последних поездок (для пассажира)
app.get('/api/trips', async (req, res) => {
  try {
    const trips = await getLatestTrips(20);
    return res.json({ trips });
  } catch (err) {
    console.error('Ошибка /api/trips (GET):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ====== МАРШРУТ ПО УМОЛЧАНИЮ — MINI APP ======

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ====== ЗАПУСК HTTP-СЕРВЕРА И БОТА ======

app.listen(PORT, () => {
  console.log(`Веб-сервер запущен на http://0.0.0.0:${PORT}`);
});

bot.launch()
  .then(() => {
    console.log('Бот запущен');
  })
  .catch((err) => {
    console.error('Ошибка запуска бота:', err);
  });

// Корректное завершение бота
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
