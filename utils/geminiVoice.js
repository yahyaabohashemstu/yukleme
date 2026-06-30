'use strict';
// =============================================================================
// geminiVoice.js — Gemini-native voice I/O for the loader voice bot.
//   ttsSpeak(text)            -> reads text as speech using a Gemini TTS model
//                                (returns a ready-to-play WAV, base64).
//   sttTranscribe(audio,mime) -> transcribes recorded speech with Gemini.
//
// The Gemini API key stays on the server; the browser only sends/receives audio.
//
// Env:
//   GEMINI_API_KEY      (required)
//   GEMINI_TTS_MODEL    (default 'gemini-2.5-flash-preview-tts')
//   GEMINI_TTS_VOICE    (default 'Kore')
//   GEMINI_STT_MODEL    (default = GEMINI_MODEL or 'gemini-2.0-flash')
//   GEMINI_TIMEOUT_MS   (default 25000)
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTS_MODEL = () => process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = () => process.env.GEMINI_TTS_VOICE || 'Kore';
const STT_MODEL = () => process.env.GEMINI_STT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Low-level Gemini POST with an abort timeout. Returns the parsed JSON.
async function geminiPost(model, body) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models';
    const url = `${base}/${model}:generateContent`;
    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 25000);
    const maxAttempts = Math.max(1, Number(process.env.GEMINI_RETRIES || 3));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const text = await res.text();
            if (!res.ok) { const e = new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; throw e; }
            return JSON.parse(text);
        } catch (err) {
            if (err && err.name === 'AbortError') { err = new Error(`Gemini request timed out after ${timeoutMs}ms`); err.timeout = true; }
            lastErr = err;
            const retryable = err.timeout || err.status === 503 || err.status === 500; // not 429 (quota)
            clearTimeout(to);
            if (retryable && attempt < maxAttempts) { await sleep(600 * Math.pow(2, attempt - 1)); continue; }
            throw err;
        } finally {
            clearTimeout(to);
        }
    }
    throw lastErr;
}

// Gemini TTS returns raw PCM (signed 16-bit LE, mono). Wrap it in a WAV header so
// the browser can play it directly. Returns base64 WAV.
function pcmToWav(pcmBase64, sampleRate) {
    const pcm = Buffer.from(pcmBase64, 'base64');
    const dataLen = pcm.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLen, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);        // PCM fmt chunk size
    header.writeUInt16LE(1, 20);         // audio format = PCM
    header.writeUInt16LE(1, 22);         // channels = mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono * 16-bit)
    header.writeUInt16LE(2, 32);         // block align
    header.writeUInt16LE(16, 34);        // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataLen, 40);
    return Buffer.concat([header, pcm]).toString('base64');
}

function parseRate(mimeType) {
    const m = /rate=(\d+)/.exec(mimeType || '');
    return m ? parseInt(m[1], 10) : 24000;
}

// Where generated question audio is cached on disk. The 16 questions are static,
// so each is generated ONCE (per voice/model) and reused forever — keeping the
// API-call count (and quota usage) low.
function ttsCacheDir() {
    return process.env.TTS_CACHE_DIR || path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'), 'tts-cache');
}

// text -> spoken audio (base64 WAV). Served from the on-disk cache when available.
async function ttsSpeak(text) {
    const model = TTS_MODEL(), voice = TTS_VOICE();
    const key = crypto.createHash('sha1').update(model + '|' + voice + '|' + String(text || '')).digest('hex');
    const dir = ttsCacheDir();
    const file = path.join(dir, key + '.wav');
    try { if (fs.existsSync(file)) return { audio: fs.readFileSync(file).toString('base64'), mimeType: 'audio/wav', cached: true }; } catch (e) {}

    const body = {
        contents: [{ parts: [{ text: String(text || '').slice(0, 2000) }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
    };
    const data = await geminiPost(model, body);
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const part = Array.isArray(parts) ? parts.find((p) => p && p.inlineData && p.inlineData.data) : null;
    if (!part) throw new Error('Gemini TTS returned no audio');
    const wav = pcmToWav(part.inlineData.data, parseRate(part.inlineData.mimeType));
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, Buffer.from(wav, 'base64')); } catch (e) {}
    return { audio: wav, mimeType: 'audio/wav', cached: false };
}

// recorded audio (base64) -> transcript text (Turkish).
async function sttTranscribe(audioBase64, mimeType) {
    const body = {
        contents: [{
            parts: [
                { text: 'Transcribe this speech in TURKISH, exactly as spoken. Output ONLY the raw transcription text — no quotes, no labels, no extra words. Write each word ONCE; do NOT repeat or duplicate words. If there is no clear speech, output an empty string.' },
                { inlineData: { mimeType: mimeType || 'audio/wav', data: audioBase64 } },
            ],
        }],
        generationConfig: { temperature: 0 },
    };
    const data = await geminiPost(STT_MODEL(), body);
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    let text = '';
    if (Array.isArray(parts)) { const t = parts.find((p) => p && typeof p.text === 'string'); if (t) text = t.text; }
    return String(text || '').trim();
}

module.exports = { ttsSpeak, sttTranscribe, pcmToWav, parseRate };
