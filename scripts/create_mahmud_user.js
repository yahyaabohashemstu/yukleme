const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function createMahmudUser() {
    console.log('🔄 Creating new loader user: mahmud');

    try {
        // 1. Check if 'mahmud' already exists
        const { data: existingUser } = await supabase
            .from('users')
            .select('*')
            .eq('username', 'mahmud')
            .single();

        if (existingUser) {
            console.log('⚠️ User "mahmud" already exists. Skipping creation.');
            return;
        }

        // 2. Create new user
        const hashedPassword = await bcrypt.hash('mahmud123', 10);

        const { data, error } = await supabase
            .from('users')
            .insert([
                {
                    username: 'mahmud',
                    password: hashedPassword,
                    role: 'loader'
                }
            ])
            .select();

        if (error) {
            console.error('❌ Error creating user:', error);
        } else {
            console.log('✅ Successfully created user: mahmud / mahmud123');
        }

    } catch (err) {
        console.error('❌ Unexpected error:', err);
    }
}

createMahmudUser();
