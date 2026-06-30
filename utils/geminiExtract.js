'use strict';
// =============================================================================
// geminiExtract.js — turn a spoken loading-report dictation into structured
// form fields using the Gemini API.
//
// The loader speaks a whole report; the browser turns speech -> text (Web Speech
// API); this module sends that text to Gemini with the product catalog and gets
// back a JSON object matching the form fields (incl. products matched to the
// EXACT Turkish catalog name even when dictated in Arabic).
//
// Everything is configurable via env so you can adapt without code changes:
//   GEMINI_API_KEY     (required)  your Gemini API key
//   GEMINI_MODEL       (default 'gemini-3.5-flash')
//   GEMINI_API_STYLE   ('interactions' [default] | 'generate')
//   GEMINI_ENDPOINT    (optional) full override of the request URL
// =============================================================================

const path = require('path');

// Load the TR<->AR product catalog once (object: { "TR name": "AR name", ... }).
let CATALOG = {};
try {
    CATALOG = require(path.join(__dirname, '..', 'public', 'products_tr_to_ar.json'));
} catch (e) {
    console.warn('⚠️ geminiExtract: could not load products_tr_to_ar.json:', e.message);
}

// JSON schema for the extracted fields (mirrors the loader create-form fields).
const REPORT_SCHEMA = {
    type: 'object',
    properties: {
        destination_customer: { type: 'string' },
        destination_company: { type: 'string' },
        destination_country: { type: 'string' },
        driver_name: { type: 'string' },
        driver_phone: { type: 'string' },
        forklift_operator: { type: 'string' },
        manager: { type: 'string' },
        worker1: { type: 'string' },
        worker2: { type: 'string' },
        worker3: { type: 'string' },
        worker4: { type: 'string' },
        plate1: { type: 'string' },
        plate2: { type: 'string' },
        container_no: { type: 'string' },
        loading_date: { type: 'string' },
        entry_time: { type: 'string' },
        exit_time: { type: 'string' },
        vehicle_weight_after: { type: 'string' },
        product_weight: { type: 'string' },
        comments: { type: 'string' },
        products: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    quantity: { type: 'string' },
                    pallets: { type: 'string' },
                },
                required: ['name'],
            },
        },
    },
};

function catalogText() {
    // Compact "TR => AR" list so Gemini can match Arabic speech to the exact TR name.
    return Object.entries(CATALOG)
        .map(([tr, ar]) => `${tr} => ${ar}`)
        .join('\n');
}

function buildInput(transcript, lang) {
    const langName = lang === 'tr' ? 'Turkish' : lang === 'en' ? 'English' : 'Arabic';
    return [
        'You convert a spoken loading/shipment report (dictated by a warehouse loader) into',
        'structured JSON for a data-entry form. Output MUST match the provided JSON schema.',
        '',
        `The dictation language is ${langName}. Names/values may be Arabic or Turkish.`,
        '',
        'RULES:',
        '- Fill ONLY fields the speaker actually mentions; leave the rest as empty string "" (products: empty array).',
        '- products: one item per product the speaker mentions, with:',
        '    name: the EXACT Turkish catalog name from the CATALOG below that best matches what they said',
        '          (match by meaning even if spoken in Arabic; copy the Turkish spelling exactly).',
        '          If nothing in the catalog matches, use the speaker\'s words as-is.',
        '    quantity: number of items/cartons as digits in a string (e.g. "10"); "" if not said.',
        '    pallets: number of pallets as digits in a string; "" if not said.',
        '- plate1/plate2: vehicle plates; convert spoken digits to numerals, keep letters.',
        '- driver_phone: digits only.',
        '- loading_date: YYYY-MM-DD if a date is clearly said; otherwise "".',
        '- entry_time/exit_time: HH:MM (24h) if said; otherwise "".',
        '- Never invent data. If unsure, leave empty.',
        '',
        'CATALOG (Turkish => Arabic):',
        catalogText(),
        '',
        'DICTATION:',
        transcript,
    ].join('\n');
}

// Low-level Gemini call. Uses global fetch (Node 18+). Returns the model's text.
async function callGemini(input, schema) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    const style = (process.env.GEMINI_API_STYLE || 'interactions').toLowerCase();

    let url, body;
    if (style === 'generate') {
        url = process.env.GEMINI_ENDPOINT ||
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        body = {
            contents: [{ parts: [{ text: input }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
        };
    } else {
        // 'interactions' (default, per the current Gemini docs)
        url = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/interactions';
        body = {
            model,
            input,
            response_format: { type: 'text', mime_type: 'application/json', schema },
        };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();

    // Pull the model's text out of either response shape.
    let text = data.output_text;
    if (!text && Array.isArray(data.steps)) {
        for (const step of data.steps) {
            if (step && step.type === 'model_output' && Array.isArray(step.content)) {
                const t = step.content.find((c) => c && c.type === 'text');
                if (t && t.text) { text = t.text; break; }
            }
        }
    }
    if (!text && data.candidates && data.candidates[0]) {
        const parts = data.candidates[0].content && data.candidates[0].content.parts;
        if (Array.isArray(parts)) {
            const t = parts.find((p) => p && p.text);
            if (t) text = t.text;
        }
    }
    if (!text) throw new Error('Gemini returned no text output');
    return text;
}

// High-level: transcript -> extracted fields object.
async function extractReportFields(transcript, lang) {
    const input = buildInput(String(transcript || ''), lang || 'ar');
    const text = await callGemini(input, REPORT_SCHEMA);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        // Some models wrap JSON in ```json fences — strip and retry.
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Gemini output was not valid JSON');
        parsed = JSON.parse(m[0]);
    }
    return sanitize(parsed);
}

// Keep only known fields; coerce products to {name, quantity, pallets} strings.
function sanitize(obj) {
    const out = {};
    const stringFields = Object.keys(REPORT_SCHEMA.properties).filter((k) => k !== 'products');
    for (const k of stringFields) {
        if (obj && obj[k] != null && obj[k] !== '') out[k] = String(obj[k]).trim();
    }
    if (obj && Array.isArray(obj.products)) {
        out.products = obj.products
            .filter((p) => p && (p.name || p.quantity || p.pallets))
            .map((p) => ({
                name: String(p.name || '').trim(),
                quantity: String(p.quantity || '').trim(),
                pallets: String(p.pallets || '').trim(),
            }));
    }
    return out;
}

module.exports = { extractReportFields, callGemini, buildInput, REPORT_SCHEMA, sanitize };
