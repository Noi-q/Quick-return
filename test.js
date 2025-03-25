const TronWeb = require('tronweb');
const path = require('path');

// 获取配置文件路径
const configPath = path.join(process.pkg ? path.dirname(process.execPath) : __dirname, 'config.json');
const config = require(configPath);
// 添加多签钱包配置
const multiSignConfig = {
    ownerAddress: config.multi_sign.owner_address, // 被多签钱包地址
    ownerPrivateKey: config.multi_sign.owner_private_key, // 被多签钱包私钥
    signerAddress: config.multi_sign.signer_address, // 多签钱包地址
    signerPrivateKey: config.multi_sign.signer_private_key, // 多签钱包私钥
    requiredSignatures: config.multi_sign.required_signatures || 2 // 需要的签名数量
};
const tronWeb = new TronWeb({
  fullHost: config.tron.fullHost,
  privateKey: multiSignConfig.ownerPrivateKey
});
// 创建多签交易
async function createMultiSigTransaction() {
    const transaction = await tronWeb.transactionBuilder.sendTrx(
      multiSignConfig.signerAddress,
      1000000, // 1 TRX = 1,000,000 SUN
      multiSignConfig.signerAddress
    );
    
    // 第一个签名
    const signedTx = await tronWeb.trx.sign(transaction);
    
    // 将 signedTx 发送给其他签名者继续签名
    // ...
    
    // 广播已收集足够签名的交易
    const result = await tronWeb.trx.sendRawTransaction(signedTx);
    console.log(result);
  }
createMultiSigTransaction();