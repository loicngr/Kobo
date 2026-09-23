// Original mathematical tones for Kōbō. No samples, recordings, or external media.
// Source and generated WAV files are distributed under GPL-3.0-or-later.
import { mkdir, writeFile } from 'node:fs/promises'

const directory = new URL('../src/client/public/sounds/', import.meta.url)
await mkdir(directory, { recursive: true })
const sampleRate = 22050
for (const [name, frequencies] of [['neutral', [660]], ['ready', [660, 880]]]) {
  const segment = Math.round(sampleRate * 0.14)
  const samples = segment * frequencies.length
  const output = Buffer.alloc(44 + samples * 2)
  output.write('RIFF', 0)
  output.writeUInt32LE(output.length - 8, 4)
  output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const offset = i % segment
    const envelope = Math.sin(Math.PI * offset / segment) ** 2
    const frequency = frequencies[Math.floor(i / segment)]
    output.writeInt16LE(Math.round(6000 * envelope * Math.sin(2 * Math.PI * frequency * offset / sampleRate)), 44 + i * 2)
  }
  await writeFile(new URL(`${name}.wav`, directory), output)
}
