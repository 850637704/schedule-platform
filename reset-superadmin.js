// 超管密码重置脚本
// 运行方式：node reset-superadmin.js
// 重置后超管密码为 990322

require('dotenv').config();
const db = require('./utils/db');
const { resetSuperAdmin } = require('./utils/userStore');

(async () => {
  await db.initTables();
  const result = await resetSuperAdmin();
  if (result.ok) {
    console.log('超管密码已重置为 990322');
    console.log('账号：17347363572');
  } else {
    console.error('重置失败：', result.error);
  }
  process.exit(0);
})();
