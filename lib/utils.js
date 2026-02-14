const { Pool } = require('pg');

// Admin check
exports.isAdmin = (ctx) => {
  const adminIds = process.env.ADMIN_IDS?.split(',')?.map(Number) || [];
  return adminIds.includes(ctx.from.id);
};

// Time zone helpers
exports.getBeijingTime = require('./timezone').getBeijingTime;
exports.formatBeijingTime = require('./timezone').formatBeijingTime;
exports.getBeijingDate = require('./timezone').getBeijingDate;
exports.isNewUser = require('./timezone').isNewUser;

// Admin command check
exports.isAdminCommand = (ctx) => {
  return exports.isAdmin(ctx) && 
         (ctx.message?.text?.startsWith('/') || ctx.callbackQuery?.data?.startsWith('/'));
};
