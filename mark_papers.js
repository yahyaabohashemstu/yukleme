require('dotenv').config();
// Migrated to the local SQLite adapter (was the Supabase client).
const { supabase } = require('./database');

async function markAllPapersDelivered() {
    const now = new Date().toISOString();

    const { error } = await supabase
        .from('loadings')
        .update({
            paper_delivered_at: now,
            paper_confirmed_at: now
        })
        .is('paper_confirmed_at', null);

    if (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }

    console.log('✅ All existing reports marked as papers delivered and confirmed!');
    process.exit(0);
}

markAllPapersDelivered();
