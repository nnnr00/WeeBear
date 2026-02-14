import { kv } from '@vercel/kv';

class Database {
  // 用户数据
  async getUser(userId) {
    return await kv.get(`user:${userId}`) || this.createNewUser(userId);
  }

  createNewUser(userId) {
    const today = this.getBeijingDateKey();
    return {
      id: userId,
      first_seen_date: today,
      dh_count: 0,
      dh_free_count: 0,
      cooldown_until: null,
      cooldown_level: 0,
      last_date_key: today,
      is_vip: false,
      failed_attempts: 0
    };
  }

  async saveUser(userId, userData) {
    await kv.set(`user:${userId}`, userData);
  }

  // 商品数据
  async getProducts() {
    return await kv.get('products') || {};
  }

  async saveProducts(products) {
    await kv.set('products', products);
  }

  async addProduct(keyword, items) {
    const products = await this.getProducts();
    products[keyword] = items;
    await this.saveProducts(products);
  }

  async deleteProduct(keyword) {
    const products = await this.getProducts();
    delete products[keyword];
    await this.saveProducts(products);
  }

  // 工单数据
  async getTickets() {
    return await kv.get('tickets') || [];
  }

  async saveTickets(tickets) {
    await kv.set('tickets', tickets);
  }

  async addTicket(userId, username, orderNumber) {
    const tickets = await this.getTickets();
    const now = this.getBeijingTime();
    
    const existingIndex = tickets.findIndex(t => t.userId === userId);
    
    if (existingIndex !== -1) {
      tickets[existingIndex].lastTime = now;
      tickets[existingIndex].orderNumber = orderNumber;
    } else {
      tickets.unshift({
        userId,
        username,
        orderNumber,
        firstTime: now,
        lastTime: now,
        disabled: false
      });
    }
    
    await this.saveTickets(tickets);
  }

  async deleteTicket(userId) {
    const tickets = await this.getTickets();
    const filtered = tickets.filter(t => t.userId !== userId);
    await this.saveTickets(filtered);
  }

  // 用户状态
  async getUserState(userId) {
    return await kv.get(`state:${userId}`);
  }

  async setUserState(userId, state) {
    if (state) {
      await kv.set(`state:${userId}`, state, { ex: 3600 });
    } else {
      await kv.del(`state:${userId}`);
    }
  }

  // 临时缓冲区
  async getPBuffer(userId) {
    return await kv.get(`p_buffer:${userId}`) || null;
  }

  async setPBuffer(userId, data) {
    if (data) {
      await kv.set(`p_buffer:${userId}`, data, { ex: 3600 });
    } else {
      await kv.del(`p_buffer:${userId}`);
    }
  }

  // 时间工具
  getBeijingTime() {
    const now = new Date();
    const beijingTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    return beijingTime.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  getBeijingDateKey() {
    const now = new Date();
    const beijingTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    return beijingTime.toISOString().split('T')[0];
  }
}

export default new Database();
