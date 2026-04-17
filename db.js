
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const DEFAULT_DB_PATH = path.join(__dirname, 'poputchiki.db');
const DB_PATH = path.resolve(process.env.SQLITE_PATH || DEFAULT_DB_PATH);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new sqlite3.Database(DB_PATH);

function softMigrate(sql) {
  db.run(sql, (err) => {
    if (!err) return;
    const msg = String(err.message || '');
    if (msg.includes('duplicate column name') || msg.includes('already exists')) return;
    console.warn('SQLite migration warning:', msg);
  });
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      language_code TEXT,
      no_show_count INTEGER DEFAULT 0,
      car_make TEXT,
      car_color TEXT,
      car_plate TEXT,
      is_blocked INTEGER DEFAULT 0,
      auth_provider TEXT NOT NULL DEFAULT 'telegram',
      contact_phone TEXT,
      rating_sum INTEGER NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0,
      rating_avg REAL NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS standalone_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      "key" TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_kv_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_type TEXT NOT NULL,
      context_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      recipient_id INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      read_at TEXT,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_context
    ON chat_messages (context_type, context_id, id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient
    ON chat_messages (recipient_id, read_at)
  `);

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

  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL,
      passenger_id INTEGER NOT NULL,
      seats_booked INTEGER NOT NULL,
      amount_total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (trip_id) REFERENCES trips(id),
      FOREIGN KEY (passenger_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS passenger_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      passenger_id INTEGER NOT NULL,
      from_city TEXT NOT NULL,
      to_city TEXT NOT NULL,
      desired_time TEXT NOT NULL,
      seats_needed INTEGER NOT NULL,
      price_per_seat REAL NOT NULL DEFAULT 0,
      amount_total REAL NOT NULL DEFAULT 0,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      driver_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      taken_at TEXT,
      FOREIGN KEY (passenger_id) REFERENCES users(id),
      FOREIGN KEY (driver_id) REFERENCES users(id)
    )
  `);

  [
    "ALTER TABLE passenger_plans ADD COLUMN price_per_seat REAL NOT NULL DEFAULT 0",
    "ALTER TABLE passenger_plans ADD COLUMN amount_total REAL NOT NULL DEFAULT 0",
    "ALTER TABLE passenger_plans ADD COLUMN note TEXT",
    "ALTER TABLE passenger_plans ADD COLUMN driver_id INTEGER",
    "ALTER TABLE passenger_plans ADD COLUMN taken_at TEXT",
    "ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'telegram'",
    "ALTER TABLE users ADD COLUMN contact_phone TEXT",
    "ALTER TABLE users ADD COLUMN rating_sum INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN rating_avg REAL NOT NULL DEFAULT 0"
  ].forEach(softMigrate);

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_contact_phone
    ON users (contact_phone)
    WHERE contact_phone IS NOT NULL AND trim(contact_phone) <> ''
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_users_username_lower
    ON users (lower(username))
    WHERE username IS NOT NULL AND trim(username) <> ''
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_passenger_plans_status_time
    ON passenger_plans (status, desired_time)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ride_confirmations (
      context_type TEXT NOT NULL,
      context_id INTEGER NOT NULL,
      driver_confirmed_at TEXT,
      passenger_confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (context_type, context_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_type TEXT NOT NULL,
      context_id INTEGER NOT NULL,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      tags TEXT,
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE (context_type, context_id, from_user_id),
      FOREIGN KEY (from_user_id) REFERENCES users(id),
      FOREIGN KEY (to_user_id) REFERENCES users(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_reviews_to_user ON reviews(to_user_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      subscription_json TEXT NOT NULL,
      user_agent TEXT,
      platform TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
    ON push_subscriptions (user_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS autopost_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL UNIQUE,
      title TEXT,
      type TEXT,
      username TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      added_by_telegram_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_autopost_chats_active
    ON autopost_chats (is_active, title)
  `);
});

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
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

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 11 && digits.startsWith('8')) {
    return `+7${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    return `+7${digits}`;
  }

  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  return '';
}

function normalizeTelegramUsername(username) {
  const value = String(username || '').trim().replace(/^@/, '');
  if (!value) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value)) return '';
  return value;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !hash) return false;

  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const left = Buffer.from(derived, 'hex');
  const right = Buffer.from(hash, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

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
  } = tgUser;

  const telegramId = String(id);
  const normalizedUsername = normalizeTelegramUsername(username);
  const existing = await getAsync(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId]);

  if (existing) {
    await runAsync(
      `
        UPDATE users
        SET first_name = ?, last_name = ?, username = ?, language_code = ?, auth_provider = 'telegram'
        WHERE telegram_id = ?
      `,
      [
        first_name || null,
        last_name || null,
        normalizedUsername || null,
        language_code || null,
        telegramId,
      ]
    );

    return getAsync(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId]);
  }

  const standaloneMatch = normalizedUsername
    ? await getAsync(
      `
        SELECT *
        FROM users
        WHERE lower(username) = lower(?)
          AND auth_provider = 'standalone'
          AND telegram_id LIKE 'app_%'
        LIMIT 1
      `,
      [normalizedUsername]
    )
    : null;

  if (standaloneMatch?.id) {
    await runAsync(
      `
        UPDATE users
        SET telegram_id = ?,
          first_name = ?,
          last_name = ?,
          username = ?,
          language_code = ?,
          auth_provider = 'telegram'
        WHERE id = ?
      `,
      [
        telegramId,
        first_name || standaloneMatch.first_name || null,
        last_name || standaloneMatch.last_name || null,
        normalizedUsername,
        language_code || null,
        standaloneMatch.id,
      ]
    );

    return getAsync(`SELECT * FROM users WHERE id = ?`, [standaloneMatch.id]);
  }

  await runAsync(
    `
      INSERT INTO users (
        telegram_id, first_name, last_name, username, language_code, auth_provider
      ) VALUES (?, ?, ?, ?, ?, 'telegram')
    `,
    [
      telegramId,
      first_name || null,
      last_name || null,
      normalizedUsername || null,
      language_code || null,
    ]
  );

  return getAsync(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId]);
}

async function createStandaloneUser({ firstName, lastName, username, phone, password }) {
  const normalizedPhone = normalizePhone(phone);
  const normalizedUsername = normalizeTelegramUsername(username);
  const passwordValue = String(password || '');

  if (!String(firstName || '').trim()) {
    const error = new Error('Введите имя');
    error.code = 'BAD_INPUT';
    throw error;
  }

  if (!normalizedPhone) {
    const error = new Error('Введите корректный номер телефона');
    error.code = 'BAD_INPUT';
    throw error;
  }

  if (!normalizedUsername) {
    const error = new Error('Введите Telegram username в формате @username');
    error.code = 'BAD_INPUT';
    throw error;
  }

  if (passwordValue.length < 6) {
    const error = new Error('Пароль должен быть не короче 6 символов');
    error.code = 'BAD_INPUT';
    throw error;
  }

  const existing = await getAsync(
    `
      SELECT u.*
      FROM standalone_accounts s
      JOIN users u ON u.id = s.user_id
      WHERE s.phone = ?
    `,
    [normalizedPhone]
  );
  if (existing) {
    const error = new Error('Аккаунт с таким номером уже существует');
    error.code = 'PHONE_EXISTS';
    throw error;
  }

  const existingUsername = await getAsync(
    `
      SELECT
        u.*,
        s.id AS standalone_account_id
      FROM users u
      LEFT JOIN standalone_accounts s ON s.user_id = u.id
      WHERE lower(u.username) = lower(?)
      LIMIT 1
    `,
    [normalizedUsername]
  );

  const existingContactPhone = await getAsync(
    `
      SELECT *
      FROM users
      WHERE contact_phone = ?
      LIMIT 1
    `,
    [normalizedPhone]
  );
  if (existingContactPhone && Number(existingContactPhone.id) !== Number(existingUsername?.id || 0)) {
    const error = new Error('Аккаунт с таким номером уже существует');
    error.code = 'PHONE_EXISTS';
    throw error;
  }

  const accountId = `app_${crypto.randomBytes(12).toString('hex')}`;
  const passwordHash = hashPassword(passwordValue);

  if (existingUsername?.standalone_account_id) {
    const error = new Error('Аккаунт с таким Telegram username уже существует');
    error.code = 'USERNAME_EXISTS';
    throw error;
  }

  if (existingUsername?.id) {
    await runAsync(
      `
        UPDATE users
        SET first_name = COALESCE(NULLIF(first_name, ''), ?),
          last_name = COALESCE(NULLIF(last_name, ''), ?),
          username = ?,
          contact_phone = ?
        WHERE id = ?
      `,
      [
        String(firstName || '').trim(),
        String(lastName || '').trim() || null,
        normalizedUsername,
        normalizedPhone,
        existingUsername.id,
      ]
    );

    await runAsync(
      `
        INSERT INTO standalone_accounts (
          user_id,
          phone,
          password_hash,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
      `,
      [existingUsername.id, normalizedPhone, passwordHash]
    );

    return getAsync(`SELECT * FROM users WHERE id = ?`, [existingUsername.id]);
  }

  await runAsync(
    `
      INSERT INTO users (
        telegram_id,
        first_name,
        last_name,
        username,
        auth_provider,
        contact_phone
      ) VALUES (?, ?, ?, ?, 'standalone', ?)
    `,
    [
      accountId,
      String(firstName || '').trim(),
      String(lastName || '').trim() || null,
      normalizedUsername,
      normalizedPhone,
    ]
  );

  const user = await getAsync(`SELECT * FROM users WHERE telegram_id = ?`, [accountId]);
  if (!user?.id) {
    throw new Error('Не удалось создать пользователя');
  }

  await runAsync(
    `
      INSERT INTO standalone_accounts (
        user_id,
        phone,
        password_hash,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
    `,
    [user.id, normalizedPhone, passwordHash]
  );

  return getAsync(`SELECT * FROM users WHERE id = ?`, [user.id]);
}

async function authenticateStandaloneUser({ phone, password }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || !String(password || '')) return null;

  const row = await getAsync(
    `
      SELECT
        u.*,
        s.password_hash
      FROM standalone_accounts s
      JOIN users u ON u.id = s.user_id
      WHERE s.phone = ?
    `,
    [normalizedPhone]
  );

  if (!row?.password_hash || !verifyPassword(password, row.password_hash)) {
    return null;
  }

  delete row.password_hash;
  return row;
}

function getUserByTelegramId(telegramId) {
  return getAsync(`SELECT * FROM users WHERE telegram_id = ?`, [String(telegramId)]);
}

function getUserById(userId) {
  return getAsync(`SELECT * FROM users WHERE id = ?`, [Number(userId)]);
}

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
    rating_avg: user.rating_avg || 0,
    rating_count: user.rating_count || 0,
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

  if (!fromCity || !toCity || !departureTime) {
    const err = new Error('Не заполнены обязательные поля поездки');
    err.code = 'BAD_INPUT';
    throw err;
  }

  if (!Number.isFinite(seatsTotalNum) || seatsTotalNum <= 0) {
    const err = new Error('Некорректное число мест');
    err.code = 'BAD_INPUT';
    throw err;
  }

  if (!Number.isFinite(pricePerSeatNum) || pricePerSeatNum < 0) {
    const err = new Error('Некорректная цена за место');
    err.code = 'BAD_INPUT';
    throw err;
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
        note,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    `,
    [
      Number(driverId),
      String(fromCity).trim(),
      String(toCity).trim(),
      String(departureTime).trim(),
      seatsTotalNum,
      seatsTotalNum,
      pricePerSeatNum,
      note ? String(note).trim() : null,
    ]
  );

  return getAsync(`SELECT * FROM trips WHERE rowid = last_insert_rowid()`);
}

async function getLatestTrips(limit = 50) {
  return allAsync(
    `
      SELECT
        t.*,
        u.telegram_id AS driver_telegram_id,
        u.first_name,
        u.last_name,
        u.username,
        u.car_make,
        u.car_color,
        u.car_plate,
        u.rating_avg,
        u.rating_count,
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
    [Number(limit)]
  );
}

async function getTripWithDriver(tripId) {
  return getAsync(
    `
      SELECT
        t.*,
        u.telegram_id AS driver_telegram_id,
        u.first_name AS driver_first_name,
        u.last_name AS driver_last_name,
        u.username AS driver_username,
        u.car_make,
        u.car_color,
        u.car_plate,
        u.rating_avg,
        u.rating_count
      FROM trips t
      JOIN users u ON u.id = t.driver_id
      WHERE t.id = ?
    `,
    [Number(tripId)]
  );
}

async function getDriverTripsByTelegramId(telegramId) {
  return allAsync(
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
}

function deleteTripByDriver(tripId, driverId) {
  return new Promise((resolve, reject) => {
    const tripIdNum = Number(tripId);
    const driverIdNum = Number(driverId);

    db.get(`SELECT * FROM trips WHERE id = ?`, [tripIdNum], (err, trip) => {
      if (err) return reject(err);
      if (!trip) {
        const error = new Error('Поездка не найдена');
        error.code = 'TRIP_NOT_FOUND';
        return reject(error);
      }
      if (trip.driver_id !== driverIdNum) {
        const error = new Error('Нет прав на удаление этой поездки');
        error.code = 'FORBIDDEN';
        return reject(error);
      }

      const departureTs = Date.parse(trip.departure_time);
      if (Number.isFinite(departureTs) && Date.now() >= departureTs) {
        const error = new Error('Нельзя отменить поездку после её начала');
        error.code = 'TOO_LATE';
        return reject(error);
      }

      db.get(`SELECT COUNT(*) AS cnt FROM bookings WHERE trip_id = ?`, [tripIdNum], (countErr, row) => {
        if (countErr) return reject(countErr);
        if ((row && row.cnt) > 0) {
          const error = new Error('Нельзя удалить поездку, по которой уже есть бронирования');
          error.code = 'HAS_BOOKINGS';
          return reject(error);
        }

        db.run(`DELETE FROM trips WHERE id = ?`, [tripIdNum], (deleteErr) => {
          if (deleteErr) return reject(deleteErr);
          resolve(trip);
        });
      });
    });
  });
}

async function createBooking({ tripId, passengerTelegramId, seatsBooked }) {
  const trip = await getAsync(`SELECT * FROM trips WHERE id = ?`, [Number(tripId)]);
  if (!trip) {
    const error = new Error('Поездка не найдена');
    error.code = 'TRIP_NOT_FOUND';
    throw error;
  }

  const seatsNum = Number(seatsBooked);
  if (!Number.isFinite(seatsNum) || seatsNum <= 0) {
    const error = new Error('Некорректное количество мест');
    error.code = 'BAD_SEATS';
    throw error;
  }

  if (trip.seats_available < seatsNum) {
    const error = new Error('Недостаточно свободных мест');
    error.code = 'NOT_ENOUGH_SEATS';
    throw error;
  }

  const passenger = await getUserByTelegramId(passengerTelegramId);
  if (!passenger) {
    const error = new Error('Пассажир не найден');
    error.code = 'PASSENGER_NOT_FOUND';
    throw error;
  }

  const amountTotal = toNumber(trip.price_per_seat) * seatsNum;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (beginErr) => {
        if (beginErr) return reject(beginErr);

        db.run(
          `
            INSERT INTO bookings (
              trip_id,
              passenger_id,
              seats_booked,
              amount_total,
              status,
              created_at
            ) VALUES (?, ?, ?, ?, 'booked', datetime('now','localtime'))
          `,
          [trip.id, passenger.id, seatsNum, amountTotal],
          function onInsert(insertErr) {
            if (insertErr) {
              db.run('ROLLBACK');
              return reject(insertErr);
            }

            const bookingId = this.lastID;
            db.run(
              `UPDATE trips SET seats_available = seats_available - ? WHERE id = ?`,
              [seatsNum, trip.id],
              (updateErr) => {
                if (updateErr) {
                  db.run('ROLLBACK');
                  return reject(updateErr);
                }

                db.run('COMMIT', async (commitErr) => {
                  if (commitErr) return reject(commitErr);

                  try {
                    const booking = await getAsync(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
                    resolve({ booking, trip, passenger });
                  } catch (loadErr) {
                    reject(loadErr);
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

async function getTripBookingsForDriver(tripId, driverId) {
  return allAsync(
    `
      SELECT
        b.*,
        p.telegram_id AS passenger_telegram_id,
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
}

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
            const error = new Error('Бронирование не найдено');
            error.code = 'BOOKING_NOT_FOUND';
            return reject(error);
          }
          if (row.driver_id !== driverIdNum) {
            const error = new Error('Нет прав на изменение этого бронирования');
            error.code = 'FORBIDDEN';
            return reject(error);
          }

          db.run('BEGIN TRANSACTION', (beginErr) => {
            if (beginErr) return reject(beginErr);

            db.run(`UPDATE bookings SET status = 'no_show' WHERE id = ?`, [bookingIdNum], (statusErr) => {
              if (statusErr) {
                db.run('ROLLBACK');
                return reject(statusErr);
              }

              db.run(
                `UPDATE users SET no_show_count = no_show_count + 1 WHERE id = ?`,
                [row.passenger_id],
                (userErr) => {
                  if (userErr) {
                    db.run('ROLLBACK');
                    return reject(userErr);
                  }

                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) return reject(commitErr);
                    resolve(row);
                  });
                }
              );
            });
          });
        }
      );
    });
  });
}

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
        d.username AS driver_username,
        d.car_make AS driver_car_make,
        d.car_color AS driver_car_color,
        d.car_plate AS driver_car_plate,
        d.rating_avg AS driver_rating_avg,
        d.rating_count AS driver_rating_count
      FROM bookings b
      JOIN users p ON p.id = b.passenger_id
      JOIN trips t ON t.id = b.trip_id
      JOIN users d ON d.id = t.driver_id
      WHERE p.telegram_id = ?
      ORDER BY datetime(t.departure_time) DESC
    `,
    [String(telegramId)]
  );
}

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
            const error = new Error('Бронирование не найдено');
            error.code = 'BOOKING_NOT_FOUND';
            return reject(error);
          }
          if (row.passenger_id !== passengerIdNum) {
            const error = new Error('Нет прав на отмену этого бронирования');
            error.code = 'FORBIDDEN';
            return reject(error);
          }
          if (row.status !== 'booked') {
            const error = new Error('Это бронирование нельзя отменить');
            error.code = 'BAD_STATUS';
            return reject(error);
          }

          const departureTs = Date.parse(row.departure_time);
          if (Number.isFinite(departureTs) && Date.now() >= departureTs) {
            const error = new Error('Нельзя отменить бронь после начала поездки');
            error.code = 'TOO_LATE';
            return reject(error);
          }

          db.run('BEGIN TRANSACTION', (beginErr) => {
            if (beginErr) return reject(beginErr);

            db.run(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`, [bookingIdNum], (updateErr) => {
              if (updateErr) {
                db.run('ROLLBACK');
                return reject(updateErr);
              }

              db.run(
                `UPDATE trips SET seats_available = seats_available + ? WHERE id = ?`,
                [row.seats_booked, row.trip_id],
                (tripErr) => {
                  if (tripErr) {
                    db.run('ROLLBACK');
                    return reject(tripErr);
                  }

                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) return reject(commitErr);
                    resolve(row);
                  });
                }
              );
            });
          });
        }
      );
    });
  });
}
async function getPassengerPlanById(planId) {
  return getAsync(
    `
      SELECT
        p.*,
        pu.telegram_id AS passenger_telegram_id,
        pu.first_name AS passenger_first_name,
        pu.last_name AS passenger_last_name,
        pu.username AS passenger_username,
        pu.no_show_count AS passenger_no_show_count,
        du.telegram_id AS driver_telegram_id,
        du.first_name AS driver_first_name,
        du.last_name AS driver_last_name,
        du.username AS driver_username,
        du.car_make AS driver_car_make,
        du.car_color AS driver_car_color,
        du.car_plate AS driver_car_plate,
        du.rating_avg AS driver_rating_avg,
        du.rating_count AS driver_rating_count
      FROM passenger_plans p
      JOIN users pu ON pu.id = p.passenger_id
      LEFT JOIN users du ON du.id = p.driver_id
      WHERE p.id = ?
    `,
    [Number(planId)]
  );
}

async function createPassengerPlan({
  passengerId,
  fromCity,
  toCity,
  desiredTime,
  seatsNeeded,
  pricePerSeat,
  note,
}) {
  const seatsNum = Number(seatsNeeded);
  const priceNum = Number(pricePerSeat);

  if (!fromCity || !toCity || !desiredTime || !Number.isFinite(seatsNum) || seatsNum <= 0) {
    const error = new Error('Не все данные для плана поездки переданы');
    error.code = 'BAD_INPUT';
    throw error;
  }

  if (!Number.isFinite(priceNum) || priceNum < 0) {
    const error = new Error('Некорректная цена за место');
    error.code = 'BAD_INPUT';
    throw error;
  }

  const amountTotal = priceNum * seatsNum;

  await runAsync(
    `
      INSERT INTO passenger_plans (
        passenger_id,
        from_city,
        to_city,
        desired_time,
        seats_needed,
        price_per_seat,
        amount_total,
        note,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now','localtime'))
    `,
    [
      Number(passengerId),
      String(fromCity).trim(),
      String(toCity).trim(),
      String(desiredTime).trim(),
      seatsNum,
      priceNum,
      amountTotal,
      note ? String(note).trim() : null,
    ]
  );

  return getAsync(
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
}

async function getPassengerPlansByTelegramId(telegramId) {
  return allAsync(
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
        d.username AS driver_username,
        d.car_make AS driver_car_make,
        d.car_color AS driver_car_color,
        d.car_plate AS driver_car_plate
      FROM passenger_plans p
      JOIN users u ON u.id = p.passenger_id
      LEFT JOIN users d ON d.id = p.driver_id
      WHERE u.telegram_id = ?
      ORDER BY datetime(p.desired_time) DESC, p.id DESC
    `,
    [String(telegramId)]
  );
}

async function cancelPassengerPlan({ planId, passengerId }) {
  const plan = await getAsync(`SELECT * FROM passenger_plans WHERE id = ?`, [Number(planId)]);
  if (!plan) {
    const error = new Error('Запланированная поездка не найдена');
    error.code = 'PLAN_NOT_FOUND';
    throw error;
  }
  if (plan.passenger_id !== Number(passengerId)) {
    const error = new Error('Нет прав на отмену этой поездки');
    error.code = 'FORBIDDEN';
    throw error;
  }
  if (plan.status !== 'active') {
    const error = new Error('Эту поездку уже нельзя отменить');
    error.code = 'BAD_STATUS';
    throw error;
  }

  const desiredTs = Date.parse(plan.desired_time);
  if (Number.isFinite(desiredTs) && Date.now() >= desiredTs) {
    const error = new Error('Нельзя отменить поездку после желаемого времени');
    error.code = 'TOO_LATE';
    throw error;
  }

  await runAsync(`UPDATE passenger_plans SET status = 'cancelled' WHERE id = ?`, [plan.id]);
  return getPassengerPlanById(plan.id);
}

async function getActivePassengerPlans(limit = 80) {
  return allAsync(
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
      LIMIT ?
    `,
    [Number(limit)]
  );
}

async function takePassengerPlan({ planId, driverId }) {
  const plan = await getAsync(`SELECT * FROM passenger_plans WHERE id = ?`, [Number(planId)]);
  if (!plan) {
    const error = new Error('Запланированная поездка не найдена');
    error.code = 'PLAN_NOT_FOUND';
    throw error;
  }
  if (plan.status !== 'active') {
    const error = new Error('Эта поездка уже недоступна');
    error.code = 'PLAN_ALREADY_TAKEN';
    throw error;
  }

  const desiredTs = Date.parse(plan.desired_time);
  if (Number.isFinite(desiredTs) && Date.now() >= desiredTs) {
    const error = new Error('Слишком поздно брать эту поездку');
    error.code = 'TOO_LATE';
    throw error;
  }

  const updateResult = await runAsync(
    `
      UPDATE passenger_plans
      SET status = 'taken',
          driver_id = ?,
          taken_at = datetime('now','localtime')
      WHERE id = ?
        AND status = 'active'
    `,
    [Number(driverId), plan.id]
  );

  if (!updateResult || updateResult.changes === 0) {
    const error = new Error('Эту поездку уже забрал другой водитель');
    error.code = 'PLAN_ALREADY_TAKEN';
    throw error;
  }

  return getPassengerPlanById(plan.id);
}

async function getDriverTakenPassengerPlansByTelegramId(telegramId) {
  return allAsync(
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
      JOIN users du ON du.id = p.driver_id
      JOIN users pu ON pu.id = p.passenger_id
      WHERE du.telegram_id = ?
        AND p.status = 'taken'
      ORDER BY datetime(p.desired_time) DESC, p.id DESC
    `,
    [String(telegramId)]
  );
}
async function getOwnerDashboardStats() {
  const [usersRow, tripsRow, bookingsRow, plansRow, reviewsRow] = await Promise.all([
    getAsync(
      `
        SELECT
          COUNT(*) AS users_total,
          SUM(CASE WHEN is_blocked = 1 THEN 1 ELSE 0 END) AS blocked_users_total
        FROM users
      `
    ),
    getAsync(
      `
        SELECT
          COUNT(*) AS trips_total,
          SUM(CASE WHEN datetime(departure_time) >= datetime('now', '-10 minutes') THEN 1 ELSE 0 END) AS active_trips_total,
          SUM(CASE WHEN date(created_at, 'localtime') = date('now','localtime') THEN 1 ELSE 0 END) AS trips_today_total,
          COUNT(DISTINCT driver_id) AS drivers_with_trips_total
        FROM trips
      `
    ),
    getAsync(
      `
        SELECT
          COUNT(*) AS bookings_total,
          SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) AS active_bookings_total,
          COALESCE(SUM(CASE WHEN status = 'booked' THEN seats_booked ELSE 0 END), 0) AS booked_seats_total,
          SUM(CASE WHEN date(created_at, 'localtime') = date('now','localtime') THEN 1 ELSE 0 END) AS bookings_today_total
        FROM bookings
      `
    ),
    getAsync(
      `
        SELECT
          COUNT(*) AS plans_total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_plans_total,
          SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END) AS taken_plans_total,
          SUM(CASE WHEN date(created_at, 'localtime') = date('now','localtime') THEN 1 ELSE 0 END) AS plans_today_total,
          SUM(CASE WHEN taken_at IS NOT NULL AND date(taken_at, 'localtime') = date('now','localtime') THEN 1 ELSE 0 END) AS taken_plans_today_total
        FROM passenger_plans
      `
    ),
    getAsync(`SELECT COUNT(*) AS reviews_total FROM reviews`),
  ]);

  return {
    users_total: usersRow?.users_total || 0,
    blocked_users_total: usersRow?.blocked_users_total || 0,
    trips_total: tripsRow?.trips_total || 0,
    active_trips_total: tripsRow?.active_trips_total || 0,
    trips_today_total: tripsRow?.trips_today_total || 0,
    drivers_with_trips_total: tripsRow?.drivers_with_trips_total || 0,
    bookings_total: bookingsRow?.bookings_total || 0,
    active_bookings_total: bookingsRow?.active_bookings_total || 0,
    booked_seats_total: bookingsRow?.booked_seats_total || 0,
    bookings_today_total: bookingsRow?.bookings_today_total || 0,
    plans_total: plansRow?.plans_total || 0,
    active_plans_total: plansRow?.active_plans_total || 0,
    taken_plans_total: plansRow?.taken_plans_total || 0,
    plans_today_total: plansRow?.plans_today_total || 0,
    taken_plans_today_total: plansRow?.taken_plans_today_total || 0,
    reviews_total: reviewsRow?.reviews_total || 0,
  };
}

async function getOwnerDriverActivity(targetDate) {
  const useCustomDate = !!targetDate;
  const params = [];
  const tripWhere = useCustomDate
    ? `date(t.created_at, 'localtime') = date(?, 'localtime')`
    : `date(t.created_at, 'localtime') = date('now','localtime')`;
  const bookingWhere = useCustomDate
    ? `date(b.created_at, 'localtime') = date(?, 'localtime')`
    : `date(b.created_at, 'localtime') = date('now','localtime')`;
  const planWhere = useCustomDate
    ? `date(p.taken_at, 'localtime') = date(?, 'localtime')`
    : `date(p.taken_at, 'localtime') = date('now','localtime')`;

  if (useCustomDate) {
    params.push(targetDate, targetDate, targetDate);
  }

  return allAsync(
    `
      WITH
      tripAgg AS (
        SELECT
          t.driver_id,
          COUNT(*) AS created_trips_count,
          COALESCE(SUM(t.seats_total), 0) AS seats_offered_count
        FROM trips t
        WHERE ${tripWhere}
        GROUP BY t.driver_id
      ),
      bookingAgg AS (
        SELECT
          t.driver_id,
          SUM(CASE WHEN b.status = 'booked' THEN 1 ELSE 0 END) AS bookings_count,
          COALESCE(SUM(CASE WHEN b.status = 'booked' THEN b.seats_booked ELSE 0 END), 0) AS booked_seats_count
        FROM bookings b
        JOIN trips t ON t.id = b.trip_id
        WHERE ${bookingWhere}
        GROUP BY t.driver_id
      ),
      planAgg AS (
        SELECT
          p.driver_id,
          COUNT(*) AS taken_plans_count,
          COALESCE(SUM(p.seats_needed), 0) AS taken_plan_seats_count
        FROM passenger_plans p
        WHERE p.status = 'taken'
          AND p.driver_id IS NOT NULL
          AND ${planWhere}
        GROUP BY p.driver_id
      ),
      driverIds AS (
        SELECT driver_id FROM tripAgg
        UNION
        SELECT driver_id FROM bookingAgg
        UNION
        SELECT driver_id FROM planAgg
      )
      SELECT
        u.id AS driver_id,
        u.telegram_id,
        u.first_name,
        u.last_name,
        u.username,
        u.is_blocked,
        COALESCE(tr.created_trips_count, 0) AS created_trips_count,
        COALESCE(tr.seats_offered_count, 0) AS seats_offered_count,
        COALESCE(ba.bookings_count, 0) AS bookings_count,
        COALESCE(ba.booked_seats_count, 0) AS booked_seats_count,
        COALESCE(pa.taken_plans_count, 0) AS taken_plans_count,
        COALESCE(pa.taken_plan_seats_count, 0) AS taken_plan_seats_count
      FROM driverIds ids
      JOIN users u ON u.id = ids.driver_id
      LEFT JOIN tripAgg tr ON tr.driver_id = u.id
      LEFT JOIN bookingAgg ba ON ba.driver_id = u.id
      LEFT JOIN planAgg pa ON pa.driver_id = u.id
      ORDER BY created_trips_count DESC, bookings_count DESC, taken_plans_count DESC, u.id DESC
    `,
    params
  );
}

async function getOwnerRecentTrips(limit = 6) {
  return allAsync(
    `
      SELECT
        t.*,
        u.telegram_id AS driver_telegram_id,
        u.first_name AS driver_first_name,
        u.last_name AS driver_last_name,
        u.username AS driver_username
      FROM trips t
      JOIN users u ON u.id = t.driver_id
      ORDER BY datetime(t.created_at) DESC, t.id DESC
      LIMIT ?
    `,
    [Number(limit)]
  );
}

async function getOwnerRecentPassengerPlans(limit = 6) {
  return allAsync(
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
        du.username AS driver_username
      FROM passenger_plans p
      JOIN users pu ON pu.id = p.passenger_id
      LEFT JOIN users du ON du.id = p.driver_id
      ORDER BY datetime(p.created_at) DESC, p.id DESC
      LIMIT ?
    `,
    [Number(limit)]
  );
}

async function savePushSubscription({ userId, subscription, userAgent, platform }) {
  if (!subscription || !subscription.endpoint) {
    throw new Error('Некорректная push-подписка');
  }

  const endpoint = String(subscription.endpoint).trim();
  if (!endpoint) {
    throw new Error('У push-подписки отсутствует endpoint');
  }

  await runAsync(
    `
      INSERT INTO push_subscriptions (
        user_id,
        endpoint,
        subscription_json,
        user_agent,
        platform,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        subscription_json = excluded.subscription_json,
        user_agent = excluded.user_agent,
        platform = excluded.platform,
        updated_at = datetime('now','localtime')
    `,
    [
      Number(userId),
      endpoint,
      JSON.stringify(subscription),
      userAgent ? String(userAgent).slice(0, 400) : null,
      platform ? String(platform).slice(0, 120) : null,
    ]
  );

  return getAsync(`SELECT * FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
}

async function getPushSubscriptionsByUserIds(userIds = []) {
  const ids = [...new Set(userIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(', ');
  return allAsync(
    `
      SELECT *
      FROM push_subscriptions
      WHERE user_id IN (${placeholders})
      ORDER BY id DESC
    `,
    ids
  );
}

function deletePushSubscriptionByEndpoint(endpoint) {
  return runAsync(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [String(endpoint || '')]);
}

function deletePushSubscription({ userId, endpoint }) {
  return runAsync(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`,
    [Number(userId), String(endpoint || '')]
  );
}

async function registerAutopostChat({ chatId, title, type, username, addedByTelegramId }) {
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) {
    throw new Error('Не передан chat_id группы');
  }

  await runAsync(
    `
      INSERT INTO autopost_chats (
        chat_id,
        title,
        type,
        username,
        is_active,
        added_by_telegram_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, datetime('now','localtime'), datetime('now','localtime'))
      ON CONFLICT(chat_id) DO UPDATE SET
        title = excluded.title,
        type = excluded.type,
        username = excluded.username,
        is_active = 1,
        added_by_telegram_id = excluded.added_by_telegram_id,
        updated_at = datetime('now','localtime')
    `,
    [
      normalizedChatId,
      title ? String(title).trim() : null,
      type ? String(type).trim() : null,
      username ? String(username).replace(/^@/, '').trim() : null,
      addedByTelegramId ? String(addedByTelegramId).trim() : null,
    ]
  );

  return getAsync(`SELECT * FROM autopost_chats WHERE chat_id = ?`, [normalizedChatId]);
}

async function deactivateAutopostChat(chatId) {
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) {
    throw new Error('Не передан chat_id группы');
  }

  await runAsync(
    `
      UPDATE autopost_chats
      SET is_active = 0,
          updated_at = datetime('now','localtime')
      WHERE chat_id = ?
    `,
    [normalizedChatId]
  );

  return getAsync(`SELECT * FROM autopost_chats WHERE chat_id = ?`, [normalizedChatId]);
}

function getActiveAutopostChats() {
  return allAsync(
    `
      SELECT *
      FROM autopost_chats
      WHERE is_active = 1
      ORDER BY
        CASE WHEN title IS NULL OR trim(title) = '' THEN 1 ELSE 0 END,
        title COLLATE NOCASE ASC,
        id ASC
    `
  );
}

function ensureAppSettingsTable() {
  return runAsync(`
    CREATE TABLE IF NOT EXISTS app_kv_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
}

async function getAppSettings(keys = []) {
  await ensureAppSettingsTable();

  const normalizedKeys = Array.isArray(keys)
    ? keys.map((key) => String(key || '').trim()).filter(Boolean)
    : [];

  const rows = normalizedKeys.length
    ? await allAsync(
        `
          SELECT setting_key AS key, setting_value AS value
          FROM app_kv_settings
          WHERE setting_key IN (${normalizedKeys.map(() => '?').join(',')})
        `,
        normalizedKeys
      )
    : await allAsync(`SELECT setting_key AS key, setting_value AS value FROM app_kv_settings`);

  return rows.reduce((acc, row) => {
    acc[row.key] = row.value || '';
    return acc;
  }, {});
}

async function setAppSettings(settings = {}) {
  await ensureAppSettingsTable();

  const entries = Object.entries(settings)
    .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
    .filter(([key]) => key);

  for (const [key, value] of entries) {
    const result = await runAsync(
      `
        UPDATE app_kv_settings
        SET setting_value = ?,
          updated_at = datetime('now','localtime')
        WHERE setting_key = ?
      `,
      [value, key]
    );

    if (!result.changes) {
      await runAsync(
        `
          INSERT INTO app_kv_settings (setting_key, setting_value, updated_at)
          VALUES (?, ?, datetime('now','localtime'))
        `,
        [key, value]
      );
    }
  }

  return getAppSettings(entries.map(([key]) => key));
}

module.exports = {
  db,
  dbRun: runAsync,
  dbGet: getAsync,
  dbAll: allAsync,
  upsertUserFromTelegram,
  createStandaloneUser,
  authenticateStandaloneUser,
  getUserById,
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
};
