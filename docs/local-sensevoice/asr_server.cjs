'use strict';
const http = require('node:http');
const path = require('node:path');

const dataRoot = process.env.WHALE_ASR_MODELS;
if (!dataRoot) throw new Error('Set WHALE_ASR_MODELS to the model directory.');
const MODEL = path.join(dataRoot, 'model.int8.onnx');
const TOKENS = path.join(dataRoot, 'tokens.txt');
const VAD = path.join(dataRoot, 'silero_vad.onnx');
const HOST = '127.0.0.1';
const PORT = Number(process.env.WHALE_ASR_PORT || 45124);
const MAX_BODY = 16 * 1024 * 1024;
const TOKEN = process.env.WHALE_ASR_TOKEN;
if (!TOKEN) throw new Error('Set WHALE_ASR_TOKEN to a local access token.');
const sherpa = require(process.env.WHALE_ASR_ADDON || 'sherpa-onnx-node');
const SEGMENT_SECONDS = 30, MIN_SPEECH = 0.25, MIN_SILENCE = 0.5, THRESHOLD = 0.5, ONSET_PAD = 0.3;

const nativeConfig = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: MODEL, language: 'auto', useInverseTextNormalization: 1 },
    tokens: TOKENS, numThreads: 2, provider: 'cpu', debug: 0
  }
};

const recognizer = new sherpa.OfflineRecognizer(nativeConfig);
const detector = new sherpa.Vad({
  sileroVad: {
    model: VAD, threshold: THRESHOLD,
    minSilenceDuration: MIN_SILENCE, minSpeechDuration: MIN_SPEECH,
    maxSpeechDuration: SEGMENT_SECONDS, windowSize: 512
  },
  sampleRate: 16000, numThreads: 2, provider: 'cpu', debug: 0
}, SEGMENT_SECONDS + MIN_SILENCE + 1);

// 读取桥接所用的 16 kHz 单声道 PCM16 WAV。
function validateWave(buf) {
  const data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (data.length < 46
    || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE'
    || data.toString('ascii', 12, 16) !== 'fmt '
    || data.readUInt32LE(16) !== 16
    || data.readUInt16LE(20) !== 1
    || data.readUInt16LE(22) !== 1
    || data.readUInt32LE(24) !== 16000
    || data.readUInt32LE(28) !== 32000
    || data.readUInt16LE(32) !== 2
    || data.readUInt16LE(34) !== 16
    || data.toString('ascii', 36, 40) !== 'data'
    || data.readUInt32LE(4) !== data.length - 8
    || data.readUInt32LE(40) !== data.length - 44
    || (data.length - 44) % 2 !== 0) {
    throw new Error('Audio must be a canonical 16 kHz mono PCM16 WAV recording');
  }
  return (data.length - 44) / 32000;
}

function transcribe(wav) {
  const seconds = validateWave(wav);
  const pcm = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
  const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768);
  detector.reset();
  const texts = [];
  const onsetPadding = Math.round(ONSET_PAD * 16000);
  let isFirstSegment = true;
  const drain = () => {
    while (!detector.isEmpty()) {
      const segment = detector.front(false);
      let speech = segment.samples;
      if (isFirstSegment) {
        isFirstSegment = false;
        const from = Math.max(0, segment.start - onsetPadding);
        if (from < segment.start) {
          const restored = new Float32Array(segment.start - from + speech.length);
          restored.set(samples.subarray(from, segment.start));
          restored.set(speech, segment.start - from);
          speech = restored;
        }
      }
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: speech });
      recognizer.decode(stream);
      texts.push(recognizer.getResult(stream).text.trim());
      detector.pop();
    }
  };
  for (let offset = 0; offset < samples.length; offset += 512) {
    detector.acceptWaveform(samples.subarray(offset, offset + 512));
    drain();
  }
  detector.flush();
  drain();
  return { text: texts.filter(Boolean).join(' ').trim(), seconds };
}

function reply(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return reply(res, 200, {
      ok: true, service: 'sensevoice-local-asr',
      model: 'SenseVoice int8 via sherpa-onnx (offline CPU)', port: PORT
    });
  }
  if (req.method !== 'POST' || req.url !== '/generation') { req.resume(); return reply(res, 404, { error: 'Use POST' }); }

  if (req.headers.authorization !== 'Bearer ' + TOKEN) {
    req.resume();
    return reply(res, 401, { error: 'Invalid local access token' });
  }
  let size = 0;
  const chunks = [];
  req.on('data', (c) => { size += c.length; chunks.push(c); });
  req.on('end', () => {
    if (size > MAX_BODY) return reply(res, 413, { error: 'body too large' });
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const content = (body && body.input && body.input.messages && body.input.messages[0]
        && body.input.messages[0].content) || [];
      const audioItem = content.find((x) => x && typeof x.audio === 'string');
      if (!audioItem) return reply(res, 400, { error: 'missing input.messages[0].content[].audio' });
      const m = /^data:audio\/wav;base64,(.+)$/s.exec(audioItem.audio);
      if (!m) return reply(res, 400, { error: 'audio must be data:audio/wav;base64,...' });
      const wav = Buffer.from(m[1], 'base64');
      const out = transcribe(wav);
      // 阿里云百炼 /generation 兼容响应，WhaleGirl voice.py:78 直接取这个路径
      return reply(res, 200, {
        output: { choices: [{ message: { content: [{ text: out.text }] } }] }
      });
    } catch (e) {
      return reply(res, 400, { error: String((e && e.message) || e) });
    }
  });
  req.on('error', () => res.destroy());
});

server.listen(PORT, HOST, () => console.log('Listening on http://' + HOST + ':' + PORT));
