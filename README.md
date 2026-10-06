# WaveForge 多轨音频工作站

基于 React、TypeScript、Vite、MUI、Zustand、Web Audio API、Wavesurfer 和 React
Router 构建的浏览器多轨音频编辑工作站。

## 功能

- 麦克风录音、导入音频和内置合成鼓组 / 和弦 / 贝斯片段
- 多轨片段拖动、跨轨移动、左右裁剪和吸附
- 轨道音量、声像、静音、独奏和片段复制
- 淡入淡出、低通 / 高通 / Echo 基础效果
- Web Audio API 统一时钟调度，多轨播放保持同步
- 循环区间、时间轴缩放、播放头和标尺定位
- Wavesurfer 按缩放级别重采样波形
- 音频素材保存在浏览器独立素材库（IndexedDB），工程记录只保留轨道、片段与素材索引；关闭或刷新页面后重新打开可继续编辑
- 旧版本工程记录中内嵌的音频会在首次打开时自动迁移到素材库
- 素材库容量不足时拒绝写入并列出未保存的文件，当前工程不会被破坏
- JSON 工程导出 / 导入（导出时音频内嵌，可跨浏览器继续编辑）

## 运行

```bash
export PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH"
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```

首次进入无需麦克风权限或外部音频文件，可以直接使用内置合成素材。
