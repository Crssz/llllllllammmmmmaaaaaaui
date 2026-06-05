// Encode raw PCM samples as a 16-bit mono WAV file in memory.
//
// `llama-mtmd-cli` decodes audio through miniaudio, which reliably handles
// uncompressed WAV (and MP3/FLAC) but NOT the Opus/WebM that a browser
// `MediaRecorder` would hand us. So the in-app recorder captures Float32 PCM
// via the Web Audio API and we serialise it here to a WAV the CLI can read.
//
// Pure and synchronous: takes mono samples in the usual [-1, 1] range plus the
// capture sample rate, returns the complete .wav byte stream (44-byte RIFF/PCM
// header + interleaved samples). No dependency on the DOM, so it unit-tests in
// the node test environment.

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const PCM_FORMAT = 1;
const NUM_CHANNELS = 1;

/** Clamp to [-1, 1] then scale to a signed 16-bit integer. */
function floatToPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  // Negative and positive halves have different magnitudes (-32768..32767).
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataSize, true); // RIFF chunk size
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk body size (PCM)
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, floatToPcm16(samples[i]), true);
    offset += blockAlign;
  }

  return new Uint8Array(buffer);
}
