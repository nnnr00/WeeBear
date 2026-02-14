export function createInlineKeyboard(buttons) {
  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

export function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

export function isAdmin(userId, adminId) {
  return userId.toString() === adminId.toString();
}

export function extractOrderNumber(text) {
  const match = text.match(/20260\d*/);
  return match ? match[0] : null;
}

export function formatCooldownTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) {
    return `${minutes}分${secs}秒`;
  }
  return `${secs}秒`;
}

export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
