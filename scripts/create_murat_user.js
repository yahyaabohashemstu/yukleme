// Migrated to the local SQLite adapter (was the Supabase client).
const { supabase } = require('../database');
const bcrypt = require('bcryptjs');

async function createMuratUser() {
    console.log('🔄 Creating new loader user: murat');

    try {
        // 1. Check if 'murat' already exists
        const { data: existingUser } = await supabase
            .from('users')
            .select('*')
            .eq('username', 'murat')
            .single();

        if (existingUser) {
            console.log('⚠️ User "murat" already exists. Cannot update due to RLS policies.');
            console.log('   If you need to change password, please delete this user from Supabase dashboard and run this script again.');
            return;
        }

        // 2. Create new user
        const hashedPassword = await bcrypt.hash('murat123', 10);

        const { data, error } = await supabase
            .from('users')
            .insert([
                {
                    username: 'murat',
                    password: hashedPassword,
                    role: 'loader'
                }
            ])
            .select();

        if (error) {
            console.error('❌ Error creating user:', error);
            // Check for RLS error
            if (error.code === '42501') {
                console.error('   (Permission denied - RLS policy violation)');
            }
        } else {
            console.log('✅ Successfully created user: murat / murat123');
            console.log('   Note: The old "loader" user still exists but you can now login as "murat".');
        }

    } catch (err) {
        console.error('❌ Unexpected error:', err);
    }
}

createMuratUser();
