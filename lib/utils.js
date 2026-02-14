const { format, addHours } = require('date-fns');
const { utcToZonedTime } = require('date-fns-tz');

// 获取北京时间 (UTC+8)
exports.getBeijingTime = () => {
  return utcToZonedTime(new Date(), 'Asia/Shanghai');
};

// 格式化日期为 YYYY-MM-DD
exports.formatDate = (date) => {
  return format(date, 'yyyy-MM-dd');
};

// 分页处理 (通用)
exports.paginate = (items, page = 1, perPage = 10) => {
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    totalPages: Math.ceil(items.length / perPage),
    currentPage: page
  };
};

// 生成分页键盘 (通用格式)
exports.generatePaginationKeyboard = (page, totalPages, command) => {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⬅️ 上一页', callback_data: `${command}_page_${page - 1}` },
          { text: `📄 ${page}/${totalPages}`, callback_data: 'noop' },
          { text: '下一页 ➡️', callback_data: `${command}_page_${page + 1}` }
        ]
      ]
    }
  };
};
