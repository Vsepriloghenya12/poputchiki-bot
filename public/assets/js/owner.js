import { apiRequest } from './shared/api.js';
import { escapeHtml, formatDateTime, formatName } from './shared/format.js';

const refs = {
  statusBanner: document.getElementById('ownerStatusBanner'),
  desktopAccessPanel: document.getElementById('desktopAccessPanel'),
  desktopAccessForm: document.getElementById('desktopAccessForm'),
  ownerPasswordInput: document.getElementById('ownerPasswordInput'),
  clearDesktopAccessBtn: document.getElementById('clearDesktopAccessBtn'),
  accessCard: document.getElementById('accessCard'),
  ownerContent: document.getElementById('ownerContent'),
  ownerAuthBadge: document.getElementById('ownerAuthBadge'),
  logoutOwnerBtn: document.getElementById('logoutOwnerBtn'),
  metricsGrid: document.getElementById('metricsGrid'),
  recentTripsList: document.getElementById('recentTripsList'),
  recentPlansList: document.getElementById('recentPlansList'),
  driversDate: document.getElementById('driversDate'),
  driversList: document.getElementById('driversList'),
  reloadDriversBtn: document.getElementById('reloadDriversBtn'),
};

const state = {
  authenticated: false,
  passwordConfigured: false,
};

function setStatus(message = '', tone = '') {
  refs.statusBanner.textContent = message;
  refs.statusBanner.classList.toggle('hidden', !message);
  refs.statusBanner.classList.toggle('is-error', tone === 'error');
}

function setAccessMessage(message = '') {
  refs.accessCard.textContent = message;
  refs.accessCard.classList.toggle('hidden', !message);
}

function setAuthenticatedUI(authenticated) {
  state.authenticated = !!authenticated;
  refs.desktopAccessPanel.classList.toggle('hidden', state.authenticated);
  refs.ownerContent.classList.toggle('hidden', !state.authenticated);
  refs.logoutOwnerBtn.classList.toggle('hidden', !state.authenticated);
  refs.ownerAuthBadge.classList.toggle('hidden', !state.authenticated);

  if (state.authenticated) {
    refs.ownerPasswordInput.value = '';
    setAccessMessage('');
  }
}

function metricCard(label, value, hint) {
  return `
    <article class="metric-card">
      <div class="metric-card__label">${escapeHtml(label)}</div>
      <div class="metric-card__value">${escapeHtml(String(value))}</div>
      <div class="metric-card__hint">${escapeHtml(hint)}</div>
    </article>
  `;
}

function renderOverview(stats) {
  refs.metricsGrid.innerHTML = [
    metricCard('Пользователи', stats.users_total || 0, `Заблокировано: ${stats.blocked_users_total || 0}`),
    metricCard('Всего поездок', stats.trips_total || 0, `Активных сейчас: ${stats.active_trips_total || 0}`),
    metricCard('Бронирования', stats.bookings_total || 0, `Активных сейчас: ${stats.active_bookings_total || 0}`),
    metricCard('Пассажирские заявки', stats.plans_total || 0, `Открытых: ${stats.active_plans_total || 0}`),
    metricCard('Сегодня поездок', stats.trips_today_total || 0, `Сегодня бронирований: ${stats.bookings_today_total || 0}`),
    metricCard('Сегодня заявок', stats.plans_today_total || 0, `Взято сегодня: ${stats.taken_plans_today_total || 0}`),
    metricCard('Водителей с поездками', stats.drivers_with_trips_total || 0, `Занятых мест: ${stats.booked_seats_total || 0}`),
    metricCard('Отзывы', stats.reviews_total || 0, `Взятых заявок: ${stats.taken_plans_total || 0}`),
  ].join('');
}

function renderRecentTrips(trips) {
  refs.recentTripsList.innerHTML = trips.length
    ? trips
        .map(
          (trip) => `
          <div class="owner-item">
            <div class="owner-item__title">${escapeHtml(trip.from_city)} → ${escapeHtml(trip.to_city)}</div>
            <div class="owner-item__meta">
              Время: ${escapeHtml(formatDateTime(trip.departure_time))}<br/>
              Водитель: ${escapeHtml(formatName(trip.driver_first_name, trip.driver_last_name, trip.driver_username))}<br/>
              Создано: ${escapeHtml(formatDateTime(trip.created_at))}
            </div>
          </div>
        `
        )
        .join('')
    : '<div class="empty-state">Свежих поездок пока нет.</div>';
}

function renderRecentPlans(plans) {
  refs.recentPlansList.innerHTML = plans.length
    ? plans
        .map(
          (plan) => `
          <div class="owner-item">
            <div class="owner-item__title">${escapeHtml(plan.from_city)} → ${escapeHtml(plan.to_city)}</div>
            <div class="owner-item__meta">
              Пассажир: ${escapeHtml(formatName(plan.passenger_first_name, plan.passenger_last_name, plan.passenger_username))}<br/>
              Время: ${escapeHtml(formatDateTime(plan.desired_time))}<br/>
              Статус: ${escapeHtml(plan.status || '—')}
            </div>
          </div>
        `
        )
        .join('')
    : '<div class="empty-state">Свежих заявок пока нет.</div>';
}

function renderDrivers(drivers) {
  refs.driversList.innerHTML = drivers.length
    ? drivers
        .map(
          (driver) => `
          <article class="report-row">
            <div class="report-row__head">
              <div>
                <div class="report-row__name">${escapeHtml(formatName(driver.first_name, driver.last_name, driver.username))}</div>
                <div class="muted small">${escapeHtml(driver.username ? '@' + driver.username.replace('@', '') : 'Без username')}</div>
              </div>
              <div class="filter-bar">
                <span class="badge ${driver.is_blocked ? 'danger' : 'success'}">${driver.is_blocked ? 'Заблокирован' : 'Активен'}</span>
                <button class="${driver.is_blocked ? 'ghost-button' : 'danger-button'}" type="button" data-action="toggle-driver-block" data-driver-tg="${escapeHtml(driver.telegram_id)}" data-block="${driver.is_blocked ? '0' : '1'}">
                  ${driver.is_blocked ? 'Разблокировать' : 'Заблокировать'}
                </button>
              </div>
            </div>
            <div class="report-row__stats">
              <div class="report-stat"><div class="report-stat__label">Создано поездок</div><div class="report-stat__value">${escapeHtml(String(driver.created_trips_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Предложено мест</div><div class="report-stat__value">${escapeHtml(String(driver.seats_offered_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Бронирований</div><div class="report-stat__value">${escapeHtml(String(driver.bookings_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Занято мест</div><div class="report-stat__value">${escapeHtml(String(driver.booked_seats_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Взято заявок</div><div class="report-stat__value">${escapeHtml(String(driver.taken_plans_count || 0))}</div></div>
              <div class="report-stat"><div class="report-stat__label">Мест в заявках</div><div class="report-stat__value">${escapeHtml(String(driver.taken_plan_seats_count || 0))}</div></div>
            </div>
          </article>
        `
        )
        .join('')
    : '<div class="empty-state">За выбранную дату активности водителей нет.</div>';
}

async function loadOverview() {
  const data = await apiRequest('/api/owner/overview');
  renderOverview(data.stats || {});
  renderRecentTrips(data.recent_trips || []);
  renderRecentPlans(data.recent_plans || []);
}

async function loadDrivers() {
  const date = refs.driversDate.value;
  const url = date ? `/api/owner/drivers?date=${encodeURIComponent(date)}` : '/api/owner/drivers';
  const data = await apiRequest(url);
  renderDrivers(data.drivers || []);
}

async function loadOwnerDashboard() {
  await Promise.all([loadOverview(), loadDrivers()]);
  setStatus('');
}

async function checkOwnerSession() {
  const data = await apiRequest('/api/owner/session');
  state.passwordConfigured = !!data.password_configured;
  return !!data.authenticated;
}

async function bootstrap() {
  refs.driversDate.value = new Date().toISOString().slice(0, 10);

  try {
    const authenticated = await checkOwnerSession();

    if (!state.passwordConfigured) {
      setAuthenticatedUI(false);
      setAccessMessage('На сервере не настроен пароль owner-панели. Добавьте OWNER_PANEL_PASSWORD в .env и перезапустите сервер.');
      setStatus('На сервере не настроен OWNER_PANEL_PASSWORD.', 'error');
      return;
    }

    if (!authenticated) {
      setAuthenticatedUI(false);
      setAccessMessage('');
      return;
    }

    setAuthenticatedUI(true);
    await loadOwnerDashboard();
  } catch (error) {
    setAuthenticatedUI(false);
    setAccessMessage('Не удалось проверить доступ к owner-панели.');
    setStatus(error.message || 'Не удалось открыть owner-панель.', 'error');
  }
}

refs.desktopAccessForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const password = refs.ownerPasswordInput.value;
  if (!password) {
    setAccessMessage('Введите пароль владельца.');
    setStatus('Введите пароль владельца.', 'error');
    return;
  }

  apiRequest('/api/owner/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
    .then(async () => {
      setAuthenticatedUI(true);
      await loadOwnerDashboard();
    })
    .catch((error) => {
      setAuthenticatedUI(false);
      setAccessMessage('Пароль неверный или доступ не настроен.');
      setStatus(error.message || 'Не удалось выполнить вход.', 'error');
    });
});

refs.clearDesktopAccessBtn.addEventListener('click', () => {
  refs.ownerPasswordInput.value = '';
  setAccessMessage('');
  setStatus('');
});

refs.logoutOwnerBtn.addEventListener('click', () => {
  apiRequest('/api/owner/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
    .then(() => {
      setAuthenticatedUI(false);
      setStatus('Вы вышли из панели владельца.');
    })
    .catch((error) => setStatus(error.message || 'Не удалось выйти из панели владельца.', 'error'));
});

refs.reloadDriversBtn.addEventListener('click', () => {
  loadDrivers().catch((error) => setStatus(error.message || 'Не удалось загрузить список водителей.', 'error'));
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="toggle-driver-block"]');
  if (!button) return;

  apiRequest('/api/owner/block-driver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      driver_telegram_id: button.dataset.driverTg,
      block: button.dataset.block === '1',
    }),
  })
    .then(() => {
      setStatus('Статус водителя обновлён.');
      return loadDrivers();
    })
    .catch((error) => setStatus(error.message || 'Не удалось обновить статус водителя.', 'error'));
});

bootstrap();
