export function formatBeijingTime(date, format = 'full') {
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  
  if (format === 'date') {
    return beijingTime.toISOString().split('T')[0];
  }
  
  return beijingTime.toISOString().replace('T', ' ').slice(0, 19) + ' (北京时间)';
}

export function isAdmin(userId, adminIds) {
  return adminIds.includes(userId);
}

export function generateDeepLink(botUsername, param) {
  return `https://t.me/${botUsername}?start=${param}`;
}

export function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}
