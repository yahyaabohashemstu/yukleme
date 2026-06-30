// Migrated to the local SQLite adapter (was the Supabase client).
const { supabase } = require('../database');
const bcrypt = require('bcryptjs');

async function testLogin() {
    console.log('🕵️‍♀️ Testing Login for user: murat');

    try {
        // 1. Fetch user by username
        console.log('1. Fetching user from DB...');
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', 'murat') // Try exact match
            ; // Get all matches just in case

        if (error) {
            console.error('❌ database error:', error);
            return;
        }

        if (!user || user.length === 0) {
            console.error('❌ User "murat" not found in database.');
            // Dump all users to see what's there
            const { data: allUsers } = await supabase.from('users').select('username, role');
            console.log('Existing users:', allUsers);
            return;
        }

        console.log(`✅ Found ${user.length} user(s) with username "murat".`);
        const targetUser = user[0];
        console.log('User details:', {
            id: targetUser.id,
            username: targetUser.username,
            role: targetUser.role,
            passwordHashLength: targetUser.password ? targetUser.password.length : 0
        });

        // 2. Test Password
        console.log('2. Testing password "murat123"...');
        const match = await bcrypt.compare('murat123', targetUser.password);

        if (match) {
            console.log('✅ Password MATCHES!');
        } else {
            console.error('❌ Password DOES NOT match.');
        }

    } catch (err) {
        console.error('❌ Script error:', err);
    }
}

testLogin();
