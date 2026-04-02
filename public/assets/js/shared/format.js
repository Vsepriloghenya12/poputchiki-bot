const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatName(firstName, lastName, username) {
  const name = `${firstName || ''} ${lastName || ''}`.trim();
  if (name) return name;
  if (username) return `@${String(username).replace('@', '')}`;
  return 'Без имени';
}

export function getInitials(firstName, lastName, username) {
  const source = `${firstName || ''} ${lastName || ''}`.trim() || String(username || '').replace('@', '').trim();
  if (!source) return 'П';
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function formatMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)} ₽` : '0 ₽';
}

export function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  if (targetDay === today) return `Сегодня, ${hours}:${minutes}`;
  if (targetDay === tomorrow) return `Завтра, ${hours}:${minutes}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}, ${hours}:${minutes}`;
}

export function isUpcoming(value, graceMinutes = 10) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return true;
  return date.getTime() >= Date.now() - graceMinutes * 60 * 1000;
}

export function statusBadge(status) {
  switch (status) {
    case 'active':
      return { label: 'Открыта', tone: 'success' };
    case 'booked':
      return { label: 'Активно', tone: 'success' };
    case 'taken':
      return { label: 'Взято водителем', tone: 'success' };
    case 'cancelled':
      return { label: 'Отменено', tone: 'danger' };
    case 'no_show':
      return { label: 'Не приехал', tone: 'warning' };
    default:
      return { label: status || '—', tone: '' };
  }
}
