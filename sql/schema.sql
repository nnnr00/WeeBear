-- 用户表：记录 /start、/dh、频控等用户行为
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username TEXT,
  first_seen_date DATE,
  last_active_date DATE,
  dh_count INT DEFAULT 0,
  dh_free_count INT DEFAULT 0,
  cooldown_until BIGINT DEFAULT 0,
  cooldown_level INT DEFAULT 0,
  is_vip BOOLEAN DEFAULT false
);

-- 商品上架记录（admin 添加）
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  keyword TEXT,
  content_type TEXT,
  content JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 工单系统
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  username TEXT,
  order_number TEXT,
  first_time TIMESTAMP,
  last_time TIMESTAMP,
  status TEXT DEFAULT 'active' -- 可扩展为 disabled 等
);

-- 管理员状态缓存
CREATE TABLE IF NOT EXISTS admin_state (
  user_id BIGINT PRIMARY KEY,
  action TEXT,
  meta JSONB
);

-- 临时商品上架缓冲
CREATE TABLE IF NOT EXISTS product_buffer (
  user_id BIGINT PRIMARY KEY,
  keyword TEXT,
  contents JSONB
);
