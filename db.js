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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (trip_id) REFERENCES trips(id),
      FOREIGN KEY (passenger_id) REFERENCES users(id)
    )
  `);

  // Миграция: добавляем поле примечания к поездке
  db.run(`ALTER TABLE trips ADD COLUMN note TEXT`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE trips (note):', err.message);
    }
  });

  // Миграция: счётчик неявок пассажира
  db.run(`ALTER TABLE users ADD COLUMN no_show_count INTEGER DEFAULT 0`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('Ошибка ALTER TABLE users (no_show_count):', err.message);
    }
  });
});

// Создание/обновление пользователя по данным Telegram
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

// Создание поездки (с примечанием note)
function createTrip({ driverId, fromCity, toCity, departureTime, seatsTotal, pricePerSeat, note }) {
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

// Последние поездки (для пассажира)
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

// Поездка + данные водителя (для уведомления)
function getTripWithDriver(tripId) {
  return new Promise((resolve, reject) => {
    db.get(
      `
        SELECT
          t.*,
          u.telegram_id AS driver_telegram_id,
          u.first_name AS driver_first_name,
          u.last_name AS driver_last_name,
          u.username AS driver_username
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

// Список поездок конкретного водителя (для истории)
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

// Бронирования по конкретной поездке (для истории/оценки пассажиров)
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

// Создание бронирования + уменьшение свободных мест
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

              db.run('BEGIN TRANSACTION', (errBegin) => {
                if (errBegin) return reject(errBegin);

                db.run(
                  `
                    INSERT INTO bookings (trip_id, passenger_id, seats_booked, status)
                    VALUES (?, ?, ?, 'booked')
                  `,
                  [tripId, passenger.id, seatsNum],
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

// Отметить бронирование как "не приехал"
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

module.exports = {
  db,
  upsertUserFromTelegram,
  createTrip,
  getLatestTrips,
  getUserByTelegramId,
  getTripWithDriver,
  getDriverTripsByTelegramId,
  getTripBookingsForDriver,
  createBooking,
  markBookingNoShow,
};
