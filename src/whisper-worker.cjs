'use strict';
// Whisper speech-to-text in its own process (src/dictation.cjs forks it, like the document worker): the GPU (Vulkan)
// build of whisper.cpp when it loads, else the CPU build, transcribing the 16 kHz mono 16-bit PCM it is sent.
const os = require('node:os');

const PLATFORM = `${process.platform}-${process.arch}`;
let native = null;
let context = null;

// The Vulkan build needs the system's Vulkan loader; without it, the CPU build.
function loadNative() {
  for (const name of [`@fugood/node-whisper-${PLATFORM}-vulkan`, `@fugood/node-whisper-${PLATFORM}`]) {
    try {
      return require(name);
    } catch { /* the next build */ }
  }
  throw new Error(`Local dictation has no speech engine for ${PLATFORM}.`);
}

const silence = seconds => new Int16Array(16000 * seconds).buffer;
// Threads speed the CPU build up to about 16 on a desktop CPU; two stay free for the app.
const threads = Math.max(1, Math.min(16, os.cpus().length - 2));
const transcribe = (audio, language) => context.transcribeData(audio, { language, temperature: 0, maxThreads: threads }).promise;

// Loads a model and warms it: the first call compiles GPU pipelines (seconds), so it runs before the user stops talking.
// A second second of silence that still takes over a second means no usable GPU (CPU build, or a software driver).
async function load(filePath) {
  native ||= loadNative();
  if (context)
    await context.release();

  context = null;
  context = await new native.WhisperContext({ filePath, useGpu: true });
  await transcribe(silence(1), 'en');
  const started = Date.now();
  await transcribe(silence(1), 'en');
  return { gpu: Date.now() - started < 1000 };
}

process.on('message', async message => {
  try {
    if (message.type === 'load') {
      process.send({ type: 'ready', id: message.id, ...(await load(message.filePath)) });
      return;
    }

    if (message.type === 'transcribe') {
      const pcm = message.pcm;
      const audio = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      const result = await transcribe(audio, message.language);
      process.send({ type: 'text', id: message.id, text: String(result.result || '') });
    }
  } catch (error) {
    process.send({ type: 'error', id: message.id, message: String(error?.message || error).slice(0, 500) });
  }
});
