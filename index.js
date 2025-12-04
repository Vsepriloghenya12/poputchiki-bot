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
  getDriverProfileByTelegramId,
  updateDriverCarProfile,
  getTripWithDriver,
  getDriverTripsByTelegramId,
  getTripBookingsForDriver,
  createBooking,
  markBookingNoShow,
  getAdminStats,
} = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';

if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в .env или переменных окружения');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== БОТ ======

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

// ====== API ======

// Инициализация пользователя
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

// Создание поездки
app.post('/api/trips', async (req, res) => {
  try {
    const {
      telegram_id,
      from_city,
      to_city,
      departure_time,
      seats_total,
      price_per_seat,
      note,
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
      note,
    });

    return res.json({ trip });
  } catch (err) {
    console.error('Ошибка /api/trips (POST):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Список поездок (пассажир)
app.get('/api/trips', async (req, res) => {
  try {
    const trips = await getLatestTrips(20);
    return res.json({ trips });
  } catch (err) {
    console.error('Ошибка /api/trips (GET):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

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

// Бронирование мест
app.post('/api/bookings', async (req, res) => {
  try {
    const { telegram_id, trip_id, seats } = req.body;

    if (!telegram_id || !trip_id || !seats) {
      return res.status(400).json({ error: 'Не все данные для бронирования переданы' });
    }

    const passenger = await getUserByTelegramId(telegram_id);
    if (!passenger) {
      return res.status(400).json({ error: 'Пассажир не найден. Откройте Mini App через /start.' });
    }

    const tripIdNum = Number(trip_id);
    const seatsNum = Number(seats);

    const { booking, trip, passenger: bookingPassenger } = await createBooking({
      tripId: tripIdNum,
      passengerTelegramId: telegram_id,
      seatsBooked: seatsNum,
    });

    const tripFull = await getTripWithDriver(tripIdNum);

    // Уведомление водителю
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
        .catch((err) => console.error('Ошибка отправки уведомления водителю:', err));
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
        .catch((err) => console.error('Ошибка отправки уведомления пассажиру:', err));
    }

    return res.json({ booking, trip: tripFull });
  } catch (err) {
    console.error('Ошибка /api/bookings (POST):', err);

    if (err.code === 'NOT_ENOUGH_SEATS') {
      return res.status(400).json({ error: 'Недостаточно свободных мест.' });
    }
    if (err.code === 'TRIP_NOT_FOUND') {
      return res.status(400).json({ error: 'Поездка не найдена.' });
    }
    if (err.code === 'PASSENGER_NOT_FOUND') {
      return res.status(400).json({ error: 'Пассажир не найден.' });
    }
    if (err.code === 'BAD_SEATS') {
      return res.status(400).json({ error: 'Некорректное количество мест.' });
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

// Активная поездка водителя
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

    const futureTrips = trips.filter((t) => {
      const ts = Date.parse(t.departure_time);
      return Number.isFinite(ts) && ts >= now;
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

// Пассажиры поездки (для водителя)
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

// Отметка "не приехал"
app.post('/api/bookings/no-show', async (req, res) => {
  try {
    const { telegram_id, booking_id } = req.body;

    if (!telegram_id || !booking_id) {
      return res.status(400).json({ error: 'Не указаны telegram_id или booking_id' });
    }

    const driver = await getUserByTelegramId(telegram_id);
    if (!driver) {
      return res.status(400).json({ error: 'Водитель не найден' });
    }

    const bookingIdNum = Number(booking_id);
    await markBookingNoShow({ bookingId: bookingIdNum, driverId: driver.id });

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка /api/bookings/no-show:', err);

    if (err.code === 'BOOKING_NOT_FOUND') {
      return res.status(400).json({ error: 'Бронирование не найдено' });
    }
    if (err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Нет прав на изменение этого бронирования' });
    }

    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Статистика для владельца
app.get('/api/admin/stats', async (req, res) => {
  try {
    const telegram_id = req.query.telegram_id;
    if (!telegram_id) {
      return res.status(400).json({ error: 'Не указан telegram_id' });
    }

    if (!ADMIN_TELEGRAM_ID || String(telegram_id) !== String(ADMIN_TELEGRAM_ID)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const stats = await getAdminStats();
    return res.json({ stats });
  } catch (err) {
    console.error('Ошибка /api/admin/stats:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Mini App
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
