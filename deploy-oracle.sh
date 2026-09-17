#!/bin/bash
# Oracle Cloud Always Free 部署脚本
# 在 Ubuntu 实例上执行： bash deploy-oracle.sh

set -e

echo "=== 1. 更新系统并安装 Docker ==="
sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose-plugin git curl

echo "=== 2. 启动 Docker 服务 ==="
sudo systemctl enable docker
sudo systemctl start docker

echo "=== 3. 拉取项目代码 ==="
cd ~
if [ -d "schedule-platform" ]; then
  cd schedule-platform
  git pull origin main
else
  git clone https://github.com/850637704/schedule-platform.git
  cd schedule-platform
fi

echo "=== 4. 构建并启动服务 ==="
sudo docker compose up -d --build

echo "=== 5. 开放防火墙端口 ==="
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true

echo ""
echo "=== 部署完成 ==="
echo "服务已启动，访问地址：http://<你的服务器公网IP>:3000"
echo ""
echo "常用命令："
echo "  查看日志: sudo docker compose logs -f"
echo "  重启服务: sudo docker compose restart"
echo "  停止服务: sudo docker compose down"
echo "  更新代码: git pull && sudo docker compose up -d --build"
