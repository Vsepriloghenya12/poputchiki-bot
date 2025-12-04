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

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  console.error('Ошибка: не задан BOT_TOKEN в .env');
  process.exit(1);
}

const bot = new Telegraf(botToken);
const app = express();

// Парсер JSON для API
app.use(bodyParser.json());

// Статика для Mini App
app.use(express.static(path.join(__dirname, 'public')));

// ====== ПРОСТОЙ БОТ ======

bot.start((ctx) => {
  ctx.reply(
    'Привет! Это бот "попутчики".\n' +
    'Скоро вы сможете открыть мини-приложение и находить попутчиков.\n\n' +
    'Сейчас Mini App доступен по адресу (локально): http://localhost:3000'
  );
});

bot.help((ctx) => {
  ctx.reply('Пока доступна команда /start. Логика поездок в Mini App в разработке.');
});

bot.on('text', (ctx) => {
  ctx.reply('Я ещё учусь. Основной функционал будет в Mini App.');
});

// ====== API ДЛЯ MINI APP ======

// 1) Инициализация пользователя из Telegram WebApp
app.post('/api/init-user', async (req, res) => {
  try {
    const { user } = req.body; // ожидаем { user: { id, first_name, ... } }

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

    if (!telegram_id || !from_city || !to_city || !departure_time || !seats_total || !price_per_seat) {
      return res.status(400).json({ error: 'Не все поля заполнены' });
    }

    const user = await getUserByTelegramId(telegram_id);
    if (!user) {
      return res.status(400).json({ error: 'Пользователь не найден. Сначала вызовите /api/init-user.' });
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

// 3) Получение списка последних поездок (для пассажира)
app.get('/api/trips', async (req, res) => {
  try {
    const trips = await getLatestTrips(20);
    res.json({ trips });
  } catch (err) {
    console.error('Ошибка /api/trips (GET):', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Маршрут по умолчанию — мини-приложение
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Порт
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Веб-сервер запущен на http://localhost:${PORT}`);
});

bot.launch()
  .then(() => {
    console.log('Бот запущен');
  })
  .catch((err) => {
    console.error('Ошибка запуска бота:', err);
  });

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
