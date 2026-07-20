# 机器复用 · NPU 占用与排队

一个轻量的团队机器/NPU 卡共享占用与排队网站。零依赖(纯 Node.js 内置模块),开箱即用,适合实验室/小组共享计算卡资源。

## 功能

- **机器与卡管理**:`seed.json` 预置初始机器,页面也可随时增删改、加卡
- **占用**:
  - 全部占用(默认):点机器「占用」按钮,一键占满所有空闲卡
  - 按卡占用:切到该模式后,点单张卡只占那一张(支持部分占用)
  - 点自己占用的卡(蓝色)直接释放,或用「释放我的」批量释放
- **排队**:每台机器独立的等待队列,加入/退出,带序号和等待时长
- **顶部常驻身份**:名字 + 备注 + 8 个快捷标签(长期占用/训练中/…),`localStorage` 记忆,占用时自动带上
- **机器搜索**:按机器名/描述部分匹配实时过滤
- **机器信息编辑**:原地编辑名字/描述
- **实时同步**:前端每 4 秒轮询;编辑/排队输入时自动防刷新打断,打字不会被冲掉
- **浅色紧凑配色**:一页可放下多台机器
- **数据持久化**:状态存 `data.json`,重启不丢

## 快速开始

```bash
# 需要 Node.js 14+ (仅用内置模块,无需 npm install)
node server.js
```

默认运行在 `http://localhost:3000`。首次启动若没有 `data.json`,会自动从 `seed.json` 预置机器。

## 配置

### 端口

通过环境变量 `PORT` 修改:

```bash
PORT=8080 node server.js
```

### 预置机器

编辑 `seed.json`:

```json
{
  "machines": [
    { "name": "A100-Server-01", "cardCount": 8, "description": "8×A100 80GB, 训练专用" },
    { "name": "3090-Workstation", "cardCount": 4, "description": "4×RTX3090, 轻量任务" }
  ]
}
```

字段说明:
- `name`:机器名(必填)
- `cardCount`:NPU 卡数量(1–64)
- `cardLabels`:(可选)自定义每张卡的名字,省略则自动编号 `NPU0`、`NPU1`…
- `description`:(可选)机器描述

> 改完 `seed.json` 后,删除 `data.json` 再重启,即可重新播种。运行中通过页面增删的机器会存进 `data.json`,不会被 `seed.json` 覆盖。

## 用法

1. 顶部填好「我是 ___」(填一次,自动记忆),可选填备注、点快捷标签
2. 选模式:
   - **全部占用**(默认):点机器上的「占用」按钮 → 一键占满该机器所有空闲卡
   - **按卡占用**:点模式切换 → 点单张空闲卡只占那一张
3. 点自己占用的卡(蓝色高亮 + ✓)→ 释放;或点「释放我的」批量释放
4. 想等卡:点机器「排队」→ 填名字加入队列
5. 搜索框过滤机器;「✎」编辑机器信息;「+卡」加卡;「删」删除机器

卡上颜色含义:
- 🟢 淡绿 = 空闲
- 🟡 淡黄 = 被占用(显示占用者名)
- 🔵 淡蓝 = 我占用的(带 ✓)

## 项目结构

```
.
├── server.js          # 后端:零依赖 Node http 服务 + JSON 存储 + REST API
├── seed.json          # 预置机器配置(可改)
├── data.json          # 运行时数据(自动生成,已 gitignore)
├── .gitignore
└── public/            # 前端静态文件
    ├── index.html
    ├── style.css
    └── app.js
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 获取全部状态(机器/卡/队列/已知名字) |
| POST | `/api/machines` | 新建机器 `{name, cardCount, description?}` |
| PATCH | `/api/machines/:id` | 改机器 `{name?, description?}` |
| DELETE | `/api/machines/:id` | 删除机器 |
| POST | `/api/machines/:id/cards` | 增加卡 `{count}` |
| POST | `/api/machines/:id/occupy` | 占用 `{cardIds:[], user, info}` |
| POST | `/api/machines/:id/release` | 释放 `{cardIds?:[], user?}` |
| POST | `/api/machines/:id/queue` | 加入队列 `{user, info}` |
| POST | `/api/machines/:id/queue/:entryId/leave` | 退出队列 `{user}` |

## 部署到 Linux 服务器

见下方「部署指南」小节(或单独文档)。推荐用 `systemd` 守护进程 + Nginx 反向代理。

## 许可

MIT
