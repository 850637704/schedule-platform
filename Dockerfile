FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3000
ENV DATA_DIR=/app/data
ENV UPLOAD_DIR=/app/uploads
# 配置 DATABASE_URL 后自动使用 Postgres 存储（如 Neon），不配置则使用本地文件
# ENV DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require

RUN mkdir -p /app/data /app/uploads

EXPOSE 3000

CMD ["node", "server.js"]
