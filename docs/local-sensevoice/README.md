# 给鲸鲸接入本地 SenseVoice 语音识别

鲸鲸把语音转成 16 kHz 单声道 WAV。这个接入方式让桥接把 WAV 交给本机 SenseVoice 服务，转写文字再进入聊天流程。识别在 CPU 上运行，语音回复和聊天模型沿用各自配置。

## 启动识别服务

1. 在脚本所在目录运行 `npm install sherpa-onnx-node`。
2. 从 [SenseVoice 文档](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html) 下载 SenseVoice INT8 模型。另下载 [Silero VAD 模型](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx)。将 `model.int8.onnx`、`tokens.txt` 和 `silero_vad.onnx` 放进同一个目录。
3. 在 PowerShell 中运行以下命令，将路径和示例口令替换为自己的设置。

~~~powershell
$env:WHALE_ASR_MODELS = 'C:\models\sensevoice'
$env:WHALE_ASR_TOKEN = 'replace-with-your-local-token'
node .\asr_server.cjs
~~~

另开窗口运行 `Invoke-RestMethod http://127.0.0.1:45124/health`。收到 `ok: true` 表示模型已载入、服务已监听。

## 配置鲸鲸 4.1.8.2

退出鲸鲸，备份生效的 `data/config.json`，把下面的字段写入已有的 `voice` 对象并保留其他设置，再启动鲸鲸与微信桥接。

~~~json
{
  "enabled": true,
  "provider": "dashscope",
  "baseUrl": "http://127.0.0.1:45124/generation",
  "model": "sensevoice-local",
  "apiKey": "replace-with-your-local-token"
}
~~~

`dashscope` 选择百炼兼容请求格式，连接地址是本机回环地址。口令与服务启动时一致。用自己录制的短语音确认转写。恢复原识别服务时，改回备份中的 `voice` 配置。 [鲸鲸语音识别实现](https://github.com/Banan1cee/whale_girl/blob/v4.1.8.2/bridge/voice.py)
