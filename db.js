const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'poputchiki.db');
const db = new sqlite3.Database(dbPath);

// Инициализация таблиц
db.serialize(() => {
  // Пользователи Telegram
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      role TEXT,          -- 'driver' или 'passenger' (на будущее)
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
      departure_time TEXT NOT NULL,      -- ISO-строка
      seats_total INTEGER NOT NULL,
      seats_available INTEGER NOT NULL,
      price_per_seat REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES users(id)
    )
  `);

  // Бронирования (на будущее)
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL,
      passenger_id INTEGER NOT NULL,
      seats_booked INTEGER NOT NULL,
      status TEXT DEFAULT 'booked',      -- 'booked','cancelled','paid' и т.п.
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (trip_id) REFERENCES trips(id),
      FOREIGN KEY (passenger_id) REFERENCES users(id)
    )
  `);
});

// Утилита для получения/создания пользователя по telegram_id
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

// Создание поездки
function createTrip({ driverId, fromCity, toCity, departureTime, seatsTotal, pricePerSeat }) {
  return new Promise((resolve, reject) => {
    const seatsTotalNum = Number(seatsTotal);
    const priceNum = Number(pricePerSeat);

    db.run(
      `
        INSERT INTO trips (
          driver_id, from_city, to_city,
          departure_time, seats_total, seats_available, price_per_seat
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [driverId, fromCity, toCity, departureTime, seatsTotalNum, seatsTotalNum, priceNum],
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

// Получение последних поездок (для пассажира)
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

// Поиск пользователя по telegram_id
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

module.exports = {
  db,
  upsertUserFromTelegram,
  createTrip,
  getLatestTrips,
  getUserByTelegramId,
};
