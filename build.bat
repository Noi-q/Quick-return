@echo off
echo 开始打包 Tron 监控服务...

REM 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: 未找到 Node.js，请先安装 Node.js 18.x
    exit /b 1
)

REM 检查 npm
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: 未找到 npm，请先安装 npm
    exit /b 1
)

REM 清理之前的构建
echo 清理之前的构建...
call npm run clean
if %errorlevel% neq 0 (
    echo 错误: 清理失败
    exit /b 1
)

REM 安装依赖
echo 安装依赖...
call npm install
if %errorlevel% neq 0 (
    echo 错误: 安装依赖失败
    exit /b 1
)

REM 构建所有平台
echo 开始构建...
call npm run build:all
if %errorlevel% neq 0 (
    echo 错误: 构建失败
    exit /b 1
)

REM 创建发布目录
echo 创建发布包...
if not exist "dist\release" mkdir "dist\release"

REM 复制配置文件
echo 复制配置文件...
copy /Y "config.json" "dist\release\"
if %errorlevel% neq 0 (
    echo 错误: 复制配置文件失败
    exit /b 1
)

REM 创建启动脚本
echo 创建启动脚本...
echo @echo off > "dist\release\start.bat"
echo start tron-monitor-win.exe >> "dist\release\start.bat"

REM 创建说明文件
echo 创建说明文件...
(
echo # Tron 监控服务
echo.
echo ## 使用说明
echo.
echo ### Windows
echo 1. 双击 `start.bat` 运行程序
echo 2. 或在命令行中运行：
echo    ```cmd
echo    start.bat
echo    ```
echo.
echo ## 配置说明
echo - 配置文件：`config.json`
echo - 日志文件：`logs` 目录
echo - 转账记录：`transfer_records.json`
echo.
echo ## 注意事项
echo 1. 首次运行前请确保已正确配置 `config.json`
echo 2. 确保有足够的磁盘空间用于日志记录
echo 3. 程序会自动创建必要的目录和文件
) > "dist\release\README.md"

REM 创建发布包
echo 创建发布包...
cd dist\release
powershell Compress-Archive -Path * -DestinationPath ..\tron-monitor-release.zip -Force
cd ..\..

echo 打包完成！
echo 发布包位置：dist\tron-monitor-release.zip 