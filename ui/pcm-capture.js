// Audio worklet for dictation (ui/dictation.js): turns the microphone, at the device's own rate, into 16 kHz mono
// 16-bit PCM blocks. Each output sample averages the input samples it covers, which also keeps high tones from folding
// into speech.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.due = this.step;
    this.sum = 0;
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length)
      return true;

    const pcm = new Int16Array(Math.ceil(input.length / this.step) + 1);
    let length = 0;
    for (const sample of input) {
      this.sum += sample;
      this.count++;
      if (this.count < this.due)
        continue;

      pcm[length++] = Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 0x7fff);
      this.due += this.step - this.count;
      this.sum = 0;
      this.count = 0;
    }
    if (length)
      this.port.postMessage(pcm.slice(0, length));
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
