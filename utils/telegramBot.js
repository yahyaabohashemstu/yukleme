const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

// Create a bot instance (no polling needed for sending messages)
const bot = token ? new TelegramBot(token, { polling: false }) : null;

if (!token || !chatId) {
    console.warn('⚠️ Telegram configuration missing (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID). Notifications will not be sent.');
} else {
    console.log('✅ Telegram Bot initialized.');
}

// Where uploaded report files live on disk (same resolution as server.js).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

// Extension -> MIME. sendDocument keeps the file UNCOMPRESSED regardless; the MIME
// only lets clients label/preview it. (sendPhoto would recompress — we never use it.)
const MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Function to format the message
// Function to format the message
function formatLoadingMessage(loading, type = 'new') {
    // Telegram parse_mode=HTML: escape every user-supplied value so a '<' in a
    // name/plate/comment can't break the message (or inject markup).
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let title = '';
    if (type === 'new') {
        title = '🆕 <b>Yeni Rapor Oluşturuldu</b>';
    } else if (type === 'update_important') {
        title = '⚠️🔴 <b>DİKKAT: İNCELENMİŞ RAPOR DEĞİŞTİRİLDİ</b> 🔴⚠️';
    } else {
        title = '✏️ <b>Rapor Güncellendi</b>';
    }
    // Format Date & Time (Turkey time)
    const createdAt = new Date(loading.created_at || Date.now());
    const formattedDateTime = createdAt.toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    const ld = loading.loading_date ? new Date(loading.loading_date) : null;
    const date = ld && !isNaN(ld) ? ld.toLocaleDateString('tr-TR') : '-';
    const shortId = loading.id ? String(loading.id).slice(0, 8) : '????????';

    // Calculate total products
    let totalItems = 0;
    let totalPallets = 0;
    if (Array.isArray(loading.products)) {
        loading.products.forEach(p => {
            totalItems += parseInt(p.quantity) || 0;
            totalPallets += parseInt(p.pallets) || 0;
        });
    }

    return `
${title}

📄 <b>Rapor ID:</b> <code>${shortId}</code>
🕒 <b>Yükleme Zamanı:</b> ${formattedDateTime}
📅 <b>Tarih:</b> ${date}
🚛 <b>Plaka:</b> ${esc(loading.plate1 || '-')} ${loading.plate2 ? '/ ' + esc(loading.plate2) : ''}
👤 <b>Sürücü:</b> ${esc(loading.driver_name || '-')}

📦 <b>Yük Bilgisi:</b>
• Ürün Çeşidi: ${Array.isArray(loading.products) ? loading.products.length : 0}
• Toplam Adet: ${totalItems}
• Toplam Palet: ${totalPallets}

📍 <b>Varış:</b> ${esc(loading.destination_company || '-')} (${esc(loading.destination_country || '-')})
👤 <b>Müşteri:</b> ${esc(loading.destination_customer || '-')}

🔗 <a href="${(process.env.PUBLIC_URL || 'http://localhost:5000').replace(/\/$/, '')}/manager.html">Detayları Görüntüle</a>
    `.trim();
}

// Send a report's attached photos/videos as DOCUMENTS (uncompressed, full quality).
// Unlike sendPhoto (which Telegram recompresses and downscales), sendDocument
// transmits the ORIGINAL bytes untouched. Takes an explicit bot/chat so it can be
// unit-tested with a mock bot.
async function sendPhotosAsDocuments(botInst, chat, loading, uploadsDir) {
    if (!botInst || !chat) return 0;
    const photos = Array.isArray(loading.loaded_vehicle_photos) ? loading.loaded_vehicle_photos : [];
    if (photos.length === 0) return 0;

    const shortId = loading.id ? String(loading.id).slice(0, 8) : '????????';
    let sent = 0;

    for (let i = 0; i < photos.length; i++) {
        const url = photos[i];
        if (typeof url !== 'string' || !url) continue;

        // Build the file input + filename/MIME. Local /uploads/ files are read from
        // disk; any leftover absolute URL is handed to Telegram to fetch directly.
        // A factory because a read stream is single-use (needed for the 429 retry).
        const makeInput = () => {
            if (url.startsWith('/uploads/')) {
                const name = path.basename(url); // path-traversal safe
                const filePath = path.join(uploadsDir, name);
                if (!fs.existsSync(filePath)) return null;
                const ext = path.extname(name).toLowerCase();
                return {
                    input: fs.createReadStream(filePath),
                    fileOptions: { filename: name, contentType: MIME_BY_EXT[ext] || 'application/octet-stream' },
                };
            }
            if (/^https?:\/\//i.test(url)) return { input: url, fileOptions: {} };
            return null;
        };

        const resolved = makeInput();
        if (!resolved) {
            console.error(`⚠️ Telegram: skipping unsendable/missing file: ${url}`);
            continue;
        }

        // Caption only on the first file, identifying the report (plain text).
        const opts = {};
        if (sent === 0) {
            opts.caption = `📎 ${shortId} • ${loading.plate1 ? String(loading.plate1) : '-'} (${photos.length} dosya)`;
        }

        try {
            await botInst.sendDocument(chat, resolved.input, opts, resolved.fileOptions);
            sent++;
        } catch (error) {
            // Honor Telegram's rate-limit (HTTP 429): wait the requested time, retry once.
            const retryAfter = error && error.response && error.response.body
                && error.response.body.parameters && error.response.body.parameters.retry_after;
            if (retryAfter) {
                await sleep((Number(retryAfter) + 1) * 1000);
                const again = makeInput(); // rebuild — the previous stream is consumed
                if (again) {
                    try {
                        await botInst.sendDocument(chat, again.input, opts, again.fileOptions);
                        sent++;
                    } catch (e2) {
                        console.error(`❌ Telegram sendDocument retry failed (${url}): ${e2.message}`);
                    }
                }
            } else {
                console.error(`❌ Telegram sendDocument failed (${url}): ${error.message}`);
            }
        }

        // Gentle pacing between files to stay under group rate limits.
        if (i < photos.length - 1) await sleep(400);
    }

    if (sent > 0) console.log(`📎 Telegram: sent ${sent}/${photos.length} report file(s) as documents for ${shortId}`);
    return sent;
}

// Send Notification (text), then attach the report's files as full-quality documents.
async function sendNotification(loading, type = 'new') {
    if (!bot || !chatId) return;

    try {
        const message = formatLoadingMessage(loading, type);
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        console.log(`📨 Telegram notification sent for report ${loading.id}`);
    } catch (error) {
        console.error('❌ Failed to send Telegram notification:', error.message);
    }

    // Attach the report's photos/videos as uncompressed documents. Runs in the
    // BACKGROUND so it never delays the HTTP response that triggered the notification.
    if (type === 'new' || type === 'update_important') {
        sendPhotosAsDocuments(bot, chatId, loading, UPLOADS_DIR)
            .catch((e) => console.error('❌ Telegram report-files failed:', e.message));
    }
}

module.exports = {
    sendNotification,
    sendPhotosAsDocuments, // exported for tests
};
