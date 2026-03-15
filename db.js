// db.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Путь к БД: можно переопределить через переменную окружения SQLITE_PATH
const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'app.sqlite');

// Процент комиссии сервиса (по умолчанию 10%)
// Можно задать через APP_FEE_PERCENT (или SERVICE_FEE_PCT для совместимости), например 0.05 = 5%
const APP_FEE_PERCENT_RAW =
  process.env.APP_FEE_PERCENT ?? process.env.SERVICE_FEE_PCT ?? '0.10';
const APP_FEE_PERCENT_PARSED = Number(APP_FEE_PERCENT_RAW);
const APP_FEE_PERCENT = Number.isFinite(APP_FEE_PERCENT_PARSED)
  ? Math.max(0, Math.min(1, APP_FEE_PERCENT_PARSED))
  : 0.10;

const db = new sqlite3.Database(DB_PATH);

// ---------------- ИНИЦИАЛИЗАЦИЯ СХЕМЫ ----------------

db.serialize(() => {
  // Пользователи Telegram
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      language_code TEXT,
      is_premium INTEGER DEFAULT 0,
      no_show_count INTEGER DEFAULT 0,
      car_make TEXT,
      car_color TEXT,
      car_plate TEXT,
      is_blocked INTEGER DEFAULT 0
    )
  `);

  // Поездки
  db.run(`
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER NOT NULL,
      from_city TEXT NOT NULL,
      to_city TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      seats_total INTEGER NOT NULL,
      seats_available INTEGER NOT NULL,
      price_per_seat REAL NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (driver_id) REFERENCES users(id)
    )
  `);

  // Бронирования
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL,
      passenger_id INTEGER NOT NULL,
      seats_booked INTEGER NOT NULL,
      amount_total REAL NOT NULL,
      driver_amount REAL NOT NULL,
      app_fee REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked', -- booked / cancelled / no_show
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (trip_id) REFERENCES trips(id),
      FOREIGN KEY (passenger_id) REFERENCES users(id)
    )
  `);

  // Настройки приложения (одна строка, id = 1)
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monetization_enabled INTEGER NOT NULL DEFAULT 0,
      payment_details TEXT
    )
  `);

  // Чеки оплаты от водителей
  db.run(`
    CREATE TABLE IF NOT EXISTS driver_payment_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER NOT NULL,
      file_original_name TEXT,
      file_stored_name TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (driver_id) REFERENCES users(id)
    )
  `);

  // Гарантируем, что есть строка настроек с id = 1
  db.run(`
    INSERT OR IGNORE INTO app_settings (id, monetization_enabled, payment_details)
    VALUES (1, 0, '')
  `);
});

// ---------------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------------

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// ---------------- ПОЛЬЗОВАТЕЛИ ----------------

async function upsertUserFromTelegram(tgUser) {
  if (!tgUser || !tgUser.id) {
    throw new Error('Некорректные данные пользователя Telegram');
  }

  const {
    id,
    first_name,
    last_name,
    username,
    language_code,
    is_premium,
  } = tgUser;

  const telegramId = String(id);

  const existing = await getAsync(
    `SELECT * FROM users WHERE telegram_id = ?`,
    [telegramId]
  );

  if (existing) {
    await runAsync(
      `
        UPDATE users
        SET first_name = ?, last_name = ?, username = ?, language_code = ?, is_premium = ?
        WHERE telegram_id = ?
      `,
      [
        first_name || null,
        last_name || null,
        username || null,
        language_code || null,
        is_premium ? 1 : 0,
        telegramId,
      ]
    );

    return getAsync(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId]);
  }

  await runAsync(
    `
      INSERT INTO users (
        telegram_id, first_name, last_name, username, language_code, is_premium
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      telegramId,
      first_name || null,
      last_name || null,
      username || null,
      language_code || null,
      is_premium ? 1 : 0,
    ]
  );

  return getAsync(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId]);
}

function getUserByTelegramId(telegramId) {
  return getAsync(
    `SELECT * FROM users WHERE telegram_id = ?`,
    [String(telegramId)]
  );
}

// Профиль водителя (машина)
async function getDriverProfileByTelegramId(telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) return null;

  return {
    id: user.id,
    telegram_id: user.telegram_id,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    car_make: user.car_make,
    car_color: user.car_color,
    car_plate: user.car_plate,
    is_blocked: user.is_blocked || 0,
  };
}

async function updateDriverCarProfile(telegramId, { carMake, carColor, carPlate }) {
  const user = await getUserByTelegramId(telegramId);
  if (!user) {
    throw new Error('Водитель не найден');
  }

  await runAsync(
    `
      UPDATE users
      SET car_make = ?, car_color = ?, car_plate = ?
      WHERE id = ?
    `,
    [carMake || null, carColor || null, carPlate || null, user.id]
  );

  return getDriverProfileByTelegramId(telegramId);
}

// блокировка / разблокировка пользователя по telegram_id
async function setUserBlockedByTelegramId(telegramId, blocked) {
  await runAsync(
    `
      UPDATE users
      SET is_blocked = ?
      WHERE telegram_id = ?
    `,
    [blocked ? 1 : 0, String(telegramId)]
  );
}

// ---------------- ПОЕЗДКИ ----------------

async function createTrip({
  driverId,
  fromCity,
  toCity,
  departureTime,
  seatsTotal,
  pricePerSeat,
  note,
}) {
  const seatsTotalNum = Number(seatsTotal);
  const pricePerSeatNum = Number(pricePerSeat);

  if (!Number.isFinite(seatsTotalNum) || seatsTotalNum <= 0) {
    throw new Error('Некорректное число мест');
  }
  if (!Number.isFinite(pricePerSeatNum) || pricePerSeatNum < 0) {
    throw new Error('Некорректная цена за место');
  }

  await runAsync(
    `
      INSERT INTO trips (
        driver_id,
        from_city,
        to_city,
        departure_time,
        seats_total,
        seats_available,
        price_per_seat,
        note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      driverId,
      fromCity,
      toCity,
      departureTime,
      seatsTotalNum,
      seatsTotalNum,
      pricePerSeatNum,
      note || null,
    ]
  );

  const trip = await getAsync(
    `
      SELECT *
      FROM trips
      WHERE rowid = last_insert_rowid()
    `
  );

  return trip;
}

// Список поездок (для пассажира)
// Берём только актуальные и не полные поездки, а лимит применяем уже после фильтрации.
// Иначе при большом количестве старых записей новые поездки не попадут в первые 50 строк
// и перестанут отображаться у пассажиров.
async function getLatestTrips(limit = 50) {
  const rows = await allAsync(
    `
      SELECT
        t.*,
        u.telegram_id AS driver_telegram_id,
        u.first_name,
        u.last_name,
        u.username,
        (
          SELECT COUNT(*)
          FROM bookings b
          WHERE b.trip_id = t.id AND b.status = 'booked'
        ) AS bookings_count
      FROM trips t
      JOIN users u ON u.id = t.driver_id
      WHERE t.seats_available > 0
        AND datetime(t.departure_time) >= datetime('now', '-10 minutes')
      ORDER BY datetime(t.departure_time) ASC
      LIMIT ?
    `,
    [limit]
  );

  return rows;
}

async function getTripWithDriver(tripId) {
  const row = await getAsync(
    `
      SELECT
        t.*,
        u.telegram_id AS driver_telegram_id,
        u.first_name AS driver_first_name,
        u.last_name AS driver_last_name,
        u.username AS driver_username,
        u.car_make,
        u.car_color,
        u.car_plate
      FROM trips t
      JOIN users u ON u.id = t.driver_id
      WHERE t.id = ?
    `,
    [Number(tripId)]
  );

  return row;
}

// Все поездки водителя (история + активные)
async function getDriverTripsByTelegramId(telegramId) {
  const rows = await allAsync(
    `
      SELECT
        t.*,
        (
          SELECT COUNT(*)
          FROM bookings b
          WHERE b.trip_id = t.id AND b.status = 'booked'
        ) AS bookings_count
      FROM trips t
      JOIN users u ON u.id = t.driver_id
      WHERE u.telegram_id = ?
      ORDER BY datetime(t.departure_time) DESC
    `,
    [String(telegramId)]
  );

  return rows;
}

// Удаление поездки водителем
function deleteTripByDriver(tripId, driverId) {
  return new Promise((resolve, reject) => {
    const tripIdNum = Number(tripId);
    const driverIdNum = Number(driverId);

    db.get(
      `SELECT * FROM trips WHERE id = ?`,
      [tripIdNum],
      (err, trip) => {
        if (err) return reject(err);
        if (!trip) {
          const e = new Error('Поездка не найдена');
          e.code = 'TRIP_NOT_FOUND';
          return reject(e);
        }
        if (trip.driver_id !== driverIdNum) {
          const e = new Error('Нет прав на удаление этой поездки');
          e.code = 'FORBIDDEN';
          return reject(e);
        }

        // Нельзя удалять поездку после её начала
        const departTs = Date.parse(trip.departure_time);
        if (Number.isFinite(departTs)) {
          const now = Date.now();
          if (now >= departTs) {
            const e = new Error('Нельзя отменить поездку после её начала');
            e.code = 'TOO_LATE';
            return reject(e);
          }
        }

        // Нельзя удалять поездку, по которой уже были брони
        db.get(
          `SELECT COUNT(*) AS cnt FROM bookings WHERE trip_id = ?`,
          [tripIdNum],
          (err2, row) => {
            if (err2) return reject(err2);
            const cnt = row ? row.cnt : 0;

            if (cnt > 0) {
              const e = new Error('Нельзя удалить поездку, по которой уже есть бронирования');
              e.code = 'HAS_BOOKINGS';
              return reject(e);
            }

            db.run(
              `DELETE FROM trips WHERE id = ?`,
              [tripIdNum],
              (errDel) => {
                if (errDel) return reject(errDel);
                resolve(trip);
              }
            );
          }
        );
      }
    );
  });
}

// ---------------- БРОНИРОВАНИЯ ----------------

async function createBooking({
  tripId,
  passengerTelegramId,
  seatsBooked,
}) {
  const trip = await getAsync(`SELECT * FROM trips WHERE id = ?`, [Number(tripId)]);
  if (!trip) {
    const e = new Error('Поездка не найдена');
    e.code = 'TRIP_NOT_FOUND';
    throw e;
  }

  const seatsNum = Number(seatsBooked);
  if (!Number.isFinite(seatsNum) || seatsNum <= 0) {
    const e = new Error('Некорректное количество мест');
    e.code = 'BAD_SEATS';
    throw e;
  }

  if (trip.seats_available < seatsNum) {
    const e = new Error('Недостаточно свободных мест');
    e.code = 'NOT_ENOUGH_SEATS';
    throw e;
  }

  const passenger = await getUserByTelegramId(passengerTelegramId);
  if (!passenger) {
    const e = new Error('Пассажир не найден');
    e.code = 'PASSENGER_NOT_FOUND';
    throw e;
  }

  const pricePerSeat = Number(trip.price_per_seat);
  const amountTotal = pricePerSeat * seatsNum;
  const appFee = Math.round(amountTotal * APP_FEE_PERCENT);
  const driverAmount = amountTotal - appFee;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (errBegin) => {
        if (errBegin) return reject(errBegin);

        db.run(
          `
            INSERT INTO bookings (
              trip_id,
              passenger_id,
              seats_booked,
              amount_total,
              driver_amount,
              app_fee,
              status,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'booked', datetime('now','localtime'))
          `,
          [
            trip.id,
            passenger.id,
            seatsNum,
            amountTotal,
            driverAmount,
            appFee,
          ],
          function (errInsert) {
            if (errInsert) {
              db.run('ROLLBACK');
              return reject(errInsert);
            }

            const bookingId = this.lastID;

            db.run(
              `
                UPDATE trips
                SET seats_available = seats_available - ?
                WHERE id = ?
              `,
              [seatsNum, trip.id],
              (errUpdate) => {
                if (errUpdate) {
                  db.run('ROLLBACK');
                  return reject(errUpdate);
                }

                db.run('COMMIT', async (errCommit) => {
                  if (errCommit) return reject(errCommit);

                  try {
                    const booking = await getAsync(
                      `SELECT * FROM bookings WHERE id = ?`,
                      [bookingId]
                    );
                    resolve({ booking, trip, passenger });
                  } catch (e) {
                    reject(e);
                  }
                });
              }
            );
          }
        );
      });
    });
  });
}

// Бронирования по поездке для водителя
async function getTripBookingsForDriver(tripId, driverId) {
  const rows = await allAsync(
    `
      SELECT
        b.*,
        p.first_name AS passenger_first_name,
        p.last_name AS passenger_last_name,
        p.username AS passenger_username,
        p.no_show_count AS passenger_no_show_count
      FROM bookings b
      JOIN trips t ON t.id = b.trip_id
      JOIN users p ON p.id = b.passenger_id
      WHERE b.trip_id = ?
        AND t.driver_id = ?
      ORDER BY b.created_at ASC
    `,
    [Number(tripId), Number(driverId)]
  );

  return rows;
}

// Отметка "не приехал"
function markBookingNoShow({ bookingId, driverId }) {
  return new Promise((resolve, reject) => {
    const bookingIdNum = Number(bookingId);
    const driverIdNum = Number(driverId);

    db.serialize(() => {
      db.get(
        `
          SELECT
            b.*,
            t.driver_id,
            b.passenger_id
          FROM bookings b
          JOIN trips t ON t.id = b.trip_id
          WHERE b.id = ?
        `,
        [bookingIdNum],
        (err, row) => {
          if (err) return reject(err);
          if (!row) {
            const e = new Error('Бронирование не найдено');
            e.code = 'BOOKING_NOT_FOUND';
            return reject(e);
          }
          if (row.driver_id !== driverIdNum) {
            const e = new Error('Нет прав на изменение этого бронирования');
            e.code = 'FORBIDDEN';
            return reject(e);
          }

          db.run('BEGIN TRANSACTION', (errBegin) => {
            if (errBegin) return reject(errBegin);

            db.run(
              `UPDATE bookings SET status = 'no_show' WHERE id = ?`,
              [bookingIdNum],
              (errUpd) => {
                if (errUpd) {
                  db.run('ROLLBACK');
                  return reject(errUpd);
                }

                db.run(
                  `
                    UPDATE users
                    SET no_show_count = no_show_count + 1
                    WHERE id = ?
                  `,
                  [row.passenger_id],
                  (errUser) => {
                    if (errUser) {
                      db.run('ROLLBACK');
                      return reject(errUser);
                    }

                    db.run('COMMIT', (errCommit) => {
                      if (errCommit) return reject(errCommit);
                      resolve();
                    });
                  }
                );
              }
            );
          });
        }
      );
    });
  });
}

// Активные/все бронирования пассажира
function getPassengerBookingsByTelegramId(telegramId) {
  return allAsync(
    `
      SELECT
        b.*,
        t.from_city,
        t.to_city,
        t.departure_time,
        t.price_per_seat,
        t.seats_total,
        t.seats_available,
        d.telegram_id AS driver_telegram_id,
        d.first_name AS driver_first_name,
        d.last_name AS driver_last_name,
        d.username AS driver_username
      FROM bookings b
      JOIN users p ON p.id = b.passenger_id
      JOIN trips t ON t.id = b.trip_id
      JOIN users d ON d.id = t.driver_id
      WHERE p.telegram_id = ?
      ORDER BY datetime(t.departure_time) ASC
    `,
    [String(telegramId)]
  );
}

// Отмена бронирования самим пассажиром
function cancelBookingByPassenger({ bookingId, passengerId }) {
  return new Promise((resolve, reject) => {
    const bookingIdNum = Number(bookingId);
    const passengerIdNum = Number(passengerId);

    db.serialize(() => {
      db.get(
        `
          SELECT
            b.*,
            t.from_city,
            t.to_city,
            t.departure_time,
            t.price_per_seat,
            t.seats_total,
            t.seats_available,
            t.driver_id
          FROM bookings b
          JOIN trips t ON t.id = b.trip_id
          WHERE b.id = ?
        `,
        [bookingIdNum],
        (err, row) => {
          if (err) return reject(err);
          if (!row) {
            const e = new Error('Бронирование не найдено');
            e.code = 'BOOKING_NOT_FOUND';
            return reject(e);
          }
          if (row.passenger_id !== passengerIdNum) {
            const e = new Error('Нет прав на отмену этого бронирования');
            e.code = 'FORBIDDEN';
            return reject(e);
          }
          if (row.status !== 'booked') {
            const e = new Error('Это бронирование нельзя отменить');
            e.code = 'BAD_STATUS';
            return reject(e);
          }

          const departTs = Date.parse(row.departure_time);
          const now = Date.now();
          if (Number.isFinite(departTs) && now >= departTs) {
            const e = new Error('Нельзя отменить бронь после начала поездки');
            e.code = 'TOO_LATE';
            return reject(e);
          }

          db.run('BEGIN TRANSACTION', (errBegin) => {
            if (errBegin) return reject(errBegin);

            db.run(
              `UPDATE bookings SET status = 'cancelled' WHERE id = ?`,
              [bookingIdNum],
              (errUpd) => {
                if (errUpd) {
                  db.run('ROLLBACK');
                  return reject(errUpd);
                }

                db.run(
                  `
                    UPDATE trips
                    SET seats_available = seats_available + ?
                    WHERE id = ?
                  `,
                  [row.seats_booked, row.trip_id],
                  (errTrip) => {
                    if (errTrip) {
                      db.run('ROLLBACK');
                      return reject(errTrip);
                    }

                    db.run('COMMIT', (errCommit) => {
                      if (errCommit) return reject(errCommit);
                      resolve(row);
                    });
                  }
                );
              }
            );
          });
        }
      );
    });
  });
}

// ---------------- НАСТРОЙКИ ПРИЛОЖЕНИЯ ----------------

async function getAppSettings() {
  let row = await getAsync(`SELECT * FROM app_settings WHERE id = 1`);
  if (!row) {
    await runAsync(
      `
        INSERT OR IGNORE INTO app_settings (id, monetization_enabled, payment_details)
        VALUES (1, 0, '')
      `
    );
    row = await getAsync(`SELECT * FROM app_settings WHERE id = 1`);
  }
  return row;
}

async function updateAppSettings({ monetizationEnabled, paymentDetails }) {
  const current = await getAppSettings();
  const newMonetization =
    typeof monetizationEnabled === 'boolean'
      ? (monetizationEnabled ? 1 : 0)
      : current.monetization_enabled;
  const newDetails =
    typeof paymentDetails === 'string'
      ? paymentDetails
      : current.payment_details;

  await runAsync(
    `
      UPDATE app_settings
      SET monetization_enabled = ?, payment_details = ?
      WHERE id = 1
    `,
    [newMonetization, newDetails]
  );

  return getAppSettings();
}

// ---------------- СТАТИСТИКА ДЛЯ ВОДИТЕЛЯ (ПО ДНЮ) ----------------

async function getDriverDailyStats(driverId) {
  // 1) Статистика по обычным бронированиям
  const bookingStats = await getAsync(
    `
      SELECT
        SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS bookings_count,
        COUNT(DISTINCT CASE WHEN b.status = 'booked' THEN b.trip_id END) AS trips_count,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.seats_booked ELSE 0 END), 0) AS seats_count,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.amount_total ELSE 0 END), 0) AS turnover_total,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.app_fee ELSE 0 END), 0) AS app_fee_total,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.driver_amount ELSE 0 END), 0) AS driver_amount_total
      FROM bookings b
      JOIN trips t ON t.id = b.trip_id
      WHERE t.driver_id = ?
        AND date(b.created_at, 'localtime') = date('now','localtime')
    `,
    [Number(driverId)]
  );

  // 2) Плюсуем планы пассажиров, которые водитель «забрал»
  let planTripsCount = 0;
  let planSeatsCount = 0;
  let planTurnoverTotal = 0;
  let planAppFeeTotal = 0;
  let planDriverAmountTotal = 0;

  try {
    const planStats = await getAsync(
      `
        SELECT
          COUNT(*) AS plans_count,
          COALESCE(SUM(seats_needed), 0) AS seats_count,
          COALESCE(SUM(amount_total), 0) AS turnover_total,
          COALESCE(SUM(app_fee), 0) AS app_fee_total,
          COALESCE(SUM(driver_amount), 0) AS driver_amount_total
        FROM passenger_plans
        WHERE status = 'taken'
          AND driver_id = ?
          AND date(taken_at, 'localtime') = date('now','localtime')
      `,
      [Number(driverId)]
    );

    planTripsCount = planStats?.plans_count ? Number(planStats.plans_count) : 0;
    planSeatsCount = planStats?.seats_count ? Number(planStats.seats_count) : 0;
    planTurnoverTotal = planStats?.turnover_total ? Number(planStats.turnover_total) : 0;
    planAppFeeTotal = planStats?.app_fee_total ? Number(planStats.app_fee_total) : 0;
    planDriverAmountTotal = planStats?.driver_amount_total
      ? Number(planStats.driver_amount_total)
      : 0;
  } catch (err) {
    // если таблицы/колонок ещё нет — считаем 0 (чтобы приложение не падало)
    const msg = String(err?.message || '');
    if (!msg.includes('no such table: passenger_plans') && !msg.includes('no such column')) {
      throw err;
    }
  }

  return {
    // «взятый план» считаем поездкой и тоже добавляем в статистику
    trips_count: (bookingStats?.trips_count || 0) + planTripsCount,
    bookings_count: (bookingStats?.bookings_count || 0) + planTripsCount,
    seats_count: (bookingStats?.seats_count || 0) + planSeatsCount,

    turnover_total: (bookingStats?.turnover_total || 0) + planTurnoverTotal,
    app_fee_total: (bookingStats?.app_fee_total || 0) + planAppFeeTotal,
    driver_amount_total: (bookingStats?.driver_amount_total || 0) + planDriverAmountTotal,
  };
}

async function hasDriverPaymentProofToday(driverId) {
  const row = await getAsync(
    `
      SELECT id
      FROM driver_payment_proofs
      WHERE driver_id = ?
        AND date(created_at, 'localtime') = date('now','localtime')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [Number(driverId)]
  );

  return !!row;
}

async function saveDriverPaymentProof(driverId, originalName, storedName) {
  await runAsync(
    `
      INSERT INTO driver_payment_proofs (
        driver_id,
        file_original_name,
        file_stored_name,
        created_at
      ) VALUES (?, ?, ?, datetime('now','localtime'))
    `,
    [Number(driverId), originalName || '', storedName || '']
  );
}

// ---------------- АДМИН-СТАТИСТИКА ----------------

async function getAdminStats() {
  // 1) Обычные бронирования
  const bookingStats = await getAsync(
    `
      SELECT
        COUNT(DISTINCT CASE WHEN b.status = 'booked' THEN b.trip_id END) AS trips_count,
        SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS bookings_count,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.seats_booked ELSE 0 END), 0) AS seats_booked_total,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.amount_total ELSE 0 END), 0) AS total_turnover,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.app_fee ELSE 0 END), 0) AS total_app_fee,
        COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.driver_amount ELSE 0 END), 0) AS total_driver_amount
      FROM bookings b
      WHERE 1 = 1
    `
  );

  // 2) Планы пассажиров, которые были «забраны» водителями
  let planTripsCount = 0;
  let planSeatsCount = 0;
  let planTurnoverTotal = 0;
  let planAppFeeTotal = 0;
  let planDriverAmountTotal = 0;

  try {
    const planStats = await getAsync(
      `
        SELECT
          COUNT(*) AS plans_count,
          COALESCE(SUM(seats_needed), 0) AS seats_count,
          COALESCE(SUM(amount_total), 0) AS turnover_total,
          COALESCE(SUM(app_fee), 0) AS app_fee_total,
          COALESCE(SUM(driver_amount), 0) AS driver_amount_total
        FROM passenger_plans
        WHERE status = 'taken'
      `
    );

    planTripsCount = planStats?.plans_count ? Number(planStats.plans_count) : 0;
    planSeatsCount = planStats?.seats_count ? Number(planStats.seats_count) : 0;
    planTurnoverTotal = planStats?.turnover_total ? Number(planStats.turnover_total) : 0;
    planAppFeeTotal = planStats?.app_fee_total ? Number(planStats.app_fee_total) : 0;
    planDriverAmountTotal = planStats?.driver_amount_total
      ? Number(planStats.driver_amount_total)
      : 0;
  } catch (err) {
    const msg = String(err?.message || '');
    if (!msg.includes('no such table: passenger_plans') && !msg.includes('no such column')) {
      throw err;
    }
  }

  return {
    trips_count: (bookingStats?.trips_count || 0) + planTripsCount,
    bookings_count: (bookingStats?.bookings_count || 0) + planTripsCount,
    seats_booked_total: (bookingStats?.seats_booked_total || 0) + planSeatsCount,
    total_turnover: (bookingStats?.total_turnover || 0) + planTurnoverTotal,
    total_app_fee: (bookingStats?.total_app_fee || 0) + planAppFeeTotal,
    total_driver_amount: (bookingStats?.total_driver_amount || 0) + planDriverAmountTotal,
  };
}

// Водители за выбранный день + их чеки
async function getAdminDailyDrivers(targetDate) {
  const useCustomDate = !!targetDate;
  const dateParam = targetDate || null;

  const whereBookingsDate = useCustomDate
    ? `date(b.created_at, 'localtime') = date(?, 'localtime')`
    : `date(b.created_at, 'localtime') = date('now','localtime')`;

  const wherePlansDate = useCustomDate
    ? `date(p.taken_at, 'localtime') = date(?, 'localtime')`
    : `date(p.taken_at, 'localtime') = date('now','localtime')`;

  let rows = [];
  try {
    const paramsAgg = [];
    if (useCustomDate) paramsAgg.push(dateParam, dateParam);

    rows = await allAsync(
      `
        WITH
        bookingsAgg AS (
          SELECT
            t.driver_id AS driver_id,
            COUNT(DISTINCT CASE WHEN b.status = 'booked' THEN t.id END) AS trips_from_bookings,
            SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS bookings_count,
            COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.seats_booked ELSE 0 END), 0) AS seats_count,
            COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.amount_total ELSE 0 END), 0) AS turnover_total,
            COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.app_fee ELSE 0 END), 0) AS app_fee_total,
            COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.driver_amount ELSE 0 END), 0) AS driver_amount_total
          FROM bookings b
          JOIN trips t ON t.id = b.trip_id
          WHERE ${whereBookingsDate}
          GROUP BY t.driver_id
        ),
        plansAgg AS (
          SELECT
            p.driver_id AS driver_id,
            COUNT(*) AS trips_from_plans,
            COUNT(*) AS plan_bookings_count,
            COALESCE(SUM(p.seats_needed), 0) AS plan_seats_count,
            COALESCE(SUM(p.amount_total), 0) AS plan_turnover_total,
            COALESCE(SUM(p.app_fee), 0) AS plan_app_fee_total,
            COALESCE(SUM(p.driver_amount), 0) AS plan_driver_amount_total
          FROM passenger_plans p
          WHERE p.status = 'taken'
            AND p.driver_id IS NOT NULL
            AND ${wherePlansDate}
          GROUP BY p.driver_id
        ),
        driverIds AS (
          SELECT driver_id FROM bookingsAgg
          UNION
          SELECT driver_id FROM plansAgg
        )
        SELECT
          d.id AS driver_id,
          d.telegram_id,
          d.first_name,
          d.last_name,
          d.username,
          d.is_blocked,

          (COALESCE(b.trips_from_bookings, 0) + COALESCE(p.trips_from_plans, 0)) AS trips_count,
          (COALESCE(b.bookings_count, 0) + COALESCE(p.plan_bookings_count, 0)) AS bookings_count,
          (COALESCE(b.seats_count, 0) + COALESCE(p.plan_seats_count, 0)) AS seats_count,

          (COALESCE(b.turnover_total, 0) + COALESCE(p.plan_turnover_total, 0)) AS turnover_total,
          (COALESCE(b.app_fee_total, 0) + COALESCE(p.plan_app_fee_total, 0)) AS app_fee_total,
          (COALESCE(b.driver_amount_total, 0) + COALESCE(p.plan_driver_amount_total, 0)) AS driver_amount_total
        FROM driverIds ids
        JOIN users d ON d.id = ids.driver_id
        LEFT JOIN bookingsAgg b ON b.driver_id = d.id
        LEFT JOIN plansAgg p ON p.driver_id = d.id
        ORDER BY app_fee_total DESC, bookings_count DESC
      `,
      paramsAgg
    );
  } catch (err) {
    const msg = String(err?.message || '');
    if (!msg.includes('no such table: passenger_plans') && !msg.includes('no such column')) {
      throw err;
    }

    // Fallback: только bookings (как было)
    const params = [];
    if (useCustomDate) params.push(dateParam);

    rows = await allAsync(
      `
        SELECT
          d.id AS driver_id,
          d.telegram_id,
          d.first_name,
          d.last_name,
          d.username,
          d.is_blocked,
          COUNT(DISTINCT CASE WHEN b.status = 'booked' THEN t.id END) AS trips_count,
          SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS bookings_count,
          COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.seats_booked ELSE 0 END), 0) AS seats_count,
          COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.amount_total ELSE 0 END), 0) AS turnover_total,
          COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.app_fee ELSE 0 END), 0) AS app_fee_total,
          COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.driver_amount ELSE 0 END), 0) AS driver_amount_total
        FROM bookings b
        JOIN trips t ON t.id = b.trip_id
        JOIN users d ON d.id = t.driver_id
        WHERE ${whereBookingsDate}
        GROUP BY d.id, d.telegram_id, d.first_name, d.last_name, d.username, d.is_blocked
        ORDER BY app_fee_total DESC, bookings_count DESC
      `,
      params
    );
  }

  const result = [];

  for (const row of rows) {
    let proof;
    if (useCustomDate) {
      proof = await getAsync(
        `
          SELECT file_original_name, file_stored_name
          FROM driver_payment_proofs
          WHERE driver_id = ?
            AND date(created_at, 'localtime') = date(?, 'localtime')
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [row.driver_id, dateParam]
      );
    } else {
      proof = await getAsync(
        `
          SELECT file_original_name, file_stored_name
          FROM driver_payment_proofs
          WHERE driver_id = ?
            AND date(created_at, 'localtime') = date('now','localtime')
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [row.driver_id]
      );
    }

    result.push({
      driver_id: row.driver_id,
      telegram_id: row.telegram_id,
      first_name: row.first_name,
      last_name: row.last_name,
      username: row.username,

      trips_count: row.trips_count || 0,
      bookings_count: row.bookings_count || 0,
      seats_count: row.seats_count || 0,

      turnover_total: row.turnover_total || 0,
      app_fee_total: row.app_fee_total || 0,
      driver_amount_total: row.driver_amount_total || 0,

      is_blocked: row.is_blocked || 0,
      last_proof_original_name: proof ? proof.file_original_name : null,
      last_proof_file: proof ? proof.file_stored_name : null,
    });
  }

  return result;
}


// ---------------- ЭКСПОРТ ----------------

module.exports = {
  db,

  upsertUserFromTelegram,
  getUserByTelegramId,

  createTrip,
  getLatestTrips,
  getTripWithDriver,
  getDriverTripsByTelegramId,
  deleteTripByDriver,

  getDriverProfileByTelegramId,
  updateDriverCarProfile,
  setUserBlockedByTelegramId,

  createBooking,
  getTripBookingsForDriver,
  markBookingNoShow,
  getPassengerBookingsByTelegramId,
  cancelBookingByPassenger,

  getAppSettings,
  updateAppSettings,

  getDriverDailyStats,
  hasDriverPaymentProofToday,
  saveDriverPaymentProof,

  getAdminStats,
  getAdminDailyDrivers,
};
