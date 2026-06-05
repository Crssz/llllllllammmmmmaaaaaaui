import { describe, it, expect } from "vitest";
import { encodeWav } from "./wav";

/** Read a NUL-free ASCII tag of `len` bytes at `offset`. */
function ascii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("encodeWav", () => {
  it("writes a valid 44-byte RIFF/PCM header for the given sample rate", () => {
    const wav = encodeWav(new Float32Array([0, 0, 0, 0]), 16000);
    const view = new DataView(wav.buffer);

    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");

    expect(view.getUint32(16, true)).toBe(16); // PCM fmt body
    expect(view.getUint16(20, true)).toBe(1); // PCM format tag
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate (mono 16-bit)
    expect(view.getUint16(32, true)).toBe(2); // block align
  });

  it("sizes the buffer and chunk fields from the sample count", () => {
    const samples = new Float32Array(100);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav.buffer);
    // 100 mono 16-bit samples = 200 data bytes.
    expect(wav.length).toBe(44 + 200);
    expect(view.getUint32(40, true)).toBe(200); // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + 200); // RIFF size = file - 8
  });

  it("scales full-scale samples to the signed 16-bit extremes", () => {
    const wav = encodeWav(new Float32Array([1, -1, 0]), 8000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767); // +1.0 -> max
    expect(view.getInt16(46, true)).toBe(-32768); // -1.0 -> min
    expect(view.getInt16(48, true)).toBe(0); // silence
  });

  it("clamps out-of-range samples instead of wrapping", () => {
    const wav = encodeWav(new Float32Array([2, -2]), 8000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it("produces a header-only file for empty input", () => {
    const wav = encodeWav(new Float32Array(0), 44100);
    expect(wav.length).toBe(44);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(40, true)).toBe(0); // empty data chunk
    expect(view.getUint32(24, true)).toBe(44100);
  });
});
