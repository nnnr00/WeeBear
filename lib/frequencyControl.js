const { getBeijingTime, formatDate } = require('./utils');
const db = require('./db');

// 免费额度配置
const FREE_QUOTA = {
  NEW_USER: 3,  // 新用户当天免费次数
  OLD_USER: 2   // 老用户每天免费次数
};

// 冷却序列 (分钟)
const COOLING_SEQUENCE = [5, 10, 30, 40, 50];

/**
 * 检查 /dh 命令是否允许执行
 * @returns {Promise<{allowed: boolean, message: string}>}
 */
exports.checkDhFrequency = async (user_id) => {
  const now = getBeijingTime();
  const today = formatDate(now);
  
  // 获取或创建用户频控记录
  let usage = await db.query(
    `INSERT INTO dh_usage (user_id, date_key) 
     VALUES ($1, $2) 
     ON CONFLICT (user_id, date_key) DO UPDATE 
     SET last_updated = NOW() 
     RETURNING *`,
    [user_id, today]
  );
  
  if (usage.rows.length === 0) {
    usage = await db.query('SELECT * FROM dh_usage WHERE user_id = $1 AND date_key = $2', [user_id, today]);
  }
  
  const record = usage.rows[0];
  
  // 检查每日上限 (10次)
  if (record.total_attempts >= 10) {
    return {
      allowed: false,
      message: `❌ 今日尝试次数已达上限 (10/10)\n💎 [加入会员](https://t.me/+495j5rWmApsxYzg9) 解锁无限次兑换`
    };
  }

  // 检查冷却状态
  if (record.cooling_until && now < new Date(record.cooling_until)) {
    const remaining = Math.ceil((new Date(record.cooling_until) - now) / 60000);
    return {
      allowed: false,
      message: `⏳ 冷却中 (${remaining}分钟)\n💎 [加入会员](https://t.me/+495j5rWmApsxYzg9) 立即解除冷却`
    };
  }

  // 检查免费额度
  const isNewUser = formatDate(new Date(record.first_seen_date)) === today;
  const freeQuota = isNewUser ? FREE_QUOTA.NEW_USER : FREE_QUOTA.OLD_USER;
  
  if (record.success_count < freeQuota) {
    // 允许执行 (消耗免费额度)
    await db.query(
      `UPDATE dh_usage 
       SET success_count = success_count + 1, total_attempts = total_attempts + 1 
       WHERE user_id = $1 AND date_key = $2`,
      [user_id, today]
    );
    return { allowed: true };
  }

  // 免费额度用完 - 触发冷却
  const excessFailures = record.total_attempts - freeQuota + 1;
  const coolingIndex = Math.min(excessFailures - 1, COOLING_SEQUENCE.length - 1);
  const coolingMinutes = COOLING_SEQUENCE[coolingIndex];
  
  const coolingUntil = addHours(now, coolingMinutes / 60);
  
  await db.query(
    `UPDATE dh_usage 
     SET total_attempts = total_attempts + 1, 
         cooling_until = $1,
         failure_count = failure_count + 1
     WHERE user_id = $2 AND date_key = $3`,
    [coolingUntil, user_id, today]
  );

  return {
    allowed: false,
    message: `⏳ 冷却中 (${coolingMinutes}分钟)\n💎 [加入会员](https://t.me/+495j5rWmApsxYzg9) 立即解除冷却`
  };
};
