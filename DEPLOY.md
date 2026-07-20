# Linux 服务器部署指南

本文档介绍如何把「机器复用」网站部署到 Linux 服务器,涵盖 Ubuntu/Debian 和 CentOS/RHEL 两类系统。

部署后效果:服务开机自启、崩溃自动重启、团队通过 `http://服务器IP` 访问。

---

## 前置要求

- 一台 Linux 服务器(公网 IP 或团队内网可达)
- 有 `sudo` 权限的普通用户(下文用 `YOURUSER` 代指你的用户名,`YOURHOME` 代指家目录)
- Node.js 14+(仅用内置模块,无需 `npm install`)

> 全文命令里出现的 `YOURUSER`、`YOURHOME`、`你的域名或IP` 请替换成实际值。

---

## 1. 安装 Node.js

### Ubuntu / Debian

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### CentOS / RHEL / Rocky / AlmaLinux

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs      # 或 sudo dnf install -y nodejs
```

### 验证

```bash
node --version    # 应 >= v14,推荐 v20
npm --version
```

---

## 2. 拉取代码

```bash
cd ~YOURHOME

# 推荐:从 GitHub clone(以后 git pull 即可更新)
git clone https://github.com/victory1128/use_machine.git
cd use_machine
```

> 若服务器已配置 GitHub SSH key,也可用 `git clone git@github.com:victory1128/use_machine.git`。

试跑确认:

```bash
node server.js
# 出现 "机器复用网站 running on http://localhost:3000" 即成功
# Ctrl+C 停掉,下面用守护进程跑
```

---

## 3. systemd 守护进程(开机自启 + 自动重启)

创建服务文件:

```bash
sudo tee /etc/systemd/system/use-machine.service > /dev/null <<'EOF'
[Unit]
Description=Machine/NPU Reuse Web
After=network.target

[Service]
Type=simple
User=YOURUSER
WorkingDirectory=YOURHOME/use_machine
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

> - `User` 填你的用户名(如 `ubuntu`、`root` 等)
> - `WorkingDirectory` 填 clone 出来的实际路径(如 `/home/ubuntu/use_machine`)
> - `ExecStart` 若 `node` 不在 `/usr/bin/node`,用 `which node` 查实际路径替换
> - 想换端口:改 `Environment=PORT=8080`

启用并启动:

```bash
sudo systemctl daemon-reload
sudo systemctl enable use-machine     # 开机自启
sudo systemctl start use-machine      # 启动
sudo systemctl status use-machine     # 查看状态(应为 active running)
```

常用运维命令:

```bash
sudo systemctl restart use-machine    # 重启(改代码/配置后)
sudo systemctl stop use-machine       # 停止
sudo journalctl -u use-machine -f     # 实时看日志
sudo journalctl -u use-machine -n 100 # 看最近 100 行日志
```

---

## 4. 放行防火墙端口

### Ubuntu / Debian (ufw)

```bash
sudo ufw allow 3000/tcp
sudo ufw reload
sudo ufw status
```

### CentOS / RHEL (firewalld)

```bash
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

### 云服务器额外注意

若用的是阿里云/腾讯云/AWS 等,**还需在云控制台的安全组**里放行 3000 端口(入方向 TCP),仅服务器防火墙放行不够。

此时浏览器访问 `http://服务器公网IP:3000` 应能看到页面。

---

## 5. (推荐)Nginx 反向代理:走 80 端口 + 可选 HTTPS

直接用 3000 端口也能用,但用 Nginx 转发到 80 更规范,且便于加域名和 HTTPS。

### 安装 Nginx

```bash
# Ubuntu / Debian
sudo apt install -y nginx

# CentOS / RHEL
sudo yum install -y nginx
sudo systemctl enable --now nginx
```

### 配置站点

```bash
sudo tee /etc/nginx/conf.d/use-machine.conf > /dev/null <<'EOF'
server {
    listen 80;
    server_name 你的域名或IP;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF
```

> `server_name` 填域名(如 `gpu.yourlab.com`)或服务器 IP。CentOS 上配置文件目录也可能是 `/etc/nginx/default.d/`,按你的 nginx.conf `include` 路径为准。

测试并重载:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

放行 80 端口(云安全组也要放行):

```bash
# Ubuntu
sudo ufw allow 80/tcp
# CentOS
sudo firewall-cmd --add-port=80/tcp --permanent && sudo firewall-cmd --reload
```

访问 `http://你的域名或IP`(80 端口,可省略 `:80`)。

### 可选:加 HTTPS(有域名时)

```bash
sudo apt install -y certbot python3-certbot-nginx    # Ubuntu
sudo certbot --nginx -d 你的域名
# 按提示操作,自动配好 HTTPS 证书并定时续期
```

---

## 6. 更新代码

以后代码推到 GitHub 后,服务器上更新:

```bash
cd ~YOURHOME/use_machine
git pull
sudo systemctl restart use-machine
```

---

## 7. 数据与备份

- **运行时数据**:`data.json`(运行时自动生成,记录所有机器/占用/排队)
- `git pull` **不会**覆盖 `data.json`(已在 `.gitignore`),占用记录安全
- **清空重来**:删除后重启,会从 `seed.json` 重新播种:

  ```bash
  rm data.json
  sudo systemctl restart use-machine
  ```

- **备份**:定期复制 `data.json` 即可保住全部占用记录

  ```bash
  cp ~YOURHOME/use_machine/data.json /backup/data-$(date +%F).json
  ```

---

## 8. 排错

| 现象 | 排查 |
|---|---|
| `systemctl status` 显示 failed | `sudo journalctl -u use-machine -n 50` 看报错;检查 `WorkingDirectory` 路径、`ExecStart` 的 node 路径(`which node`) |
| 服务起来了但浏览器打不开 | 检查防火墙(第 4 步)+ 云安全组是否放行端口 |
| Nginx 502 Bad Gateway | 服务没跑起来,先 `systemctl status use-machine`;确认 `proxy_pass` 端口与 `Environment=PORT` 一致 |
| 端口被占用 | `sudo lsof -i:3000`,或改 `PORT` 环境变量换个端口 |
| 改了 systemd 文件不生效 | `sudo systemctl daemon-reload && sudo systemctl restart use-machine` |

---

## 快速命令清单(以 Ubuntu 为例)

```bash
# 一次性部署
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx
cd ~ && git clone https://github.com/victory1128/use_machine.git
# 创建 systemd 文件(见第 3 步,替换 YOURUSER / YOURHOME)
sudo systemctl daemon-reload && sudo systemctl enable --now use-machine
sudo ufw allow 3000/tcp && sudo ufw allow 80/tcp
# 配置 nginx(见第 5 步)
sudo nginx -t && sudo systemctl reload nginx

# 日常更新
cd ~/use_machine && git pull && sudo systemctl restart use-machine
```
