const bcrypt = require('bcrypt');
const db = require('./db');

async function setup() {
  const hash = await bcrypt.hash('admin123', 10);
  await db.query(
    'UPDATE admins SET password = ? WHERE username = ?',
    [hash, 'admin']
  );
  console.log('✅ Admin password set!');
  console.log('Username: admin');
  console.log('Password: admin123');
  process.exit();
}

setup();