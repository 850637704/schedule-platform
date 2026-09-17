// 超管密码重置脚本
// 运行方式：node reset-superadmin.js
// 重置后超管密码为 990322

const { resetSuperAdmin } = require('./utils/userStore');

const result = resetSuperAdmin();
if (result.ok) {
  console.log('超管密码已重置为 990322');
  console.log('账号：17347363572');
} else {
  console.error('重置失败：', result.error);
}
