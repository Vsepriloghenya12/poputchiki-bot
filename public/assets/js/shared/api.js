export const tg = window.Telegram?.WebApp || null;

if (tg) {
  tg.ready();
  tg.expand();
}

const rawFetch = window.fetch.bind(window);
let appConfigPromise = null;

export function getTelegramUser() {
  return tg?.initDataUnsafe?.user || null;
}

export function getStartParam() {
  const startParam = tg?.initDataUnsafe?.start_param || tg?.initDataUnsafe?.startParam;
  if (startParam) return String(startParam);

  try {
    const params = new URL(window.location.href).searchParams;
    return (
      params.get('startapp') ||
      params.get('tgWebAppStartParam') ||
      params.get('start_param') ||
      ''
    );
  } catch (_) {
    return '';
  }
}

export async function apiFetch(url, options = {}) {
  const requestOptions = { ...options };
  requestOptions.headers = { ...(requestOptions.headers || {}) };

  if (tg?.initData) {
    requestOptions.headers['x-telegram-init-data'] = tg.initData;
  }

  return rawFetch(url, requestOptions);
}

export async function apiRequest(url, options = {}) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || 'Ошибка запроса');
  }
  return data;
}

export async function loadAppConfig() {
  if (!appConfigPromise) {
    appConfigPromise = apiRequest('/api/app-config').catch(() => ({}));
  }
  return appConfigPromise;
}

export async function initUser() {
  const user = getTelegramUser();
  if (!user) return { user: null, is_owner: false };

  return apiRequest('/api/init-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user }),
  });
}

export async function deeplinkFor(startParam) {
  const config = await loadAppConfig();
  const value = String(startParam || '').trim();

  if (config?.deeplink_prefix) {
    return `${config.deeplink_prefix}${encodeURIComponent(value)}`;
  }

  const base = window.location.href.split('#')[0];
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}startapp=${encodeURIComponent(value)}`;
}

export async function shareText(text, urlOverride = '') {
  const shareUrl = urlOverride || window.location.href;
  const telegramShareUrl =
    'https://t.me/share/url?url=' + encodeURIComponent(shareUrl) + '&text=' + encodeURIComponent(text);

  if (tg?.openTelegramLink) tg.openTelegramLink(telegramShareUrl);
  else window.open(telegramShareUrl, '_blank', 'noopener');
}

export function openChat(username, telegramId) {
  if (username) {
    const url = 'https://t.me/' + String(username).replace('@', '');
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
    return;
  }

  if (telegramId) {
    const url = 'tg://user?id=' + encodeURIComponent(String(telegramId));
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.location.href = url;
    return;
  }

  showAlert('У пользователя нет username, чат открыть не удалось.');
}

export function showAlert(message) {
  if (tg?.showAlert) tg.showAlert(String(message));
  else window.alert(String(message));
}
