const express = require('express');
const cookieSession = require('cookie-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const compression = require('compression');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const { supabase, initializeDatabase, db } = require('./database');
const { serialize, deserializeRow } = require('./lib/supabase-sqlite');
const { sendNotification } = require('./utils/telegramBot');
const { extractReportFields, extractFromAnswers } = require('./utils/geminiExtract');
const { ttsSpeak, sttTranscribe } = require('./utils/geminiVoice');

const app = express();
const PORT = process.env.PORT || 5000;

// Local storage directory for uploaded photos/videos.
// In production (Coolify) set UPLOADS_DIR=/app/uploads (a PERSISTENT volume).
// Locally it defaults to ./uploads.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Cached thumbnails live in a subfolder of the uploads volume.
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbs');
fs.mkdirSync(THUMBS_DIR, { recursive: true });

// Trust proxy is required for secure cookies on Render/Heroku
app.set('trust proxy', 1);

// Middleware
app.use(compression()); // gzip text responses (HTML/CSS/JS/JSON); skips already-compressed images

// Baseline security headers. We deliberately do NOT set an app-wide CSP because
// the UI relies on inline <script> blocks and inline event handlers; a strict
// CSP would break it. nosniff + frame-options + referrer-policy are safe.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

// Same-origin only (no third-party browser clients need cross-origin access).
app.use(cors({ origin: false }));
app.use(express.json({ limit: '8mb' })); // 8mb: voice STT sends short WAV audio as base64
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// On-the-fly cached thumbnails for fast galleries. The frontend points grid
// <img> tags at /uploads/thumbs/<name>; the full image stays at /uploads/<name>
// (used for click-to-enlarge). Thumbnails are generated once with sharp, cached
// to disk, and served as webp. MUST be registered BEFORE the /uploads static.
app.get('/uploads/thumbs/:name', async (req, res) => {
    const name = path.basename(req.params.name); // guard against path traversal
    const src = path.join(UPLOADS_DIR, name);
    const dest = path.join(THUMBS_DIR, name);
    const serve = () => {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('image/webp');
        const rs = fs.createReadStream(dest);
        rs.on('error', (err) => {
            console.error('thumb stream error for', name, err.message);
            if (!res.headersSent) res.status(404).end();
            else res.destroy();
        });
        rs.pipe(res);
    };
    if (fs.existsSync(dest)) return serve();
    if (!fs.existsSync(src)) return res.status(404).end();
    const tmp = `${dest}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    try {
        await sharp(src, { failOn: 'none', animated: false })
            .rotate() // honour EXIF orientation
            .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 75 })
            .toFile(tmp);
        fs.renameSync(tmp, dest); // atomic publish (avoids partial files under concurrency)
        return serve();
    } catch (e) {
        // Not a raster image sharp can process (e.g. a video) -> fall back to original.
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {} // never leak temp files
        return res.redirect(302, '/uploads/' + encodeURIComponent(name));
    }
});

// Serve user-uploaded photos/videos from the local uploads directory.
// These were previously served by Supabase Storage; they now live on disk and
// are referenced by relative URLs like /uploads/<filename>.
app.use('/uploads', express.static(UPLOADS_DIR, {
    maxAge: '365d',
    immutable: true,
    setHeaders: (res) => {
        // Defense-in-depth: even if a legacy SVG/HTML file exists here, neutralise
        // any embedded script when it is opened directly as a document.
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    },
}));

// Session secret: REQUIRED (>=32 chars) in production — never fall back to a
// public constant (that would let anyone forge a signed session cookie).
// In development, generate a random ephemeral secret so `npm start` still works.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32 || SESSION_SECRET === 'change-me-to-a-long-random-string') {
    if (process.env.NODE_ENV === 'production') {
        console.error('FATAL: SESSION_SECRET must be set to a long random value (>=32 chars) in production.');
        console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
        process.exit(1);
    }
    SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('⚠️  SESSION_SECRET not set — using a temporary random secret for this dev run (sessions reset on restart).');
}

// Session configuration
app.use(cookieSession({
    name: 'session',
    secret: SESSION_SECRET,
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year (Never log out)
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
}));





// Multer setup (memory storage). The mimetype here is a first, weak gate only —
// it is attacker-controlled, so the REAL validation happens in saveUploadedFile.
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 25 * 1024 * 1024, files: 30 }, // 25MB/file, max 30 files
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Sadece resim ve video dosyaları yüklenebilir.'));
        }
    }
});

// Sniff a video container from magic bytes -> a safe, server-chosen extension.
function sniffVideoExt(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf.slice(4, 8).toString('ascii') === 'ftyp') { // ISO BMFF (mp4/mov)
        const brand = buf.slice(8, 12).toString('ascii');
        return brand.startsWith('qt') ? '.mov' : '.mp4';
    }
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm';
    return null;
}

// Helper: save an uploaded file SAFELY and return a relative /uploads/<name> URL.
// Security: the stored extension is chosen by the SERVER from validated content,
// never from the attacker-controlled originalname/mimetype. Images are re-encoded
// through sharp (which rasterises SVG and strips any embedded script), guaranteeing
// a real raster image. Videos are magic-byte sniffed and allowlisted. Anything
// else is rejected — so a .html/.svg/.js can never be stored and served back.
async function saveUploadedFile(file) {
    const base = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

    // Try image first.
    try {
        const meta = await sharp(file.buffer, { failOn: 'none' }).metadata();
        if (meta && meta.format) {
            const animated = meta.pages && meta.pages > 1;
            // Keep png/webp/gif as-is (re-encoded); everything else -> jpeg.
            const targetFmt = ['png', 'webp', 'gif'].includes(meta.format) ? meta.format : 'jpeg';
            const ext = { png: '.png', webp: '.webp', gif: '.gif', jpeg: '.jpg' }[targetFmt];
            const out = await sharp(file.buffer, { failOn: 'none', animated })
                .rotate()
                .toFormat(targetFmt, targetFmt === 'jpeg' ? { quality: 90 } : {})
                .toBuffer();
            const fileName = base + ext;
            fs.writeFileSync(path.join(UPLOADS_DIR, fileName), out);
            return `/uploads/${fileName}`;
        }
    } catch (e) {
        // not an image sharp can read -> fall through to video sniff
    }

    // Video?
    const vext = sniffVideoExt(file.buffer);
    if (vext) {
        const fileName = base + vext;
        fs.writeFileSync(path.join(UPLOADS_DIR, fileName), file.buffer);
        return `/uploads/${fileName}`;
    }

    throw new Error('UNSUPPORTED_FILE'); // not a valid image or allowlisted video
}

// Auth middleware
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
    }
    next();
};

const requireLoader = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.' }); // Session expired
    }
    if (req.session.user.role !== 'loader') {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok (Sadece Loader).' });
    }
    next();
};

const requireManager = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.' }); // Session expired
    }
    if (req.session.user.role !== 'manager') {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok (Sadece Manager).' });
    }
    next();
};

// ============ AUTH ROUTES ============

// Login
// Throttle login attempts to blunt brute-force (in-memory; fine for a single
// low-traffic instance). trust proxy=1 is set, so the real client IP is used.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Çok fazla başarısız deneme. Lütfen 15 dakika sonra tekrar deneyin.' },
});

app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
        }

        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            role: user.role
        };

        res.json({
            message: 'تم تسجيل الدخول بنجاح',
            user: {
                username: user.username,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session = null;
    res.json({ message: 'تم تسجيل الخروج بنجاح' });
});

// Check auth status
app.get('/api/check-auth', (req, res) => {
    if (req.session.user) {
        res.json({
            authenticated: true,
            user: req.session.user
        });
    } else {
        res.json({ authenticated: false });
    }
});

// Distinct non-empty values of given columns across existing loadings — used so
// the voice bot can normalise spoken names to their existing spelling.
function distinctValues(cols) {
    const set = new Set();
    for (const c of cols) {
        const rows = db.prepare(`SELECT DISTINCT ${c} AS v FROM loadings WHERE ${c} IS NOT NULL AND ${c} <> ''`).all();
        for (const r of rows) {
            const v = r.v != null && String(r.v).trim();
            if (v) set.add(v);
        }
    }
    return [...set].slice(0, 600);
}

// Voice fill: turn the loader's spoken answers (per field) into structured report
// fields via Gemini, matching names/products to known values. The loader REVIEWS
// the filled form before submitting. Also accepts a one-shot {transcript} (legacy).
// Non-sensitive Gemini config, returned to the voice-log panel so the loader/admin
// can see exactly how the feature is configured (never includes the API key value).
function voiceDiag() {
    return {
        keyPresent: !!process.env.GEMINI_API_KEY,
        style: (process.env.GEMINI_API_STYLE || 'generate'),
        model: (process.env.GEMINI_MODEL || 'gemini-2.0-flash'),
        ttsModel: (process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'),
        ttsVoice: (process.env.GEMINI_TTS_VOICE || 'Kore'),
        sttModel: (process.env.GEMINI_STT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash'),
        endpoint: process.env.GEMINI_ENDPOINT ? 'custom' : 'default',
        timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 25000),
    };
}

app.post('/api/voice-extract', requireLoader, async (req, res) => {
    const diag = voiceDiag();
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(503).json({ error: 'Sesli doldurma sunucuda yapılandırılmamış (GEMINI_API_KEY eksik).', detail: 'GEMINI_API_KEY is not set on the server.', diag });
        }
        const lang = ['ar', 'tr', 'en'].includes(req.body.lang) ? req.body.lang : 'ar';
        const known = {
            persons: distinctValues(['manager', 'worker1', 'worker2', 'worker3', 'worker4', 'driver_name', 'forklift_operator']),
            companies: distinctValues(['destination_company']),
            countries: distinctValues(['destination_country']),
            customers: distinctValues(['destination_customer']),
        };

        let fields;
        const t0 = Date.now();
        if (req.body.answers && typeof req.body.answers === 'object') {
            fields = await extractFromAnswers(req.body.answers, lang, known);
        } else {
            const transcript = String(req.body.transcript || '').slice(0, 5000);
            if (!transcript.trim()) return res.status(400).json({ error: 'Boş veri.', detail: 'Empty answers/transcript.', diag });
            fields = await extractReportFields(transcript, lang);
        }
        res.json({ fields, diag: { ...diag, ms: Date.now() - t0, fieldCount: Object.keys(fields || {}).length } });
    } catch (error) {
        console.error('voice-extract error:', error.message);
        res.status(502).json({ error: 'Ses işlenemedi. Lütfen tekrar deneyin veya elle girin.', detail: String(error && error.message || error).slice(0, 500), diag });
    }
});

// Gemini voice: text -> spoken audio (the bot READS each question with Gemini's voice).
app.post('/api/voice-tts', requireLoader, async (req, res) => {
    const diag = voiceDiag();
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(503).json({ error: 'Sesli okuma yapılandırılmamış (GEMINI_API_KEY eksik).', detail: 'GEMINI_API_KEY is not set on the server.', diag });
        }
        const text = String(req.body.text || '').slice(0, 2000);
        if (!text.trim()) return res.status(400).json({ error: 'Boş metin.', detail: 'Empty text.', diag });
        const t0 = Date.now();
        const out = await ttsSpeak(text);
        res.json({ audio: out.audio, mimeType: out.mimeType, diag: { ...diag, ms: Date.now() - t0, cached: !!out.cached } });
    } catch (error) {
        console.error('voice-tts error:', error.message);
        res.status(502).json({ error: 'Seslendirme başarısız.', detail: String(error && error.message || error).slice(0, 500), diag });
    }
});

// Gemini voice: recorded audio -> transcript (the bot HEARS the loader's answer).
app.post('/api/voice-stt', requireLoader, async (req, res) => {
    const diag = voiceDiag();
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(503).json({ error: 'Ses tanıma yapılandırılmamış (GEMINI_API_KEY eksik).', detail: 'GEMINI_API_KEY is not set on the server.', diag });
        }
        const audio = String(req.body.audio || '');
        const mimeType = String(req.body.mimeType || 'audio/wav');
        if (!audio) return res.status(400).json({ error: 'Ses yok.', detail: 'Empty audio.', diag });
        const t0 = Date.now();
        const transcript = await sttTranscribe(audio, mimeType);
        res.json({ transcript, diag: { ...diag, ms: Date.now() - t0 } });
    } catch (error) {
        console.error('voice-stt error:', error.message);
        res.status(502).json({ error: 'Ses tanıma başarısız.', detail: String(error && error.message || error).slice(0, 500), diag });
    }
});

// ============ LOADING ROUTES ============

// Create new loading (loader only)
// Create new loading (loader only)
app.post('/api/loadings', requireLoader, upload.array('photos'), async (req, res) => {
    try {
        // Upload Photos to Supabase
        const uploadedUrls = [];
        if (req.files && req.files.length > 0) {
            const uploadPromises = req.files.map(file => saveUploadedFile(file));
            const results = await Promise.all(uploadPromises);
            uploadedUrls.push(...results);
        }

        // Parse products (sent as JSON string in FormData)
        let products = [];
        try {
            products = JSON.parse(req.body.products || '[]');
        } catch (e) {
            products = [];
        }

        const loadingData = {
            // Team info
            manager: req.body.manager || null,
            worker1: req.body.worker1 || null,
            worker2: req.body.worker2 || null,
            worker3: req.body.worker3 || null,
            worker4: req.body.worker4 || null,

            // Vehicle info
            plate1: req.body.plate1 || null,
            plate2: req.body.plate2 || null,
            container_no: req.body.container_no || null,
            loading_date: req.body.loading_date || null,

            // Weight info
            product_weight: req.body.product_weight || null,
            vehicle_weight_after: req.body.vehicle_weight_after || null,
            destination_company: req.body.destination_company || null,
            destination_country: req.body.destination_country || null,
            destination_customer: req.body.destination_customer || null,

            // Driver info
            driver_name: req.body.driver_name || null,
            driver_phone: req.body.driver_phone || null,
            forklift_operator: req.body.forklift_operator || null,

            // Products
            products: products,

            // Documentation (Using loaded_vehicle_photos as the main gallery)
            goods_photos: [],
            damaged_goods_photos: [],
            scale_receipt_photo: null,
            loaded_vehicle_photos: uploadedUrls, // All photos go here

            // Times
            entry_time: req.body.entry_time || null,
            exit_time: req.body.exit_time || null,

            // Comments
            comments: req.body.comments || null,

            // Metadata
            created_by: req.session.user.id,

            // Draft Status: If no photos are uploaded, it's a draft
            is_draft: uploadedUrls.length === 0
        };

        const { data, error } = await supabase
            .from('loadings')
            .insert([loadingData])
            .select()
            .single();

        if (error) {
            console.error('Insert error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء حفظ البيانات' });
        }

        // Send Telegram Notification (Async, don't block response)
        try {
            if (!loadingData.is_draft) {
                await sendNotification(data, 'new');
            }
        } catch (notifyError) {
            console.error('Notification failed:', notifyError);
        }

        res.status(201).json({
            message: 'تم إرسال بيانات التحميل بنجاح',
            loading: data
        });
    } catch (error) {
        console.error('Create loading error:', error);
        if (error && error.message === 'UNSUPPORTED_FILE') {
            return res.status(400).json({ error: 'Geçersiz dosya türü. Sadece resim ve video yüklenebilir.' });
        }
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Get my loadings (loader only)
app.get('/api/my-loadings', requireLoader, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .select('*, users!created_by(username)')
            .eq('is_archived', false)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Fetch error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء جلب البيانات' });
        }

        res.json(data || []);
    } catch (error) {
        console.error('Get my loadings error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Get all loadings (manager only)
app.get('/api/loadings', requireManager, async (req, res) => {
    try {
        const fetchArchived = req.query.archived === 'true';

        const { data, error } = await supabase
            .from('loadings')
            .select('*, loading_versions(count), users!created_by(username)')
            .eq('is_archived', fetchArchived)
            .eq('is_draft', false)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Fetch error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء جلب البيانات' });
        }

        res.json(data || []);
    } catch (error) {
        console.error('Get loadings error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Get single loading (manager only)
app.get('/api/loadings/:id', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error) {
            return res.status(404).json({ error: 'لم يتم العثور على بيانات التحميل' });
        }

        res.json(data);
    } catch (error) {
        console.error('Get loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});



// Get loading versions (loader & manager)
app.get('/api/loadings/:id/versions', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loading_versions')
            .select('*, users!archived_by(username)')
            .eq('loading_id', req.params.id)
            .order('version_number', { ascending: false });

        if (error) {
            console.error('Fetch versions error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء جلب النسخ' });
        }

        res.json(data || []);
    } catch (error) {
        console.error('Get versions error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Update loading (loader or manager) - Archives old version
app.put('/api/loadings/:id', requireAuth, upload.array('photos'), async (req, res) => {
    try {
        const id = req.params.id;
        const currentUser = req.session.user;
        const currentRole = currentUser?.role;

        if (!currentRole || !['loader', 'manager'].includes(currentRole)) {
            return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
        }

        // 1. Get current data
        const { data: current, error: fetchError } = await supabase
            .from('loadings')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !current) {
            return res.status(404).json({ error: 'التقرير غير موجود' });
        }

        // 2. Process Photos
        // (Version archiving + the update are done together atomically in step 5,
        //  AFTER all async photo work, so they cannot partially fail.)
        // New uploads
        const newUploadedUrls = [];
        if (req.files && req.files.length > 0) {
            const uploadPromises = req.files.map(file => saveUploadedFile(file));
            const results = await Promise.all(uploadPromises);
            newUploadedUrls.push(...results);
        }

        // Preserve existing photos (sent as strings in body)
        // req.body.loaded_vehicle_photos might be a single string or an array of strings
        let preservedPhotos = [];
        if (req.body.loaded_vehicle_photos) {
            if (Array.isArray(req.body.loaded_vehicle_photos)) {
                preservedPhotos = req.body.loaded_vehicle_photos;
            } else {
                preservedPhotos = [req.body.loaded_vehicle_photos];
            }
        }

        // Combine
        const finalPhotos = [...preservedPhotos, ...newUploadedUrls];


        // 4. Prepare new data
        // Parse products if sent as string (Multipart form data sends JSON as string)
        let products = [];
        if (typeof req.body.products === 'string') {
            try {
                products = JSON.parse(req.body.products);
            } catch (e) {
                products = [];
            }
        } else {
            products = req.body.products || [];
        }

        // 4. Prepare new data
        const managerEditNote = 'Bu rapor yönetici tarafından düzenlenmiştir.';

        let comments = req.body.comments;
        if (currentRole === 'manager') {
            const existingComments = comments || current.comments || '';
            if (!existingComments.includes(managerEditNote)) {
                comments = existingComments
                    ? `${managerEditNote}\n\n${existingComments}`
                    : managerEditNote;
            } else {
                comments = existingComments;
            }
        } else {
            // It's a loader making the edit. We MUST preserve existing comments since loader edit form doesn't send them,
            // AND we MUST remove the managerEditNote if it was previously added by a manager.
            const existingComments = comments || current.comments || '';
            comments = existingComments.replace(managerEditNote, '').trim();
        }

        const updateData = {
            manager: req.body.manager,
            worker1: req.body.worker1,
            worker2: req.body.worker2,
            worker3: req.body.worker3,
            worker4: req.body.worker4,
            plate1: req.body.plate1,
            plate2: req.body.plate2,
            loading_date: req.body.loading_date,
            product_weight: req.body.product_weight,
            vehicle_weight_after: req.body.vehicle_weight_after,
            destination_company: req.body.destination_company,
            destination_country: req.body.destination_country,
            destination_customer: req.body.destination_customer,
            driver_name: req.body.driver_name,
            driver_phone: req.body.driver_phone,
            forklift_operator: req.body.forklift_operator,
            products: products,
            goods_photos: [], // Reserved for future use if needed, currently unused in UI
            damaged_goods_photos: [], // Reserved
            scale_receipt_photo: null, // Reserved
            loaded_vehicle_photos: finalPhotos, // All photos go here
            entry_time: req.body.entry_time === '' ? null : req.body.entry_time,
            exit_time: req.body.exit_time === '' ? null : req.body.exit_time,
            comments,
            // Reset recorded status on edit
            is_recorded: false,
            recorded_at: null,
            recorded_by: null,
            // Clear specific manager records
            safwat_recorded_at: null,
            pinar_recorded_at: null,
            // Reset viewed status so it appears as "New/Edited" to managers
            viewed_at: null,
            // Clear improvement request flags when the report is edited
            needs_improvement_at: null,
            needs_improvement_by: null,
            needs_improvement_reason: null
        };

        // If it was a draft, and now has photos, publish it
        const wasDraft = current.is_draft;
        const isNowPublishing = wasDraft && finalPhotos.length > 0;
        
        if (isNowPublishing) {
            updateData.is_draft = false;
        }

        // 5. Atomically archive the current version AND apply the update.
        // Computing the next version number with MAX()+1 INSIDE the transaction
        // removes the COUNT-then-INSERT race; wrapping both writes in one
        // transaction means we can never leave an archived version without its
        // update applied (or vice-versa) — important for a data-loss-averse owner.
        let updated;
        try {
            const applyUpdate = db.transaction(() => {
                const nextVersion = db
                    .prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM loading_versions WHERE loading_id = ?')
                    .get(id).n;
                db.prepare(
                    'INSERT INTO loading_versions (id, loading_id, version_number, data, archived_at, archived_by) VALUES (?, ?, ?, ?, ?, ?)'
                ).run(crypto.randomUUID(), id, nextVersion, JSON.stringify(current), new Date().toISOString(), currentUser.id);

                const cols = Object.keys(updateData);
                const setSql = cols.map((c) => `${c} = ?`).join(', ');
                const vals = cols.map((c) => serialize('loadings', c, updateData[c]));
                db.prepare(`UPDATE loadings SET ${setSql} WHERE id = ?`).run(...vals, id);

                return db.prepare('SELECT * FROM loadings WHERE id = ?').get(id);
            });
            updated = deserializeRow('loadings', applyUpdate());
        } catch (txErr) {
            console.error('Update transaction error:', txErr);
            return res.status(500).json({ error: 'فشل تحديث البيانات' });
        }

        // Send Telegram Notification (Conditional)
        try {
            // Only send notifications if the user is a loader, not a manager
            if (req.session.user.role !== 'manager') {
                if (isNowPublishing) {
                    // It was a draft and is now officially published because a photo was added
                    console.log(`Report ${id} transitioned from draft to published. Sending NEW alert.`);
                    await sendNotification(updated, 'new');
                } else if (current.viewed_at && !updated.is_draft) {
                    // If viewed and it's not a draft, send URGENT alert for changes
                    console.log(`Report ${id} changed after viewing. Sending ALERT.`);
                    await sendNotification(updated, 'update_important');
                } else {
                    // If NOT viewed or still a draft, update silently (No notification)
                    console.log(`Report ${id} updated (silent). Draft: ${updated.is_draft}, Viewed: ${!!current.viewed_at}`);
                }
            } else {
                console.log(`Report ${id} updated by manager. No Telegram notification sent.`);
            }
        } catch (notifyError) {
            console.error('Notification failed:', notifyError);
        }

        res.json({ message: 'تم التحديث بنجاح', loading: updated });


    } catch (error) {
        console.error('Update loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Mark loading as recorded (manager only)
app.patch('/api/loadings/:id/record', requireManager, async (req, res) => {
    try {
        const username = req.session.user.username ? req.session.user.username.trim().toLowerCase() : 'safwat';
        const now = new Date().toISOString();

        // Determine which column to update based on username
        let updateData = {};
        if (username === 'pinar') {
            updateData.pinar_recorded_at = now;
        } else {
            // Default to safwat for manager/other
            updateData.safwat_recorded_at = now;
        }

        // BACKWARD COMPATIBILITY:
        // Also update legacy columns so 'is_recorded' becomes true if AT LEAST ONE manager recorded it.
        updateData.is_recorded = true;
        updateData.recorded_at = now;
        updateData.recorded_by = req.session.user.id;

        const { data, error } = await supabase
            .from('loadings')
            .update(updateData)
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Update error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء تحديث الحالة' });
        }

        res.json({
            message: 'تم تسجيل التقييد بنجاح',
            loading: data
        });
    } catch (error) {
        console.error('Record loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Cancel recording (manager only)
app.patch('/api/loadings/:id/unrecord', requireManager, async (req, res) => {
    try {
        const username = req.session.user.username ? req.session.user.username.trim().toLowerCase() : 'safwat';

        // Determine which column to clear based on username
        let updateData = {};
        if (username === 'pinar') {
            updateData.pinar_recorded_at = null;
        } else {
            // Default to safwat for manager/other
            updateData.safwat_recorded_at = null;
        }

        // We first update the specific column
        const { data: updatedSpecific, error: updateError } = await supabase
            .from('loadings')
            .update(updateData)
            .eq('id', req.params.id)
            .select()
            .single();

        if (updateError) {
            console.error('Update error:', updateError);
            return res.status(500).json({ error: 'حدث خطأ أثناء إلغاء التقييد' });
        }

        // BACKWARD COMPATIBILITY CHECK:
        // If BOTH are null, then set is_recorded = false
        const s = updatedSpecific.safwat_recorded_at;
        const p = updatedSpecific.pinar_recorded_at;

        if (!s && !p) {
            const { data: finalData, error: finalError } = await supabase
                .from('loadings')
                .update({
                    is_recorded: false,
                    recorded_at: null,
                    recorded_by: null
                })
                .eq('id', req.params.id)
                .select()
                .single();

            if (!finalError) {
                return res.json({ message: 'تم إلغاء التقييد بنجاح', loading: finalData });
            }
        }

        res.json({
            message: 'تم إلغاء التقييد بنجاح',
            loading: updatedSpecific
        });
    } catch (error) {
        console.error('Unrecord loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Toggle paper delivered status (loader only)
app.patch('/api/loadings/:id/paper-delivered', requireLoader, async (req, res) => {
    try {
        const { data: current, error: fetchError } = await supabase
            .from('loadings')
            .select('paper_delivered_at')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !current) {
            return res.status(404).json({ error: 'التقرير غير موجود' });
        }

        const newDelivered = current.paper_delivered_at ? null : new Date().toISOString();

        const { data, error } = await supabase
            .from('loadings')
            .update({
                paper_delivered_at: newDelivered,
                // If cancelling delivery, also clear manager confirmation
                ...(newDelivered === null ? { paper_confirmed_at: null } : {})
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Paper delivery update error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء تحديث الحالة' });
        }

        res.json({ message: 'تم تحديث حالة التسليم', loading: data });
    } catch (error) {
        console.error('Paper delivery error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Toggle paper confirmed status (manager only)
app.patch('/api/loadings/:id/paper-confirmed', requireManager, async (req, res) => {
    try {
        const { data: current, error: fetchError } = await supabase
            .from('loadings')
            .select('paper_confirmed_at')
            .eq('id', req.params.id)
            .single();

        if (fetchError || !current) {
            return res.status(404).json({ error: 'التقرير غير موجود' });
        }

        const newConfirmed = current.paper_confirmed_at ? null : new Date().toISOString();

        const { data, error } = await supabase
            .from('loadings')
            .update({ paper_confirmed_at: newConfirmed })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Paper confirm update error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء تحديث الحالة' });
        }

        res.json({ message: 'تم تحديث حالة التأكيد', loading: data });
    } catch (error) {
        console.error('Paper confirm error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Send improvement alert (manager only)
app.post('/api/loadings/:id/improvement-alert', requireManager, async (req, res) => {
    try {
        const { section, field, comment } = req.body;
        
        if (!section || !comment) {
            return res.status(400).json({ error: 'القسم والشرح مطلوبان' });
        }

        const reason = { section, field, comment };

        const { data, error } = await supabase
            .from('loadings')
            .update({ 
                needs_improvement_at: new Date().toISOString(),
                needs_improvement_by: req.session.user.id,
                needs_improvement_reason: reason,
                // Also unrecord it if it was recorded
                is_recorded: false,
                recorded_at: null,
                recorded_by: null,
                safwat_recorded_at: null,
                pinar_recorded_at: null
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Improvement alert error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء إرسال التنبيه' });
        }

        res.json({ message: 'تم إرسال طلب التعديل لمسؤول التحميل', loading: data });
    } catch (error) {
        console.error('Improvement alert server error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Archive loading (manager only)
app.patch('/api/loadings/:id/archive', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .update({ is_archived: true })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Archive error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء أرشفة التقرير' });
        }

        res.json({ message: 'تم أرشفة التقرير بنجاح', loading: data });
    } catch (error) {
        console.error('Archive loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Restore loading (manager only)
app.patch('/api/loadings/:id/restore', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .update({ is_archived: false })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Restore error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء عرض التقرير' });
        }

        res.json({ message: 'تم استعادة التقرير بنجاح', loading: data });
    } catch (error) {
        console.error('Restore loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Mark loading as viewed (manager only)
app.patch('/api/loadings/:id/view', requireManager, async (req, res) => {
    try {
        // Only update if viewed_at is null
        const { data, error } = await supabase
            .from('loadings')
            .update({ viewed_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .is('viewed_at', null)
            .select()
            .single();

        if (error) {
            // Check if it's just that it was already viewed (update returned no rows)
            // If no row was updated, it might be because of the .is('viewed_at', null) filter
            // We don't error out, just return success
            return res.json({ message: 'View recorded' });
        }

        res.json({ message: 'View recorded', loading: data });
    } catch (error) {
        console.error('View loading error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Health check (no auth) — used by Coolify/Traefik to verify the container is up
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// Redirect routes based on role
app.get('/loader', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loader.html'));
});

app.get('/manager', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

// Final error handler — catches anything routes didn't (e.g. multer errors,
// oversized bodies) and returns a generic message without leaking internals.
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err && err.message);
    if (res.headersSent) return next(err);
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT')) {
        return res.status(400).json({ error: 'Dosya çok büyük veya çok fazla dosya.' });
    }
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
});

// Start server
async function startServer() {
    const dbReady = await initializeDatabase();
    if (!dbReady) {
        console.log('\n⚠️  Database initialization reported a problem. Check logs above.\n');
    }

    const server = app.listen(PORT, () => {
        console.log(`\n🚀 Server running on port ${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
    });

    // Graceful shutdown: on redeploy/restart, stop accepting connections and
    // checkpoint the SQLite WAL into the main DB file so no committed data is
    // left only in the -wal sidecar.
    const shutdown = (signal) => {
        console.log(`\n${signal} received — shutting down gracefully...`);
        server.close(() => {
            try {
                db.pragma('wal_checkpoint(TRUNCATE)');
                db.close();
                console.log('SQLite checkpointed and closed. Bye.');
            } catch (e) {
                console.error('Error during DB shutdown:', e.message);
            }
            process.exit(0);
        });
        // Hard cap so a hung connection can't block the deploy forever.
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
