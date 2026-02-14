// lib/rateLimiter.js
const { db } = require('./db');
const { parse } = require('date-fns');

const FREE_NEW_USER = 3;   // 新用户当日免费次数
const FREE_RETURNING_USER = 2; // 老用户每日免费次数
const MAX_DAILY = 6;       // 每日上限
const COOLDOWN_SEQUENCE = [5, 15, 30, 50, 60, 60]; // 冷却序列

// 检查是否通过频控
exports.check = async (ctx) => {
  const userId = ctx.from.id;
  const today = parse(new Date(), 'yyyy-MM-dd', 'yyyy-MM-dd');
  
  // 检查当日已使用次数
  const [countResult] = await db.query(
    `SELECT COUNT(*) AS count FROM dh_usage 
     WHERE user_id = ? AND date_key = ? AND is_used = TRUE`,
    [userId, today]
  );
  
  const usedCount = countResult[0].count;
  
  // 检查是否超限
  if (usedCount >= MAX_DAILY) {
    const [resetTime] = await db.query(
      `SELECT next_reset FROM dh_usage 
       WHERE user_id = ? AND date_key = ? 
       ORDER BY last_used DESC LIMIT 1`,
      [userId, today]
    );
    
    if (resetTime.length > 0) {
      const resetDate = new Date(resetTime[0].next_reset);
      if (new Date() < resetDate) {
        ctx.session.cooldownEnd = resetDate;
        return false;
      }
    }
    return true; // 超限但冷却结束
  }
  
  // 检查是否为新用户
  const [userCheck] = await db.query(
    `SELECT is_new_user FROM dh_usage 
     WHERE user_id = ? AND date_key = ?`,
    [userId, today]
  );
  
  const isNewUser = userCheck.length === 0 || userCheck[0].is_new_user;
  const freeLimit = isNewUser ? FREE_NEW_USER : FREE_RETURNING_USER;
  
  if (usedCount < freeLimit) {
    // 记录使用
    await db.query(
      `INSERT INTO dh_usage (user_id, date_key, is_used, last_used, next_reset, is_new_user) 
       VALUES (?, ?, TRUE, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY), ?)
       ON DUPLICATE KEY UPDATE 
         last_used = NOW(),
         next_reset = DATE_ADD(NOW(), INTERVAL 1 DAY),
         is_new_user = FALSE`,
      [userId, today, isNewUser]
    );
    return true;
  }
  
  // 获取冷却时间
  const [lastUsage] = await db.query(
    `SELECT last_used FROM dh_usage 
     WHERE user_id = ? AND date_key = ? 
     ORDER BY last_used DESC LIMIT 1`,
    [userId, today]
  );
  
  if (lastUsage.length > 0) {
    const cooldownIndex = Math.min(usedCount, COOLDOWN_SEQUENCE.length - 1);
    const cooldownSeconds = COOLDOWN_SEQUENCE[cooldownIndex];
    const cooldownEnd = new Date(lastUsage[0].last_used);
    cooldownEnd.setSeconds(cooldownEnd.getSeconds() + cooldownSeconds);
    
    ctx.session.cooldownEnd = cooldownEnd;
  }
  
  return usedCount < MAX_DAILY;
};

// 获取剩余冷却时间
exports.getRemainingTime = async (ctx) => {
  if (!ctx.session.cooldownEnd) return "00:00";
  
  const now = new Date();
  const end = new Date(ctx.session.cooldownEnd);
  const diff = Math.floor((end - now) / 1000);
  
  if (diff <= 0) return "00:00";
  
  const mins = String(Math.floor(diff / 60)).padStart(2, '0');
  const secs = String(diff % 60).padStart(2, '0');
  return `${mins}:${secs}`;
};

// 重置管理员频控
exports.resetForAdmin = async (ctx) => {
  const userId = ctx.from.id;
  const today = parse(new Date(), 'yyyy-MM-dd', 'yyyy-MM-dd');
  
  await db.query(
    `INSERT INTO dh_usage (user_id, date_key, is_used, last_used, next_reset, is_new_user) 
     VALUES (?, ?, TRUE, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY), TRUE)
     ON DUPLICATE KEY UPDATE 
        last_used = NOW(), 
        next_reset = DATE_ADD(NOW(), INTERVAL 1 DAY),
        is_new_user = TRUE`,
    [userId, today]
  );
};
