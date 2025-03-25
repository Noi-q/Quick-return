const express = require("express");
const axios = require("axios");
const TronWeb = require('tronweb');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const app = express();

// 获取配置文件路径
const configPath = path.join(process.pkg ? path.dirname(process.execPath) : __dirname, 'config.json');
const config = require(configPath);

// 创建日志目录
const logDir = path.join(process.pkg ? path.dirname(process.execPath) : __dirname, config.logging.log_dir);
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
        // 错误日志
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: config.logging.max_file_size,
            maxFiles: config.logging.max_files,
            tailable: true
        }),
        // 转账日志
        new winston.transports.File({
            filename: path.join(logDir, 'transfer.log'),
            level: 'info',
            maxsize: config.logging.max_file_size,
            maxFiles: config.logging.max_files,
            tailable: true
        }),
        // 系统日志
        new winston.transports.File({
            filename: path.join(logDir, 'system.log'),
            level: 'info',
            maxsize: config.logging.max_file_size,
            maxFiles: config.logging.max_files,
            tailable: true
        }),
        // 控制台输出
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// 创建按日期分类的日志目录
function getDateLogDir() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const dateDir = path.join(logDir, `${year}${month}${day}`);
    
    if (!fs.existsSync(dateDir)) {
        fs.mkdirSync(dateDir, { recursive: true });
    }
    return dateDir;
}

// 添加 JSON 解析中间件
app.use(express.json());

// API Key 轮询管理
let currentApiKeyIndex = 0;
const apiKeys = config.tron_api_keys;

function getNextApiKey() {
    currentApiKeyIndex = (currentApiKeyIndex + 1) % apiKeys.length;
    return apiKeys[currentApiKeyIndex];
}

// 创建多个 TronWeb 实例
const tronWebInstances = config.addresses.map(addr => {
    return new TronWeb({
        fullHost: config.tron.full_host,
        privateKey: addr.private_key,
        headers: { 
            "TRON-PRO-API-KEY": apiKeys[0],
            "Content-Type": "application/json"
        }
    });
});

// 重新初始化 TronWeb 实例
function reinitializeTronWeb(address) {
    const index = config.addresses.findIndex(addr => addr.address === address);
    if (index !== -1) {
        tronWebInstances[index] = new TronWeb({
            fullHost: config.tron.full_host,
            privateKey: config.addresses[index].private_key,
            headers: { 
                "TRON-PRO-API-KEY": apiKeys[currentApiKeyIndex],
                "Content-Type": "application/json"
            }
        });
        logger.info(`已重新初始化地址 ${address} 的 TronWeb 实例`);
    }
}

// 更新所有 TronWeb 实例的 API Key
function updateAllTronWebApiKeys() {
    const newApiKey = getNextApiKey();
    logger.info(`轮询切换到新的 API Key: ${newApiKey.substring(0, 8)}...`);
    
    tronWebInstances.forEach(tronWeb => {
        try {
            // 创建新的 headers 对象
            const headers = {
                "TRON-PRO-API-KEY": newApiKey,
                "Content-Type": "application/json"
            };
            // 使用 setHeader 方法设置 headers
            tronWeb.setHeader(headers);
            logger.info('API Key 更新成功');
        } catch (error) {
            logger.error(`更新 API Key 失败: ${error.message}`);
        }
    });
}

// 添加一个全局变量来跟踪定时器
let pingInterval = null;
let apiKeyInterval = null;

// 添加一个优雅关闭的函数
async function gracefulShutdown() {
    logger.info('正在关闭服务器...');
    if (pingInterval) {
        clearInterval(pingInterval);
        logger.info('已停止余额检测');
    }
    if (apiKeyInterval) {
        clearInterval(apiKeyInterval);
        logger.info('已停止 API Key 轮询');
    }
    process.exit(0);
}

// 监听进程终止信号
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// 转账记录管理
const transferRecordsPath = path.join(process.pkg ? path.dirname(process.execPath) : __dirname, config.transfer_records.file_path);
let transferRecords = {};

// 加载转账记录
function loadTransferRecords() {
    try {
        if (fs.existsSync(transferRecordsPath)) {
            const data = fs.readFileSync(transferRecordsPath, 'utf8');
            transferRecords = JSON.parse(data);
            logger.info('已加载转账记录');
        }
    } catch (error) {
        logger.error(`加载转账记录失败: ${error.message}`);
    }
}

// 保存转账记录
function saveTransferRecords() {
    try {
        fs.writeFileSync(transferRecordsPath, JSON.stringify(transferRecords, null, 2));
        logger.info('已保存转账记录');
    } catch (error) {
        logger.error(`保存转账记录失败: ${error.message}`);
    }
}

// 检查是否已经转账
function hasTransferred(address, amount) {
    const record = transferRecords[address];
    if (!record) return false;
    
    // 检查最近 5 分钟内的转账记录
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    
    return record.transfers.some(transfer => 
        transfer.amount === amount && 
        transfer.timestamp > fiveMinutesAgo
    );
}

// 网络费用管理
let networkFees = {
    energyPrice: config.tron.network_fee.default_energy_price,
    bandwidthPrice: config.tron.network_fee.default_bandwidth_price,
    lastUpdate: 0
};

// 获取网络费用
async function updateNetworkFees() {
    try {
        const now = Date.now();
        if (now - networkFees.lastUpdate < config.tron.network_fee.update_interval) {
            return networkFees;
        }

        const response = await axios.get(`${config.tron.full_host}/wallet/getchainparameters`, {
            headers: {
                "TRON-PRO-API-KEY": apiKeys[currentApiKeyIndex]
            }
        });

        // 检查响应数据格式
        if (!response.data || !response.data.chainParameter || !Array.isArray(response.data.chainParameter)) {
            logger.error('获取网络费用失败: API 返回数据格式不正确');
            return networkFees;
        }

        // 查找能量和带宽费用参数
        const energyFeeParam = response.data.chainParameter.find(param => param.key === 'getEnergyFee');
        const bandwidthFeeParam = response.data.chainParameter.find(param => param.key === 'getTransactionFee');

        if (energyFeeParam) {
            networkFees.energyPrice = parseInt(energyFeeParam.value);
        }
        if (bandwidthFeeParam) {
            networkFees.bandwidthPrice = parseInt(bandwidthFeeParam.value);
        }

        networkFees.lastUpdate = now;
        logger.info(`网络费用更新成功 - 能量价格: ${networkFees.energyPrice}, 带宽价格: ${networkFees.bandwidthPrice}`);
        return networkFees;
    } catch (error) {
        logger.error(`获取网络费用失败: ${error.message}`);
        if (error.response) {
            logger.error(`API 响应: ${JSON.stringify(error.response.data)}`);
        }
        return networkFees;
    }
}

// 获取账户资源信息
async function getAccountResources(tronWeb, address) {
    try {
        const account = await tronWeb.trx.getAccount(address);
        if (!account) {
            return {
                energy: 0,
                bandwidth: 0,
                trxBalance: 0
            };
        }

        // 获取账户 TRX 余额
        const trxBalance = await tronWeb.trx.getBalance(address);
        
        // 获取账户资源信息
        const accountResources = await tronWeb.trx.getAccountResources(address);
        
        return {
            energy: accountResources.EnergyLimit || 0,
            bandwidth: accountResources.NetLimit || 0,
            trxBalance: trxBalance / 1000000
        };
    } catch (error) {
        logger.error(`获取账户资源信息失败: ${error.message}`);
        return {
            energy: 0,
            bandwidth: 0,
            trxBalance: 0
        };
    }
}

// 计算转账所需的 GAS 费用
async function calculateGasFee(tronWeb, address, isNewAccount = false) {
    try {
        const fees = await updateNetworkFees();
        
        // 获取账户资源信息
        const resources = await getAccountResources(tronWeb, address);
        
        // TRON 网络标准转账费用
        const standardFee = 0.00001; // 0.00001 TRX
        
        // 计算能量费用
        let energyFee = 0;
        if (resources.energy < config.tron.energy_limit) {
            const neededEnergy = config.tron.energy_limit - resources.energy;
            energyFee = (neededEnergy * fees.energyPrice) / 1000000;
        }
        
        // 计算带宽费用
        let bandwidthFee = 0;
        if (resources.bandwidth < 265) {
            const neededBandwidth = 265 - resources.bandwidth;
            bandwidthFee = (neededBandwidth * fees.bandwidthPrice) / 1000000;
        }
        
        // 如果是新账户，需要支付激活费用
        const activationFee = isNewAccount ? 1 : 0; // 1 TRX
        
        // 总费用 = 标准转账费用 + 能量费用 + 带宽费用 + 激活费用
        const totalFee = standardFee + energyFee + bandwidthFee + activationFee;
        
        // 记录详细的费用信息
        logger.info(`GAS 费用计算详情:
        账户信息:
        - TRX余额: ${resources.trxBalance} TRX
        - 能量: ${resources.energy}
        - 带宽: ${resources.bandwidth}
        
        费用明细:
        - 标准转账费用: ${standardFee} TRX
        - 能量费用: ${energyFee} TRX (能量价格: ${fees.energyPrice}, 需要能量: ${config.tron.energy_limit - resources.energy})
        - 带宽费用: ${bandwidthFee} TRX (带宽价格: ${fees.bandwidthPrice}, 需要带宽: ${265 - resources.bandwidth})
        - 激活费用: ${activationFee} TRX
        
        总费用: ${totalFee} TRX`);
        
        return totalFee;
    } catch (error) {
        logger.error(`计算 GAS 费用失败: ${error.message}`);
        // 如果计算失败，返回一个保守的估计值
        return 0.265; // 返回 0.1 TRX 作为保守估计
    }
}

// 记录转账
function recordTransfer(address, amount, txid) {
    if (!transferRecords[address]) {
        transferRecords[address] = {
            transfers: []
        };
    }
    
    const transfer = {
        amount,
        txid,
        timestamp: Date.now()
    };
    
    transferRecords[address].transfers.push(transfer);
    
    // 只保留最近30天的记录
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    transferRecords[address].transfers = transferRecords[address].transfers.filter(
        transfer => transfer.timestamp > thirtyDaysAgo
    );
    
    saveTransferRecords();
    
    // 记录转账日志
    const dateLogDir = getDateLogDir();
    const transferLogPath = path.join(dateLogDir, `transfer_${address}.log`);
    const logMessage = `转账记录 - 地址: ${address}, 金额: ${amount} TRX, 交易ID: ${txid}, 时间: ${new Date().toISOString()}`;
    
    fs.appendFileSync(transferLogPath, logMessage + '\n');
    logger.info(logMessage);
}

// 检查账户是否已激活
async function isAccountActivated(tronWeb, address) {
    try {
        const account = await tronWeb.trx.getAccount(address);
        return account && account.address;
    } catch (error) {
        if (error.message.includes('Account not found')) {
            return false;
        }
        throw error;
    }
}

// 激活账户
async function activateAccount(tronWeb, address) {
    try {
        const account = await tronWeb.trx.getAccount(address);
        if (account && account.address) {
            logger.info(`账户 ${address} 已经激活`);
            return true;
        }
    } catch (error) {
        if (!error.message.includes('Account not found')) {
            throw error;
        }
    }

    try {
        logger.info(`开始激活账户 ${address}`);
        // 使用 createAccount 方法激活账户
        const transaction = await tronWeb.createAccount(address);
        logger.info(`账户激活成功: ${JSON.stringify(transaction)}`);
        return true;
    } catch (error) {
        logger.error(`账户激活失败: ${error.message}`);
        if (error.response) {
            logger.error(`API 响应: ${JSON.stringify(error.response.data)}`);
        }
        return false;
    }
}

// 转账成功记录管理
const transferSuccessRecordsPath = path.join(process.pkg ? path.dirname(process.execPath) : __dirname, 'transfer_success_records.json');
let transferSuccessRecords = [];

// 加载转账成功记录
function loadTransferSuccessRecords() {
    try {
        if (fs.existsSync(transferSuccessRecordsPath)) {
            const data = fs.readFileSync(transferSuccessRecordsPath, 'utf8');
            transferSuccessRecords = JSON.parse(data);
            logger.info('已加载转账成功记录');
        }
    } catch (error) {
        logger.error(`加载转账成功记录失败: ${error.message}`);
    }
}

// 保存转账成功记录
function saveTransferSuccessRecords() {
    try {
        fs.writeFileSync(transferSuccessRecordsPath, JSON.stringify(transferSuccessRecords, null, 2));
        logger.info('已保存转账成功记录');
    } catch (error) {
        logger.error(`保存转账成功记录失败: ${error.message}`);
    }
}

// 修改记录转账成功信息函数
async function recordTransferSuccess(tronWeb, fromAddress, toAddress, amount, txid) {
    try {
        // 等待交易确认
        let transaction = null;
        let block = null;
        let retryCount = 0;
        const maxRetries = 10;
        
        while (retryCount < maxRetries) {
            try {
                transaction = await tronWeb.trx.getTransaction(txid);
                if (transaction && transaction.blockNumber) {
                    block = await tronWeb.trx.getBlock(transaction.blockNumber);
                    break;
                }
            } catch (error) {
                logger.error(`获取交易信息失败 (尝试 ${retryCount + 1}/${maxRetries}): ${error.message}`);
            }
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        if (!transaction || !block) {
            throw new Error('无法获取交易信息或区块信息');
        }
        
        const record = {
            transfer_time: new Date().toISOString(),
            from_address: fromAddress,
            to_address: toAddress,
            amount: amount,
            amount_in_trx: `${amount} TRX`,
            txid: txid,
            block_number: transaction.blockNumber,
            block_timestamp: new Date(block.block_header.timestamp).toISOString(),
            confirmation_time: new Date().toISOString(),
            gas_fee: transaction.energy_fee ? transaction.energy_fee / 1000000 : 0,
            status: 'success'
        };
        
        // 添加到记录数组
        transferSuccessRecords.push(record);
        
        // 保存到文件
        saveTransferSuccessRecords();
        
        // 记录到日志
        logger.info(`转账成功记录已保存:
        转账时间: ${record.transfer_time}
        发送地址: ${record.from_address}
        接收地址: ${record.to_address}
        转账金额: ${record.amount_in_trx}
        交易哈希: ${record.txid}
        区块号: ${record.block_number}
        区块时间: ${record.block_timestamp}
        确认时间: ${record.confirmation_time}
        GAS费用: ${record.gas_fee} TRX
        状态: ${record.status}`);
        
        return record;
    } catch (error) {
        logger.error(`记录转账成功信息失败: ${error.message}`);
        return null;
    }
}

// 记录转账成功日志
function logTransferSuccess(fromAddress, toAddress, amount, txid, gasFee) {
    const dateLogDir = getDateLogDir();
    const transferSuccessLogPath = path.join(dateLogDir, 'transfer_success.log');
    
    const logData = {
        timestamp: new Date().toISOString(),
        fromAddress,
        toAddress,
        amount: `${amount} TRX`,
        gasFee: `${gasFee} TRX`,
        txid,
        status: 'success'
    };
    
    const logMessage = JSON.stringify(logData, null, 2);
    fs.appendFileSync(transferSuccessLogPath, logMessage + '\n');
    
    logger.info(`转账成功记录:
    时间: ${logData.timestamp}
    发送地址: ${logData.fromAddress}
    接收地址: ${logData.toAddress}
    转账金额: ${logData.amount}
    GAS费用: ${logData.gasFee}
    交易哈希: ${logData.txid}
    状态: ${logData.status}`);
}

// 添加多签钱包配置
const multiSignConfig = {
    ownerAddress: config.multi_sign.owner_address, // 被多签钱包地址
    ownerPrivateKey: config.multi_sign.owner_private_key, // 被多签钱包私钥
    signerAddress: config.multi_sign.signer_address, // 多签钱包地址
    signerPrivateKey: config.multi_sign.signer_private_key, // 多签钱包私钥
    requiredSignatures: config.multi_sign.required_signatures || 2 // 需要的签名数量
};

// 创建多签钱包的 TronWeb 实例
const ownerTronWeb = new TronWeb({
    fullHost: config.tron.full_host,
    privateKey: multiSignConfig.ownerPrivateKey,
    headers: { 
        "TRON-PRO-API-KEY": apiKeys[currentApiKeyIndex],
        "Content-Type": "application/json"
    }
});

const signerTronWeb = new TronWeb({
    fullHost: config.tron.full_host,
    privateKey: multiSignConfig.signerPrivateKey,
    headers: { 
        "TRON-PRO-API-KEY": apiKeys[currentApiKeyIndex],
        "Content-Type": "application/json"
    }
});

// 添加多签交易记录集合
const multiSignTransactions = new Map();

// 添加检查多签交易状态的函数
async function isMultiSignTransactionPending(fromAddress, toAddress, amount) {
    const key = `${fromAddress}_${toAddress}_${amount}`;
    const transaction = multiSignTransactions.get(key);
    
    if (!transaction) {
        return false;
    }

    try {
        const txInfo = await signerTronWeb.trx.getTransaction(transaction.txid);
        // 如果交易不存在或已经确认，则移除记录
        if (!txInfo || (txInfo.ret && txInfo.ret[0].contractRet === 'SUCCESS')) {
            multiSignTransactions.delete(key);
            return false;
        }
        return true;
    } catch (error) {
        if (error.message && error.message.includes('Transaction not found')) {
            // 如果交易找不到且已经过去了一定时间，认为交易失败
            const now = Date.now();
            if (now - transaction.timestamp > 30 * 60 * 1000) { // 30分钟超时
                multiSignTransactions.delete(key);
                return false;
            }
        }
        return true;
    }
}

// 记录多签交易
function recordMultiSignTransaction(fromAddress, toAddress, amount, txid) {
    const key = `${fromAddress}_${toAddress}_${amount}`;
    multiSignTransactions.set(key, {
        txid,
        timestamp: Date.now()
    });
}

// 修改多签交易函数
async function createMultiSignTransaction(tronWeb, toAddress, amount, fromAddress) {
    try {
        // 检查是否有待处理的相同交易
        if (await isMultiSignTransactionPending(fromAddress, toAddress, amount)) {
            logger.info(`已存在待处理的多签交易:
            发送地址: ${fromAddress}
            接收地址: ${toAddress}
            转账金额: ${amount / 1000000} TRX`);
            return null;
        }

        logger.info(`开始创建多签交易:
        多签账户地址: ${fromAddress}
        接收地址: ${toAddress}
        转账金额: ${amount / 1000000} TRX`);

        // 验证地址格式
        if (!tronWeb.isAddress(toAddress)) {
            throw new Error('接收地址格式无效');
        }

        // 检查账户余额
        const balance = await ownerTronWeb.trx.getBalance(fromAddress);
        if (balance < amount) {
            throw new Error(`余额不足，当前余额: ${balance / 1000000} TRX，需要: ${amount / 1000000} TRX`);
        }

        // 获取账户权限信息
        logger.info('获取账户权限信息...');
        const account = await ownerTronWeb.trx.getAccount(fromAddress);
        if (!account) {
            throw new Error('无法获取账户信息');
        }

        // 使用 ownerTronWeb 创建交易
        logger.info('创建交易...');
        const transaction = await ownerTronWeb.transactionBuilder.sendTrx(
            toAddress,
            amount,
            fromAddress,
            { permissionId: 0 }  // 使用 owner 权限
        );

        if (!transaction) {
            throw new Error('创建交易对象失败');
        }

        // 设置交易参数
        transaction.feeLimit = 1000000;
        transaction.energyLimit = 10000;

        // 使用 signerTronWeb 签名
        logger.info('使用 signer 账户签名...');
        const signedTransaction = await signerTronWeb.trx.multiSign(
            transaction,
            multiSignConfig.signerPrivateKey,
            0  // 使用 owner 权限类型
        );

        logger.info('签名结果:', JSON.stringify(signedTransaction, null, 2));

        if (!signedTransaction || !signedTransaction.signature) {
            throw new Error('签名失败');
        }
        logger.info('签名成功');

        // 广播交易
        logger.info('开始广播交易...');
        const result = await signerTronWeb.trx.broadcast(signedTransaction);
        
        logger.info('广播结果:', JSON.stringify(result, null, 2));

        if (!result || !result.result) {
            throw new Error('交易广播失败: ' + (result?.message || '未知错误'));
        }

        const txid = result.txid || result.transaction?.txID;
        if (!txid) {
            throw new Error('交易广播失败: 未获取到交易ID');
        }

        // 记录多签交易
        recordMultiSignTransaction(fromAddress, toAddress, amount, txid);

        logger.info(`交易已广播，交易ID: ${txid}`);
        
        // 等待交易确认
        let isConfirmed = false;
        let retryCount = 0;
        const maxRetries = 20;
        
        while (!isConfirmed && retryCount < maxRetries) {
            try {
                const txInfo = await signerTronWeb.trx.getTransaction(txid);
                
                if (txInfo && txInfo.ret && txInfo.ret[0].contractRet === 'SUCCESS') {
                    isConfirmed = true;
                    logger.info(`交易已确认成功，交易ID: ${txid}`);
                    break;
                }
                
                await new Promise(resolve => setTimeout(resolve, 3000));
                retryCount++;
                logger.info(`等待交易确认中... (${retryCount}/${maxRetries})`);
            } catch (error) {
                if (error.message && error.message.includes('Transaction not found')) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    retryCount++;
                    continue;
                }
                throw error;
            }
        }
        
        if (!isConfirmed) {
            throw new Error('交易确认超时');
        }
        
        return {
            success: true,
            txid: txid,
            result: result
        };
    } catch (error) {
        const errorMessage = error.message || '未知错误';
        const errorDetails = error.response?.data || {};
        
        logger.error(`创建多签交易失败:
        错误信息: ${errorMessage}
        错误详情: ${JSON.stringify(errorDetails)}
        多签账户地址: ${fromAddress}
        接收地址: ${toAddress}
        转账金额: ${amount / 1000000} TRX`);

        throw error;
    }
}

// 修改 checkAndTransferAddress 函数中的转账部分
async function checkAndTransferAddress(tronWeb, address, receivingAddress) {
    try {
        // 检查接收账户是否已激活
        const isActivated = await isAccountActivated(tronWeb, receivingAddress);
        if (!isActivated) {
            logger.info(`接收账户 ${receivingAddress} 未激活，尝试激活账户`);
            const activationSuccess = await activateAccount(tronWeb, receivingAddress);
            if (!activationSuccess) {
                logger.error(`接收账户 ${receivingAddress} 激活失败，跳过转账`);
                return;
            }
        }

        const balance = await tronWeb.trx.getBalance(address);
        const trxBalance = balance / 1000000;
        
        const dateLogDir = getDateLogDir();
        const balanceLogPath = path.join(dateLogDir, `balance_${address}.log`);
        const balanceMessage = `余额检查 - 地址: ${address}, 余额: ${trxBalance} TRX, 时间: ${new Date().toISOString()}`;
        
        fs.appendFileSync(balanceLogPath, balanceMessage + '\n');
        logger.info(balanceMessage);
        
        if (trxBalance > 1) {
            // 计算 GAS 费用
            const gasFee = await calculateGasFee(tronWeb, address);
            
            // 计算最大可转账金额
            const maxTransferAmount = trxBalance - 1 - gasFee;
            const transferAmount = Math.floor(maxTransferAmount * 1000000) / 1000000;
            
            if (transferAmount <= 0) {
                const insufficientMessage = `余额不足 - 地址: ${address}, 余额: ${trxBalance} TRX, 所需费用: ${gasFee} TRX, 时间: ${new Date().toISOString()}`;
                fs.appendFileSync(balanceLogPath, insufficientMessage + '\n');
                logger.info(insufficientMessage);
                return;
            }
            
            logger.info(`地址 ${address} 检测到余额大于 1 TRX，准备转账 ${transferAmount} TRX...`);
            logger.info(`预计 GAS 费用: ${gasFee} TRX`);
            logger.info(`转账后预计余额: ${(trxBalance - transferAmount - gasFee).toFixed(6)} TRX`);
            
            const receiverBalance = await tronWeb.trx.getBalance(receivingAddress);
            logger.info(`接收地址 ${receivingAddress} 当前余额: ${receiverBalance / 1000000} TRX`);

            // 创建并广播交易
            let transaction;
            try {
                // 使用多签交易创建方法
                transaction = await createMultiSignTransaction(
                    tronWeb,
                    receivingAddress,
                    transferAmount * 1000000,
                    address
                );
                
                if (!transaction || !transaction.txid) {
                    throw new Error('交易创建失败：未获取到交易ID');
                }
                
                logger.info(`交易创建成功，交易ID: ${transaction.txid}`);
                
                // 等待交易确认
                let confirmed = false;
                let confirmRetryCount = 0;
                const maxConfirmRetries = 20;
                const confirmationInterval = 5000; // 5秒检查一次
                
                while (confirmRetryCount < maxConfirmRetries && !confirmed) {
                    try {
                        const txInfo = await tronWeb.trx.getTransactionInfo(transaction.txid);
                        
                        if (txInfo && txInfo.blockNumber) {
                            confirmed = true;
                            logger.info(`交易 ${transaction.txid} 已确认，区块号: ${txInfo.blockNumber}`);
                            break;
                        }
                        
                        if (txInfo && txInfo.receipt && txInfo.receipt.result === 'FAILED') {
                            throw new Error('交易执行失败');
                        }
                        
                        logger.info(`交易 ${transaction.txid} 等待确认中... (尝试 ${confirmRetryCount + 1}/${maxConfirmRetries})`);
                        await new Promise(resolve => setTimeout(resolve, confirmationInterval));
                        confirmRetryCount++;
                    } catch (error) {
                        if (error.message.includes('Transaction not found')) {
                            logger.warn(`交易 ${transaction.txid} 未找到，继续等待...`);
                            await new Promise(resolve => setTimeout(resolve, confirmationInterval));
                            confirmRetryCount++;
                            continue;
                        }
                        throw error;
                    }
                }
                
                if (!confirmed) {
                    throw new Error('交易确认超时');
                }
                
                // 验证转账后的余额
                const newBalance = await tronWeb.trx.getBalance(address);
                const newTrxBalance = newBalance / 1000000;
                logger.info(`转账后实际余额: ${newTrxBalance} TRX`);
                
                if (newTrxBalance > 1) {
                    logger.warn(`转账后余额 ${newTrxBalance} TRX 超过预期，将在下次检测时继续转账`);
                }
                
                // 记录转账成功
                recordTransfer(address, transferAmount, transaction.txid);
                
                // 记录转账成功信息
                const successRecord = await recordTransferSuccess(
                    tronWeb,
                    address,
                    receivingAddress,
                    transferAmount,
                    transaction.txid
                );
                
                if (successRecord) {
                    logTransferSuccess(
                        address,
                        receivingAddress,
                        transferAmount,
                        transaction.txid,
                        transaction.energy_fee / 1000000
                    );
                }
                
            } catch (error) {
                const errorMessage = error.message || '未知错误';
                logger.error(`多签转账失败: ${errorMessage}`);
                
                if (errorMessage.includes('balance is not sufficient') || 
                    errorMessage.includes('CONTRACT_VALIDATE_ERROR')) {
                    logger.error(`地址 ${address} 余额不足，停止重试`);
                    return;
                }
                
                throw error;
            }
        } else {
            logger.info(`地址 ${address} 余额不足 1 TRX，跳过转账`);
        }
    } catch (error) {
        const errorMessage = `余额检查失败 - 地址: ${address}, 错误: ${error.message || '未知错误'}, 时间: ${new Date().toISOString()}`;
        logger.error(errorMessage);
        throw error;
    }
}

// 添加重试机制
async function retryWithBackoff(fn, maxRetries = 3, delay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }
}

// 修改余额检测函数
async function checkAllAddresses() {
    for (let i = 0; i < config.addresses.length; i++) {
        const address = config.addresses[i];
        let tronWeb = tronWebInstances[i];
        
        try {
            await retryWithBackoff(async () => {
                await checkAndTransferAddress(tronWeb, address.address, address.receiving_address);
            }, 3, 2000); // 最多重试3次，初始延迟2秒
        } catch (error) {
            logger.error(`地址 ${address.address} 检测失败: ${error.message}`);
            // 尝试切换 API Key
            updateAllTronWebApiKeys();
            // 重新初始化当前地址的 TronWeb 实例
            reinitializeTronWeb(address.address);
        }
    }
}

// 测试连接
async function testConnection() {
    try {
        const block = await tronWebInstances[0].trx.getCurrentBlock();
        logger.info(`TronWeb 连接成功，当前区块: ${block.block_header.raw_data.number}`);
    } catch (error) {
        logger.error(`TronWeb 连接失败: ${error.message}`);
        try {
            const response = await axios.get(`${config.tron.full_host}/wallet/getnowblock`, {
                headers: {
                    "TRON-PRO-API-KEY": apiKeys[currentApiKeyIndex]
                }
            });
            logger.info(`直接 API 调用成功: ${response.data.block_header.raw_data.number}`);
        } catch (apiError) {
            logger.error(`直接 API 调用也失败: ${apiError.response?.data || apiError.message}`);
        }
    }
}

app.get("/", (req, res) => {
    res.send("Tron 多地址监控服务稳定运行中...");
});

app.get("/ping", async (req, res) => {
    try {
        res.send("正在检测中..." + new Date().toLocaleString());
        await checkAllAddresses();
    } catch (error) {
        logger.error(`检测过程发生错误: ${error.message}`);
        res.status(500).send("检测失败，请稍后重试");
    }
});

// TRX转账
app.post("/transferTRX", async (req, res) => {
    try {
        const { toAddress, amount, privateKey } = req.body;
        
        logger.info('开始多签转账请求:', { toAddress, amount });
        
        if (!toAddress || !amount || !privateKey) {
            return res.status(400).json({
                success: false,
                error: "缺少必要参数：toAddress、amount 或 privateKey"
            });
        }

        // 创建临时 TronWeb 实例
        const tempTronWeb = new TronWeb({
            fullHost: config.tron.full_host,
            privateKey: privateKey,
            headers: { 
                "TRON-PRO-API-KEY": apiKeys[currentApiKeyIndex],
                "Content-Type": "application/json"
            }
        });

        // 验证并转换地址格式
        let validAddress = toAddress;
        try {
            const hexAddress = tempTronWeb.address.toHex(toAddress);
            validAddress = tempTronWeb.address.fromHex(hexAddress);
            logger.info('地址转换成功:', validAddress);
        } catch (error) {
            logger.error('地址格式无效:', error);
            return res.status(400).json({
                success: false,
                error: "地址格式无效"
            });
        }

        if (amount <= 0) {
            logger.error("转账金额必须大于0");
            return res.status(400).json({
                success: false,
                error: "转账金额必须大于0"
            });
        }

        // 检查账户余额
        const balance = await tempTronWeb.trx.getBalance(tempTronWeb.address.fromPrivateKey(privateKey));
        const amountInSun = amount * 1000000;
        
        logger.info('当前余额:', balance, 'SUN');
        logger.info('转账金额:', amountInSun, 'SUN');
        
        if (balance < amountInSun) {
            logger.error("账户余额不足");
            return res.status(400).json({
                success: false,
                error: "账户余额不足"
            });
        }

        // 使用新的多签交易创建方法
        const transaction = await createMultiSignTransaction(
            tempTronWeb,
            validAddress,
            amountInSun,
            tempTronWeb.address.fromPrivateKey(privateKey)
        );

        logger.info('多签转账成功:', transaction);
        res.json({
            success: true,
            data: transaction
        });
    } catch (error) {
        logger.error("多签转账失败:", error);
        res.status(500).json({
            success: false,
            error: error.message || "多签转账失败，请稍后重试",
            details: error.response?.data || error
        });
    }
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ 
    port: config.websocket.port,
    host: config.websocket.host
});

wss.on('connection', (ws) => {
    logger.info('监控客户端已连接');
    
    // 发送心跳消息
    const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'heartbeat',
                timestamp: new Date().toISOString(),
                status: 'running'
            }));
        }
    }, config.websocket.heartbeat_interval);

    ws.on('close', () => {
        clearInterval(heartbeat);
        logger.info('监控客户端已断开连接');
    });
});

// 修改定时检测逻辑
async function startMonitoring() {
    try {
        logger.info('开始定时监控...');
        
        // 立即执行一次检测
        await checkAllAddresses();
        
        // 设置30秒定时器
        pingInterval = setInterval(async () => {
            try {
                logger.info(`开始检测账户余额 - ${new Date().toLocaleString()}`);
                await checkAllAddresses();
                logger.info(`检测完成 - ${new Date().toLocaleString()}`);
            } catch (error) {
                logger.error(`余额检测失败: ${error.message}`);
                // 如果是连接问题，尝试重新连接
                if (error.code === 'ECONNREFUSED' || error.message.includes('timeout')) {
                    logger.info('尝试重新连接...');
                    await testConnection();
                }
                // 切换 API Key
                updateAllTronWebApiKeys();
            }
        }, 30000); // 30秒检测一次
        
        logger.info('定时监控已启动，每30秒检测一次');
    } catch (error) {
        logger.error(`启动监控失败: ${error.message}`);
        throw error;
    }
}

// 修改服务器启动部分
app.listen(config.port, async () => {
    try {
        loadTransferRecords(); // 加载转账记录
        loadTransferSuccessRecords(); // 加载转账成功记录
        logger.info(`服务器启动成功，监听端口: ${config.port}`);
        logger.info(`服务器地址: http://${config.host}:${config.port}`);
        logger.info(`配置了 ${config.addresses.length} 个地址进行监控`);
        logger.info(`配置了 ${apiKeys.length} 个 API Key 进行轮询`);
        
        await testConnection();
        
        // 启动定时监控
        await startMonitoring();

        // API Key 轮询
        logger.info('开始 API Key 轮询...');
        apiKeyInterval = setInterval(() => {
            updateAllTronWebApiKeys();
        }, config.monitor.api_key_rotate_interval);
        
    } catch (error) {
        logger.error(`服务器启动失败: ${error.message}`);
        process.exit(1);
    }
});
