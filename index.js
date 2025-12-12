// index.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { Telegraf } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');

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

if (!BOT_TOKEN) {
  console.error('Ошибка: не задан BOT_TOKEN в .env или переменных окружения');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
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
  db.run(
    `
    CREATE TABLE IF NOT EXISTS passenger_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      passenger_id INTEGER NOT NULL,
      from_city TEXT NOT NULL,
      to_city TEXT NOT NULL,
      desired_time TEXT NOT NULL,
      seats_needed INTEGER NOT NULL,
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

  db.run(
    `
    CREATE INDEX IF NOT EXISTS idx_passenger_plans_status_time
    ON passenger_plans (status, desired_time)
  `
  );
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

    return res.json({ trip });
  } catch (err) {
    console.error('Ошибка /api/trips (POST):', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Список поездок (пассажир) — только не полные и не устаревшие
app.get('/api/trips', async (req, res) => {
  try {
    const rawTrips = await getLatestTrips(50);
    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000; // показываем до 10 минут после старта

    const trips = (rawTrips || []).filter((t) => {
      if (t.seats_available <= 0) return false;
      const ts = Date.parse(t.departure_time);
      if (!Number.isFinite(ts)) return true;
      return ts >= cutoff;
    });

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
    const { telegram_id, from_city, to_city, desired_time, seats_needed, note } = req.body;

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

    await dbRun(
      `
      INSERT INTO passenger_plans (
        passenger_id,
        from_city,
        to_city,
        desired_time,
        seats_needed,
        note,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now','localtime'))
    `,
      [
        passenger.id,
        from_city,
        to_city,
        desired_time,
        seatsNum,
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

    return res.json({ success: true });
  } catch (err) {
    console.error('Ошибка /api/driver/passenger-plans/take:', err);
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
