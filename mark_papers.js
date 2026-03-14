require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);

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
