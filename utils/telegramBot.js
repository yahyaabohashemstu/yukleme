const TelegramBot = require('node-telegram-bot-api');
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

// Function to format the message
function formatLoadingMessage(loading, type = 'new') {
    const title = type === 'new' ? '🆕 <b>Yeni Rapor Oluşturuldu</b>' : '✏️ <b>Rapor Güncellendi</b>';
    // Format Date & Time (Turkey time)
    const createdAt = new Date(loading.created_at || new Date());
    const formattedDateTime = createdAt.toLocaleString('tr-TR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    const date = new Date(loading.loading_date).toLocaleDateString('tr-TR');

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

📄 <b>Rapor ID:</b> <code>${loading.id.slice(0, 8)}</code>
🕒 <b>Yükleme Zamanı:</b> ${formattedDateTime}
📅 <b>Tarih:</b> ${date}
🚛 <b>Plaka:</b> ${loading.plate1 || '-'} ${loading.plate2 ? '/ ' + loading.plate2 : ''}
👤 <b>Sürücü:</b> ${loading.driver_name || '-'}

📦 <b>Yük Bilgisi:</b>
• Ürün Çeşidi: ${loading.products ? loading.products.length : 0}
• Toplam Adet: ${totalItems}
• Toplam Palet: ${totalPallets}

📍 <b>Varış:</b> ${loading.destination_company || '-'} (${loading.destination_country || '-'})
👤 <b>Müşteri:</b> ${loading.destination_customer || '-'}

🔗 <a href="http://localhost:3000/manager.html">Detayları Görüntüle</a>
    `.trim();
}

// Send Notification
async function sendNotification(loading, type = 'new') {
    if (!bot || !chatId) return;

    try {
        const message = formatLoadingMessage(loading, type);
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        console.log(`📨 Telegram notification sent for report ${loading.id}`);
    } catch (error) {
        console.error('❌ Failed to send Telegram notification:', error.message);
    }
}

module.exports = {
    sendNotification
};
