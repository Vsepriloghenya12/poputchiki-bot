const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'poputchiki.db');
const db = new sqlite3.Database(dbPath);

// Инициализация таблиц и миграции
db.serialize(() => {
  // Пользователи Telegram
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      role TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
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
      status TEXT DEFAULT 'booked',
      amount_total REAL,
      app_fee REAL,
      driver_amount REAL,
      is_paid INTEGER DEFAULT 0,
      paid_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (trip_id) REFERENCES trips(id),
      FOREIGN KEY (passenger_id) REFERENCES users(id)
    )
  `);

  // Примечание к поездке
  db.run(`ALTER TABLE trips ADD COLUMN note TEXT`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE trips (note):', err.message);
    }
  });

  // Счётчик неявок
  db.run(`ALTER TABLE users ADD COLUMN no_show_count INTEGER DEFAULT 0`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE users (no_show_count):', err.message);
    }
  });

  // Данные машины
  db.run(`ALTER TABLE users ADD COLUMN car_make TEXT`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE users (car_make):', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN car_color TEXT`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE users (car_color):', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN car_plate TEXT`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE users (car_plate):', err.message);
    }
  });

  // Платёжные поля
  db.run(`ALTER TABLE bookings ADD COLUMN amount_total REAL`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE bookings (amount_total):', err.message);
    }
  });
  db.run(`ALTER TABLE bookings ADD COLUMN app_fee REAL`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE bookings (app_fee):', err.message);
    }
  });
  db.run(`ALTER TABLE bookings ADD COLUMN driver_amount REAL`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE bookings (driver_amount):', err.message);
    }
  });
  db.run(`ALTER TABLE bookings ADD COLUMN is_paid INTEGER DEFAULT 0`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE bookings (is_paid):', err.message);
    }
  });
  db.run(`ALTER TABLE bookings ADD COLUMN paid_at TEXT`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE bookings (paid_at):', err.message);
    }
  });

  // Глобальные настройки приложения (платный режим, реквизиты)
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monetization_enabled INTEGER DEFAULT 0,
      payment_details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.get(`SELECT COUNT(*) AS cnt FROM app_settings`, [], (err, row) => {
    if (err) {
      console.error('Ошибка SELECT app_settings:', err.message);
      return;
    }
    if (!row || row.cnt === 0) {
      db.run(
        `INSERT INTO app_settings (id, monetization_enabled, payment_details)
         VALUES (1, 0, '')`,
        (err2) => {
          if (err2) {
            console.error('Ошибка INSERT app_settings:', err2.message);
          }
        }
      );
    }
  });

  // Файлы чеков водителей
  db.run(`
    CREATE TABLE IF NOT EXISTS driver_payment_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER NOT NULL,
      original_name TEXT,
      stored_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES users(id)
    )
  `);
});

// -------- Пользователи --------

function upsertUserFromTelegram(user) {
  return new Promise((resolve, reject) => {
    if (!user || !user.id) {
      return reject(new Error('Некорректный объект user'));
    }

    const telegramId = String(user.id);
    const firstName = user.first_name || null;
    const lastName = user.last_name || null;
    const username = user.username || null;

    db.run(
      `
        INSERT INTO users (telegram_id, first_name, last_name, username)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          username = excluded.username
      `,
      [telegramId, firstName, lastName, username],
      function (err) {
        if (err) return reject(err);

        db.get(
          `SELECT * FROM users WHERE telegram_id = ?`,
          [telegramId],
          (err2, row) => {
            if (err2) return reject(err2);
            resolve(row);
          }
        );
      }
    );
  });
}

function getUserByTelegramId(telegramId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM users WHERE telegram_id = ?`,
      [String(telegramId)],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

function getDriverProfileByTelegramId(telegramId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
        SELECT
          id,
          telegram_id,
          first_name,
          last_name,
          username,
          no_show_count,
          car_make,
          car_color,
          car_plate
        FROM users
        WHERE telegram_id = ?
      `,
      [String(telegramId)],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

function updateDriverCarProfile(telegramId, { carMake, carColor, carPlate }) {
  return new Promise((resolve, reject) => {
    db.run(
      `
        UPDATE users
        SET car_make = ?, car_color = ?, car_plate = ?
        WHERE telegram_id = ?
      `,
      [carMake || null, carColor || null, carPlate || null, String(telegramId)],
      (err) => {
        if (err) return reject(err);

        getDriverProfileByTelegramId(telegramId)
          .then((row) => resolve(row))
          .catch(reject);
      }
    );
  });
}

// -------- Настройки приложения --------

function getAppSettings() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM app_settings WHERE id = 1`,
      [],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || { monetization_enabled: 0, payment_details: '' });
      }
    );
  });
}

function updateAppSettings({ monetizationEnabled, paymentDetails }) {
  return new Promise((resolve, reject) => {
    const enabledInt = monetizationEnabled ? 1 : 0;
    db.run(
      `
        UPDATE app_settings
        SET monetization_enabled = ?,
            payment_details = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `,
      [enabledInt, paymentDetails || ''],
      (err) => {
        if (err) return reject(err);
        getAppSettings().then(resolve).catch(reject);
      }
    );
  });
}

// -------- Поездки --------

function createTrip({
  driverId,
  fromCity,
  toCity,
  departureTime,
  seatsTotal,
  pricePerSeat,
  note,
}) {
  return new Promise((resolve, reject) => {
    const seatsTotalNum = Number(seatsTotal);
    const priceNum = Number(pricePerSeat);
    const noteText = note || null;

    db.run(
      `
        INSERT INTO trips (
          driver_id, from_city, to_city,
          departure_time, seats_total, seats_available, price_per_seat, note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [driverId, fromCity, toCity, departureTime, seatsTotalNum, seatsTotalNum, priceNum, noteText],
      function (err) {
        if (err) return reject(err);

        const id = this.lastID;
        db.get(`SELECT * FROM trips WHERE id = ?`, [id], (err2, row) => {
          if (err2) return reject(err2);
          resolve(row);
        });
      }
    );
  });
}

// Список для пассажира
function getLatestTrips(limit = 20) {
  return new Promise((resolve, reject) => {
    db.all(
      `
        SELECT t.*, u.first_name, u.last_name, u.username
        FROM trips t
        JOIN users u ON u.id = t.driver_id
        ORDER BY t.created_at DESC
        LIMIT ?
      `,
      [limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

// Поездка + водитель
function getTripWithDriver(tripId) {
  return new Promise((resolve, reject) => {
    db.get(
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
      [tripId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

// Поездки водителя
function getDriverTripsByTelegramId(telegramId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
        SELECT
          t.*,
          (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id) AS bookings_count
        FROM trips t
        JOIN users u ON u.id = t.driver_id
        WHERE u.telegram_id = ?
        ORDER BY t.departure_time DESC
      `,
      [String(telegramId)],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

// -------- Бронирования --------

function getTripBookingsForDriver(tripId, driverId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
        SELECT
          b.*,
          p.first_name AS passenger_first_name,
          p.last_name AS passenger_last_name,
          p.username AS passenger_username,
          COALESCE(p.no_show_count, 0) AS passenger_no_show_count
        FROM bookings b
        JOIN trips t ON t.id = b.trip_id
        JOIN users p ON p.id = b.passenger_id
        WHERE b.trip_id = ? AND t.driver_id = ?
        ORDER BY b.created_at DESC
      `,
      [tripId, driverId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

// Создание бронирования + расчёт денег
function createBooking({ tripId, passengerTelegramId, seatsBooked }) {
  return new Promise((resolve, reject) => {
    const seatsNum = Number(seatsBooked);

    if (!Number.isFinite(seatsNum) || seatsNum <= 0) {
      const err = new Error('Некорректное количество мест');
      err.code = 'BAD_SEATS';
      return reject(err);
    }

    db.serialize(() => {
      db.get(
        `SELECT * FROM users WHERE telegram_id = ?`,
        [String(passengerTelegramId)],
        (errUser, passenger) => {
          if (errUser) return reject(errUser);
          if (!passenger) {
            const err = new Error('Пассажир не найден');
            err.code = 'PASSENGER_NOT_FOUND';
            return reject(err);
          }

          db.get(
            `SELECT * FROM trips WHERE id = ?`,
            [tripId],
            (errTrip, trip) => {
              if (errTrip) return reject(errTrip);
              if (!trip) {
                const err = new Error('Поездка не найдена');
                err.code = 'TRIP_NOT_FOUND';
                return reject(err);
              }

              if (trip.seats_available < seatsNum) {
                const err = new Error('Недостаточно свободных мест');
                err.code = 'NOT_ENOUGH_SEATS';
                return reject(err);
              }

              const price = Number(trip.price_per_seat) || 0;
              const amountTotal = price * seatsNum;
              const feePct = Number(process.env.SERVICE_FEE_PCT || 0);
              let appFee = amountTotal * feePct / 100;
              appFee = Math.round(appFee * 100) / 100;
              let driverAmount = amountTotal - appFee;
              driverAmount = Math.round(driverAmount * 100) / 100;

              db.run('BEGIN TRANSACTION', (errBegin) => {
                if (errBegin) return reject(errBegin);

                db.run(
                  `
                    INSERT INTO bookings (
                      trip_id,
                      passenger_id,
                      seats_booked,
                      status,
                      amount_total,
                      app_fee,
                      driver_amount,
                      is_paid
                    )
                    VALUES (?, ?, ?, 'booked', ?, ?, ?, 0)
                  `,
                  [tripId, passenger.id, seatsNum, amountTotal, appFee, driverAmount],
                  function (errIns) {
                    if (errIns) {
                      db.run('ROLLBACK');
                      return reject(errIns);
                    }

                    const bookingId = this.lastID;

                    db.run(
                      `
                        UPDATE trips
                        SET seats_available = seats_available - ?
                        WHERE id = ?
                      `,
                      [seatsNum, tripId],
                      (errUpd) => {
                        if (errUpd) {
                          db.run('ROLLBACK');
                          return reject(errUpd);
                        }

                        db.run('COMMIT', (errCommit) => {
                          if (errCommit) return reject(errCommit);

                          db.get(
                            `SELECT * FROM bookings WHERE id = ?`,
                            [bookingId],
                            (errBooking, bookingRow) => {
                              if (errBooking) return reject(errBooking);
                              resolve({ booking: bookingRow, trip, passenger });
                            }
                          );
                        });
                      }
                    );
                  }
                );
              });
            }
          );
        }
      );
    });
  });
}

// Отметить "не приехал"
function markBookingNoShow({ bookingId, driverId }) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.get(
        `
          SELECT
            b.*,
            t.driver_id,
            p.id AS passenger_id
          FROM bookings b
          JOIN trips t ON t.id = b.trip_id
          JOIN users p ON p.id = b.passenger_id
          WHERE b.id = ?
        `,
        [bookingId],
        (err, row) => {
          if (err) return reject(err);
          if (!row) {
            const e = new Error('Бронирование не найдено');
            e.code = 'BOOKING_NOT_FOUND';
            return reject(e);
          }

          if (row.driver_id !== driverId) {
            const e = new Error('Нет прав на изменение этого бронирования');
            e.code = 'FORBIDDEN';
            return reject(e);
          }

          if (row.status === 'no_show') {
            return resolve(row);
          }

          db.run('BEGIN TRANSACTION', (errBegin) => {
            if (errBegin) return reject(errBegin);

            db.run(
              `UPDATE bookings SET status = 'no_show' WHERE id = ?`,
              [bookingId],
              (errUpd) => {
                if (errUpd) {
                  db.run('ROLLBACK');
                  return reject(errUpd);
                }

                db.run(
                  `
                    UPDATE users
                    SET no_show_count = COALESCE(no_show_count, 0) + 1
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

// -------- Дневная статистика водителя + чеки --------

function getDriverDailyStats(driverId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
        SELECT
          COUNT(DISTINCT t.id) AS trips_count,
          COUNT(b.id) AS bookings_count,
          COALESCE(SUM(b.seats_booked), 0) AS seats_count,
          COALESCE(SUM(b.app_fee), 0) AS app_fee_total
        FROM bookings b
        JOIN trips t ON t.id = b.trip_id
        WHERE t.driver_id = ?
          AND b.status = 'booked'
          AND DATE(b.created_at, 'localtime') = DATE('now', 'localtime')
      `,
      [driverId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || {
          trips_count: 0,
          bookings_count: 0,
          seats_count: 0,
          app_fee_total: 0,
        });
      }
    );
  });
}

function hasDriverPaymentProofToday(driverId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
        SELECT 1
        FROM driver_payment_files
        WHERE driver_id = ?
          AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
        LIMIT 1
      `,
      [driverId],
      (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      }
    );
  });
}

function saveDriverPaymentProof(driverId, originalName, storedName) {
  return new Promise((resolve, reject) => {
    db.run(
      `
        INSERT INTO driver_payment_files (driver_id, original_name, stored_name)
        VALUES (?, ?, ?)
      `,
      [driverId, originalName, storedName],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID });
      }
    );
  });
}

// -------- Статистика для владельца --------

function getAdminStats() {
  return new Promise((resolve, reject) => {
    db.get(
      `
        SELECT
          COUNT(DISTINCT trip_id) AS trips_count,
          COUNT(*) AS bookings_count,
          COALESCE(SUM(seats_booked), 0) AS seats_booked_total,
          COALESCE(SUM(amount_total), 0) AS total_turnover,
          COALESCE(SUM(app_fee), 0) AS total_app_fee,
          COALESCE(SUM(driver_amount), 0) AS total_driver_amount
        FROM bookings
        WHERE status = 'booked'
      `,
      [],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

// Водители за сегодня + их чеки
function getAdminDailyDrivers() {
  return new Promise((resolve, reject) => {
    db.all(
      `
        SELECT
          u.id AS driver_id,
          u.telegram_id,
          u.first_name,
          u.last_name,
          u.username,
          COUNT(DISTINCT t.id) AS trips_count,
          COUNT(b.id) AS bookings_count,
          COALESCE(SUM(b.seats_booked), 0) AS seats_count,
          COALESCE(SUM(b.app_fee), 0) AS app_fee_total,
          (
            SELECT stored_name
            FROM driver_payment_files f
            WHERE f.driver_id = u.id
              AND DATE(f.created_at, 'localtime') = DATE('now', 'localtime')
            ORDER BY f.created_at DESC
            LIMIT 1
          ) AS last_proof_file,
          (
            SELECT original_name
            FROM driver_payment_files f
            WHERE f.driver_id = u.id
              AND DATE(f.created_at, 'localtime') = DATE('now', 'localtime')
            ORDER BY f.created_at DESC
            LIMIT 1
          ) AS last_proof_original_name
        FROM bookings b
        JOIN trips t ON t.id = b.trip_id
        JOIN users u ON u.id = t.driver_id
        WHERE b.status = 'booked'
          AND DATE(b.created_at, 'localtime') = DATE('now', 'localtime')
        GROUP BY
          u.id, u.telegram_id, u.first_name, u.last_name, u.username
        ORDER BY app_fee_total DESC
      `,
      [],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

module.exports = {
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
};
