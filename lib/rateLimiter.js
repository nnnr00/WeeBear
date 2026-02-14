// lib/rateLimiter.js
const { query, execute } = require('./db');
const { parse } = require('date-fns');

// 频控配置
const FREE_NEW_USER = parseInt(process.env.FREE_NEW_USER) || 3;
const FREE_RETURNING_USER = parseInt(process.env.FREE_RETURNING_USER) || 2;
const MAX_DAILY = parseInt(process.env.MAX_DAILY) || 6;
const COOLDOWN_SEQUENCE = (process.env.COOLDOWN_SEQUENCE || '5,15,30,50,60,60')
  .split(',')
  .map(num => parseInt(num));

exports.check = async (ctx) => {
  const userId = ctx.from.id;
  const today = parse(new Date(), 'yyyy-MM-dd', 'yyyy-MM-dd');
  
  // 检查当日使用次数
  const [countResult] = await query(`
    SELECT COUNT(*) AS count FROM dh_usage 
    WHERE user_id = ? AND date_key = ? AND is_used = TRUE
  `, [userId, today]);
  
  const usedCount = countResult[0].count;
  
  // 检查是否超限
  if (usedCount >= MAX_DAILY) {
    const [resetTime] = await query(`
      SELECT next_reset FROM dh_usage 
      WHERE user_id = ? AND date_key = ? 
      ORDER BY last_used DESC LIMIT 1
    `, [userId, today]);
    
    if (resetTime.length > 0) {
      const resetDate = new Date(resetTime[0].next_reset);
      if (new Date() < resetDate) {
        ctx.session.cooldownEnd = resetDate;
        return false;
      }
    }
    return true;
  }
  
  // 检查是否为新用户
  const [userCheck] = await query(`
    SELECT is_new_user FROM dh_usage 
    WHERE user_id = ? AND date_key = ?
  `, [userId, today]);
  
  const isNewUser = userCheck.length === 0 || userCheck[0].is_new_user;
  const freeLimit = isNewUser ? FREE_NEW_USER : FREE_RETURNING_USER;
  
  if (usedCount < freeLimit) {
    await execute(`
      INSERT INTO dh_usage (user_id, date_key, is_used, last_used, next_reset, is_new_user)
      VALUES (?, ?, TRUE, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY), ?)
      ON CONFLICT (user_id, date_key) DO UPDATE SET
        last_used = NOW(),
        next_reset = DATE_ADD(NOW(), INTERVAL 1 DAY),
        is_new_user = FALSE
    `, [userId, today, isNewUser]);
    return true;
  }
  
  // 获取冷却时间
  const [lastUsage] = await query(`
    SELECT last_used FROM dh_usage 
    WHERE user_id = ? AND date_key = ? 
    ORDER BY last_used DESC LIMIT 1
  `, [userId, today]);
  
  if (lastUsage.length > 0) {
    const cooldownIndex = Math.min(usedCount, COOLDOWN_SEQUENCE.length - 1);
    const cooldownSeconds = COOLDOWN_SEQUENCE[cooldownIndex];
    const cooldownEnd = new Date(lastUsage[0].last_used);
    cooldownEnd.setSeconds(cooldownEnd.getSeconds() + cooldownSeconds);
    
    ctx.session.cooldownEnd = cooldownEnd;
  }
  
  return usedCount < MAX_DAILY;
};

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

exports.resetForAdmin = async (ctx) => {
  const userId = ctx.from.id;
  const today = parse(new Date(), 'yyyy-MM-dd', 'yyyy-MM-dd');
  
  await execute(`
    INSERT INTO dh_usage (user_id, date_key, is_used, last_used, next_reset, is_new_user)
    VALUES (?, ?, TRUE, NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY), TRUE)
    ON CONFLICT (user_id, date_key) DO UPDATE SET
      last_used = NOW(),
      next_reset = DATE_ADD(NOW(), INTERVAL 1 DAY),
      is_new_user = TRUE
  `, [userId, today]);
};
