# Tron 多地址监控服务

这是一个基于 Node.js 的 Tron 网络多地址监控服务，可以自动监控多个 TRX 地址的余额，并在余额超过阈值时自动转账到指定地址。

## 功能特点

- 支持多地址监控
- 自动余额检测和转账
- API Key 自动轮询
- 转账失败自动重试
- 完整的日志记录
- 优雅的进程管理
- 可配置的参数系统
- 支持跨平台打包

## 系统要求

### 开发环境
- Node.js >= 12.0.0
- npm >= 6.0.0

### 运行环境
- Windows 7/10/11
- macOS 10.13+
- Linux (主流发行版)

## 安装步骤

### 开发环境安装

1. 克隆项目到本地：
```bash
git clone [项目地址]
cd [项目目录]
```

2. 安装依赖：
```bash
npm install
```

3. 配置 `config.json`：
```json
{
    "host": "localhost",
    "port": 3000,
    "tron_api_keys": [
        "你的API密钥1",
        "你的API密钥2",
        "你的API密钥3"
    ],
    "addresses": [
        {
            "address": "监控地址1",
            "private_key": "私钥1",
            "receiving_address": "接收地址1"
        }
    ],
    "tron": {
        "full_host": "https://api.trongrid.io",
        "min_balance": 1,
        "transfer_retry_times": 3,
        "transfer_retry_delay": 2000
    },
    "monitor": {
        "check_interval": 2000,
        "api_key_rotate_interval": 300000,
        "request_timeout": 5000
    },
    "logging": {
        "level": "info",
        "max_file_size": 5242880,
        "max_files": 5,
        "log_dir": "logs"
    }
}
```

### 打包说明

1. 安装打包工具：
```bash
npm install -g pkg
```

2. 打包命令：
```bash
# 打包所有平台
npm run build

# 打包特定平台
npm run build:linux  # Linux
npm run build:mac    # macOS
npm run build:win    # Windows
```

3. 打包后的文件位置：
- 打包后的文件位于 `dist` 目录
- 文件名格式：`tron-monitor-<平台>-<版本>`
  - Windows: `tron-monitor-win.exe`
  - macOS: `tron-monitor-macos`
  - Linux: `tron-monitor-linux`

### 运行打包后的程序

1. 将打包后的程序和 `config.json` 放在同一目录下
2. 运行程序：

Windows:
```bash
tron-monitor-win.exe
```

macOS/Linux:
```bash
chmod +x tron-monitor-<平台>
./tron-monitor-<平台>
```

## 配置说明

### 基础配置
- `host`: 服务器主机地址
- `port`: 服务器端口号

### Tron 网络配置
- `tron_api_keys`: Tron API 密钥数组
- `addresses`: 监控地址配置数组
  - `address`: 需要监控的地址
  - `private_key`: 地址对应的私钥
  - `receiving_address`: 接收转账的地址
- `tron`: Tron 网络相关配置
  - `full_host`: Tron 网络 API 地址
  - `min_balance`: 最小保留余额（TRX）
  - `transfer_retry_times`: 转账失败重试次数
  - `transfer_retry_delay`: 重试延迟时间（毫秒）

### 监控配置
- `monitor`: 监控相关配置
  - `check_interval`: 余额检测间隔（毫秒）
  - `api_key_rotate_interval`: API Key 轮询间隔（毫秒）
  - `request_timeout`: 请求超时时间（毫秒）

### 日志配置
- `logging`: 日志相关配置
  - `level`: 日志级别
  - `max_file_size`: 单个日志文件最大大小（字节）
  - `max_files`: 最大日志文件数量
  - `log_dir`: 日志目录

## API 接口

### 1. 首页
- 路径: `/`
- 方法: GET
- 描述: 返回服务状态信息

### 2. 余额检测
- 路径: `/ping`
- 方法: GET
- 描述: 手动触发余额检测
- 响应: 返回检测状态和时间戳

### 3. TRX 转账
- 路径: `/transferTRX`
- 方法: POST
- 描述: 手动执行 TRX 转账
- 请求体:
```json
{
    "toAddress": "接收地址",
    "amount": 转账金额,
    "privateKey": "私钥"
}
```
- 响应: 返回转账结果

## 日志说明

服务运行日志保存在程序所在目录的 `logs` 文件夹下：
- `combined.log`: 包含所有级别的日志
- `error.log`: 仅包含错误级别的日志

## 注意事项

1. 请妥善保管私钥信息，不要泄露给他人
2. 建议使用多个 API Key 进行轮询，避免触发限制
3. 确保服务器有足够的磁盘空间存储日志
4. 定期检查日志文件大小，避免占用过多空间
5. 打包后的程序需要和 `config.json` 放在同一目录下
6. 确保运行程序的用户对程序目录有读写权限

## 错误处理

服务包含以下错误处理机制：
1. 转账失败自动重试
2. API 调用失败自动切换 Key
3. 连接失败自动重连
4. 完整的错误日志记录

## 优雅关闭

服务支持优雅关闭，可以通过以下方式触发：
- 发送 SIGTERM 信号
- 发送 SIGINT 信号（Ctrl+C）
- Windows 下可以通过任务管理器关闭

关闭时会：
1. 停止余额检测
2. 停止 API Key 轮询
3. 记录关闭日志
4. 清理资源

## 贡献指南

欢迎提交 Issue 和 Pull Request 来帮助改进项目。

## 许可证

MIT License