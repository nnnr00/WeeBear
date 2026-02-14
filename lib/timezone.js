// Always convert to Beijing time
const BEIJING_OFFSET = 8 * 60 * 60 * 1000; // 8 hours in ms

exports.getBeijingTime = (date = new Date()) => {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + (date.getTimezoneOffset() * 60000) + BEIJING_OFFSET);
  
  return beijing.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).replace(/\//g, '-');
};

exports.getBeijingDate = (date = new Date()) => {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + BEIJING_OFFSET);
  
  return beijing.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');
};

exports.isNewUser = async (userId) => {
  const today = exports.getBeijingDate();
  const { rows } = await db.query(
    `SELECT reset_date FROM dh_usage WHERE user_id = $1`,
    [userId]
  );
  
  return !rows[0] || rows[0].reset_date !== today;
};
