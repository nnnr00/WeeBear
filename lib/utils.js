// lib/utils.js
const { format } = require('date-fns');

// 获取北京时间
exports.getBeijingTime = () => {
  return new Date().toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

// 格式化时间显示
exports.formatBeijingTime = (date) => {
  const d = new Date(date);
  return format(d, 'yyyy-MM-dd HH:mm:ss');
};

// 获取北京时间日期部分（用于重置判断）
exports.getBeijingDate = () => {
  return new Date().toLocaleDateString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');
};
