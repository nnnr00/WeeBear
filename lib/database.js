import { kv } from '@vercel/kv';

export function getDatabase() {
  return {
    async get(key) {
      try {
        return await kv.get(key);
      } catch (error) {
        console.error('Database get error:', error);
        return null;
      }
    },
    
    async set(key, value) {
      try {
        return await kv.set(key, value);
      } catch (error) {
        console.error('Database set error:', error);
        return false;
      }
    },
    
    async delete(key) {
      try {
        return await kv.del(key);
      } catch (error) {
        console.error('Database delete error:', error);
        return false;
      }
    },
    
    async exists(key) {
      try {
        return await kv.exists(key);
      } catch (error) {
        console.error('Database exists error:', error);
        return false;
      }
    }
  };
}
