const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false,
    ca: process.env.DATABASE_URL.includes('neon') 
      ? require('fs').readFileSync('/etc/ssl/certs/ca-bundle.crt') 
      : undefined
  }
});

// Test connection with proper time zone
pool.query(`
  SELECT 
  NOW() AS utc_time,
  (NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS sh_time
`, (err, res) => {
  if (err) console.error('DB TIME ZONE ERROR:', err);
  else console.log('DB TIME ZONE OK:', {
    utc: res.rows[0].utc_time,
    sh: res.rows[0].sh_time
  });
});

module.exports = pool;
