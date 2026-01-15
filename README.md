# 🎬 YouTube频道批量下载器

一个简单易用的Web应用，用于批量下载多个YouTube频道的视频。支持多频道、多画质选择，实时显示下载进度。

## ✨ 功能特性

- 📺 **批量频道支持** - 一次性输入多个频道URL
- 🎥 **智能视频获取** - 自动获取频道所有视频信息
- ✅ **灵活选择** - 支持单选/全选视频
- 🎨 **画质选择** - 支持1080p、720p、480p三档画质
- ⬇️ **批量下载** - 同时下载多个视频
- 📊 **实时进度** - Socket.io实时显示下载进度和速度
- 🎯 **简单易用** - 无需注册，打开即用

## 📋 前置要求

在使用本项目之前，请确保已安装以下工具：

- **Node.js** v16.0+ （推荐v18+）
- **yt-dlp** 最新版本
- **ffmpeg** 最新版本（用于合并视频和音频）

## 🚀 快速开始

### 1. 安装必要工具

**macOS:**
```bash
# 安装yt-dlp
brew install yt-dlp

# 安装ffmpeg（必须！用于合并视频音频）
brew install ffmpeg
```

**验证安装:**
```bash
yt-dlp --version
ffmpeg -version
```

### 2. 安装项目依赖

```bash
npm install
```

### 3. 启动服务器

```bash
node server.js
```

### 4. 访问应用

打开浏览器访问：**http://localhost:3000**

## 📖 使用说明

### 步骤1：输入频道URL
在文本框中输入YouTube频道URL，每行一个。支持以下格式：
```
https://www.youtube.com/@channelname
https://www.youtube.com/c/channelname
https://www.youtube.com/channel/UCxxxxxxxxx
```

### 步骤2：选择视频
- 点击"获取视频列表"按钮
- 等待视频列表加载完成
- 勾选想要下载的视频（可使用全选功能）
- 选择画质（推荐720p）

### 步骤3：开始下载
- 点击"开始下载"按钮
- 实时查看下载进度
- 下载完成的视频保存在 `downloads/` 文件夹

## 📁 项目结构

```
youtube-dl/
├── server.js           # Node.js后端服务器
├── public/             # 前端静态文件
│   └── index.html     # 单页应用界面
├── downloads/          # 下载的视频存储目录
├── package.json        # npm配置文件
├── .gitignore         # Git忽略文件
└── README.md          # 项目说明文档
```

## 🛠️ 技术栈

**后端：**
- Node.js + Express
- Socket.io (实时通信)
- yt-dlp (视频下载引擎)

**前端：**
- 原生HTML5 + CSS3 + JavaScript
- Socket.io Client
- 响应式设计

## 🔧 配置说明

### 修改端口

如果3000端口被占用，可以修改 `server.js` 最后部分：
```javascript
const PORT = process.env.PORT || 3000;  // 改为其他端口如3001
```

### 调整下载并发数

在 `server.js` 中找到以下代码并调整延迟时间：
```javascript
setTimeout(() => {
  downloadVideo(video.id, video.url, quality, video.title);
}, index * 1000); // 调整这个1000（毫秒）数值
```

## ❓ 常见问题

### Q1: 提示"ffmpeg未安装"或下载失败
```bash
# 安装ffmpeg
brew install ffmpeg

# 验证安装
ffmpeg -version
```

### Q2: HTTP Error 403: Forbidden
这个问题已在最新版本中修复。如果仍然遇到：
- 确保yt-dlp已更新到最新版本：`brew upgrade yt-dlp`
- 重启服务器
- 某些视频可能有地区限制

### Q3: yt-dlp命令找不到
```bash
# 检查安装
which yt-dlp

# macOS安装
brew install yt-dlp

# 更新到最新版
brew upgrade yt-dlp
```

### Q4: 某些视频无法下载
- 检查视频是否在您的地区可用
- 更新yt-dlp到最新版本
- 查看后端终端的错误日志
- 某些私密或会员专属视频无法下载

### Q5: 下载速度慢
- YouTube可能有速率限制
- 调整下载并发数（见上方配置说明）
- 考虑使用代理

### Q6: 端口被占用
```bash
# 查看端口占用
lsof -i :3000

# 或修改为其他端口（见上方配置说明）
```

## 🎯 开发计划

- [ ] 支持下载暂停/恢复
- [ ] 支持播放列表URL
- [ ] 添加视频搜索功能
- [ ] 导出下载历史
- [ ] 视频格式转换
- [ ] Docker容器化部署

## ⚠️ 法律声明

本项目仅供个人学习研究使用，请勿用于商业目的。

下载的视频内容版权归原作者所有，使用者需遵守相关法律法规和YouTube服务条款。

请尊重内容创作者的劳动成果，合理使用本工具。

## 📝 许可证

MIT License

## 🤝 贡献

欢迎提交Issue和Pull Request！

## 📧 联系方式

如有问题或建议，欢迎通过GitHub Issues联系。

---

**⭐ 如果这个项目对您有帮助，欢迎给个Star！**
