const WebSocket = require('ws');
const { spawn } = require('child_process');
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// 加载配置文件
const configPath = path.join(__dirname, 'config.json');
const config = require(configPath);

// 创建日志目录
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// 创建日志记录器
const logger = winston.createLogger({
    level: config.logging.level,
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logDir, 'monitor.log'),
            maxsize: config.logging.max_file_size,
            maxFiles: config.logging.max_files
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// WebSocket 配置
const wsConfig = {
    wsUrl: `ws://${config.websocket.host}:${config.websocket.port}`,
    checkInterval: config.websocket.check_interval,
    maxRetries: config.websocket.max_retries,
    retryDelay: config.websocket.retry_delay,
    processPath: path.join(__dirname, 'index.js')
};

let ws = null;
let retryCount = 0;
let isConnecting = false;
let childProcess = null;

// 启动 index.js
function startIndexJs() {
    if (childProcess) {
        logger.info('停止现有的 index.js 进程');
        childProcess.kill();
    }

    logger.info('启动 index.js');
    childProcess = spawn('node', [wsConfig.processPath]);

    childProcess.stdout.on('data', (data) => {
        logger.info(`index.js 输出: ${data}`);
    });

    childProcess.stderr.on('data', (data) => {
        logger.error(`index.js 错误: ${data}`);
    });

    childProcess.on('close', (code) => {
        logger.info(`index.js 进程退出，退出码: ${code}`);
        childProcess = null;
    });
}

// 连接 WebSocket
function connectWebSocket() {
    if (isConnecting) return;
    isConnecting = true;

    ws = new WebSocket(wsConfig.wsUrl);

    ws.on('open', () => {
        logger.info('WebSocket 连接成功');
        isConnecting = false;
        retryCount = 0;
    });

    ws.on('message', (data) => {
        logger.info(`收到消息: ${data}`);
    });

    ws.on('close', () => {
        logger.warn('WebSocket 连接关闭');
        isConnecting = false;
        handleConnectionLoss();
    });

    ws.on('error', (error) => {
        logger.error(`WebSocket 错误: ${error.message}`);
        isConnecting = false;
        handleConnectionLoss();
    });
}

// 处理连接丢失
function handleConnectionLoss() {
    if (retryCount < wsConfig.maxRetries) {
        retryCount++;
        logger.info(`尝试重新连接 (${retryCount}/${wsConfig.maxRetries})...`);
        setTimeout(connectWebSocket, wsConfig.retryDelay);
    } else {
        logger.error('达到最大重试次数，重启 index.js');
        startIndexJs();
        retryCount = 0;
        setTimeout(connectWebSocket, wsConfig.retryDelay);
    }
}

// 定期检查连接状态
function checkConnection() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
    } else if (!isConnecting) {
        connectWebSocket();
    }
}

// 启动监控
function startMonitoring() {
    logger.info('启动监控服务');
    connectWebSocket();
    setInterval(checkConnection, wsConfig.checkInterval);
}

// 优雅关闭
function gracefulShutdown() {
    logger.info('正在关闭监控服务...');
    if (ws) {
        ws.close();
    }
    if (childProcess) {
        childProcess.kill();
    }
    process.exit(0);
}

// 监听进程终止信号
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// 启动监控
startMonitoring(); 