// 在 lib/dh.js 中
const { getBeijingDate } = require('../lib/utils');

// 检查是否需要重置
async function shouldResetUsage(ctx) {
  const userId = ctx.from.id;
  const today = getBeijingDate();
  
  // 获取当前记录
  const usage = await db.query(
    `SELECT reset_date FROM dh_usage WHERE user_id = $1`,
    [userId]
  );
  
  // 无记录或日期变化需要重置
  if (!usage.rows[0] || usage.rows[0].reset_date !== today) {
    await resetDhUsage(ctx, true); // 强制重置
    return true;
  }
  return false;
}

// 重置频控
async function resetDhUsage(ctx, isNewDay = false) {
  const userId = ctx.from.id;
  const today = getBeijingDate();
  
  if (isNewDay) {
    // 新的一天，重置计数
    await db.query(
      `INSERT INTO dh_usage (user_id, used_count, reset_date) 
       VALUES ($1, 0, $2)
       ON CONFLICT (user_id) DO UPDATE 
       SET used_count = 0, reset_date = $2`,
      [userId, today]
    );
  } else {
    // 手动重置（/cz 命令）
    await db.query(
      `UPDATE dh_usage 
       SET used_count = 0, cooldown_until = NULL, reset_date = $1 
       WHERE user_id = $2`,
      [today, userId]
    );
  }
}
