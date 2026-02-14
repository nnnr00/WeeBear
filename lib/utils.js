// lib/utils.js
const ADMIN_IDS = process.env.ADMIN_IDS?.split(',')?.map(Number) || [];

// 检查是否为管理员
exports.isAdmin = (ctx) => {
  return ADMIN_IDS.includes(ctx.from.id);
};

// 检查是否为管理员命令
exports.isAdminCommand = (ctx) => {
  return exports.isAdmin(ctx) && 
         (ctx.message?.text?.startsWith('/') || ctx.callbackQuery?.data?.startsWith('/'));
};

// 获取北京时区时间
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

// 格式化时间显示
exports.formatBeijingTime = (date) => {
  return new Date(date).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).replace(/\//g, '-');
};

// 获取北京日期字符串
exports.getBeijingDate = () => {
  return new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');
};

// 检查是否为新用户
exports.isNewUser = async (userId) => {
  const today = exports.getBeijingDate();
  const result = await db.query(
    `SELECT reset_date FROM dh_usage WHERE user_id = $1`,
    [userId]
  );
  
  return !result.rows[0] || result.rows[0].reset_date !== today;
};
