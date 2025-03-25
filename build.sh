#!/bin/bash

# 设置错误时退出
set -e

echo "开始打包 Tron 监控服务..."

# 检查 Node.js 版本
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js 18.x"
    exit 1
fi

# 检查 npm 版本
if ! command -v npm &> /dev/null; then
    echo "错误: 未找到 npm，请先安装 npm"
    exit 1
fi

# 清理之前的构建
echo "清理之前的构建..."
npm run clean

# 安装依赖
echo "安装依赖..."
npm install

# 构建所有平台
echo "开始构建..."
npm run build:all

# 创建发布目录
echo "创建发布包..."
mkdir -p dist/release

# 复制配置文件
echo "复制配置文件..."
cp config.json dist/release/

# 创建启动脚本
echo "创建启动脚本..."
cat > dist/release/start.sh << 'EOL'
#!/bin/bash
# 获取脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 根据操作系统选择可执行文件
if [[ "$OSTYPE" == "darwin"* ]]; then
    EXECUTABLE="./tron-monitor-macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    EXECUTABLE="./tron-monitor-linux"
else
    echo "不支持的操作系统"
    exit 1
fi

# 设置执行权限
chmod +x "$EXECUTABLE"

# 运行程序
"$EXECUTABLE"
EOL

# 设置启动脚本权限
chmod +x dist/release/start.sh

# 创建 Windows 启动脚本
echo "创建 Windows 启动脚本..."
cat > dist/release/start.bat << 'EOL'
@echo off
start tron-monitor-win.exe
EOL

# 创建说明文件
echo "创建说明文件..."
cat > dist/release/README.md << 'EOL'
# Tron 监控服务

## 使用说明

### Linux/macOS
1. 打开终端
2. 进入程序目录
3. 运行启动脚本：
   ```bash
   ./start.sh
   ```

### Windows
1. 双击 `start.bat` 运行程序
2. 或在命令行中运行：
   ```cmd
   start.bat
   ```

## 配置说明
- 配置文件：`config.json`
- 日志文件：`logs` 目录
- 转账记录：`transfer_records.json`

## 注意事项
1. 首次运行前请确保已正确配置 `config.json`
2. 确保有足够的磁盘空间用于日志记录
3. 程序会自动创建必要的目录和文件
EOL

# 创建发布包
echo "创建发布包..."
cd dist/release
zip -r ../tron-monitor-release.zip ./*
cd ../..

echo "打包完成！"
echo "发布包位置：dist/tron-monitor-release.zip" 