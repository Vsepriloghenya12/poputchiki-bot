require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const path = require('path');

const {
  upsertUserFromTelegram,
  createTrip,
  getLatestTrips,
  getUserByTelegramId,
} = require('./db');

const botToken = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;

if (!botToken) {
  console.error('Ошибка: переменная BOT_TOKEN не задана');
  process.exit(1);
}

// ====== ИНИЦИАЛИЗАЦИЯ БОТА И СЕРВЕРА ======

const bot = new Telegraf(botToken);
const app = express();

// JSON для API
app.use(express.json());

// Статика Mini App
app.use(express.static(path.join(__dirname, 'public')));

// ====== ОБРАБОТЧИКИ БОТА ======

bot.start((ctx) => {
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
  ctx.reply(
    'Основной функционал доступен в мини-приложении. Нажмите кнопку «Открыть попутчики» в /start.'
  );
});

bot.on('text', (ctx) => {
  ctx.reply('Используйте команду /start и откройте мини-приложение по кнопке.');
});

// ====== API ДЛЯ MINI APP ======

// Инициализация пользователя из Telegram WebApp
app.post('/api/init-user', async (req, res) => {
  try {
    const { user } = req.body;

    if (!user || !user.id) {
      return res.status(400).json({ error: 'Некорректный объект user' });
    }

    const dbUser = await upsertUserFromTelegram(user);
    res.json({ user: dbUser });
  } catch (err) {
    console.error('Ошибка /api/init-user:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Создание поездки водителем
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
      return res
        .status(400)
        .json({ error: 'Пользователь не найден. Сначала откройте мини-приложение через бота.' });
    }

    const trip = await createTrip({
      driverId: user.id,
      fromCity: from_city,
      toCity: to_city,
      departureTime: departure_time,
      seatsTotal: seats_total,
      pricePerSeat: price_per_seat,
    });

    res.json({ trip });
  } catch (err) {
    console.error('Ошибка /api/trips (POST):', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Получение списка последних поездок для пассажира
app.get('/api/trips', async (req, res) => {
  try {
    const trips = await getLatestTrips(20);
    res.json({ trips });
  } catch (err) {
    console.error('Ошибка /api/trips (GET):', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Главная — отдать Mini App
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
    process.exit(1);
  });

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
