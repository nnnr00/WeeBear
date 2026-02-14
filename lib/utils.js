// lib/utils.js
const { format } = require('date-fns');

// 获取北京时间字符串 (2024-02-14 12:30:45)
exports.getBeijingTime = () => {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).replace(/\//g, '-');
};

// 格式化时间显示 (用于工单等)
exports.formatBeijingTime = (date) => {
  const d = new Date(date);
  return format(d, 'yyyy-MM-dd HH:mm:ss');
};

// 获取北京日期字符串 (2024-02-14)
exports.getBeijingDate = () => {
  return new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');
};

// 检查是否为新用户（当天首次使用）
exports.isNewUser = async (userId) => {
  const today = exports.getBeijingDate();
  const result = await db.query(
    `SELECT reset_date FROM dh_usage WHERE user_id = $1`,
    [userId]
  );
  
  if (!result.rows[0] || result.rows[0].reset_date !== today) {
    return true;
  }
  return false;
};
