import { readFile } from 'node:fs/promises';
import { pipeline } from '@huggingface/transformers';
import wavefile from 'wavefile';

const [, , wavPath, model = 'Xenova/whisper-tiny.en'] = process.argv;

if (!wavPath) {
  throw new Error('Missing WAV path');
}

const WaveFile = wavefile?.WaveFile || wavefile?.default?.WaveFile;
if (!WaveFile) {
  throw new Error('Could not load WaveFile');
}

const wav = new WaveFile(await readFile(wavPath));
wav.toBitDepth('32f');
wav.toSampleRate(16000);

const samples = wav.getSamples();
const channel = Array.isArray(samples) ? samples[0] : samples;
const audio = channel instanceof Float32Array ? channel : Float32Array.from(channel);
const transcriber = await pipeline('automatic-speech-recognition', model);
const output = await transcriber(audio, { return_timestamps: true });

process.stdout.write(JSON.stringify(output));
