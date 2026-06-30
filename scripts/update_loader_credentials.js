// Set (or create) a user's password by USERNAME.
// Usage: node scripts/update_loader_credentials.js <username> <password> [role]
//   role defaults to 'loader' and is only used when creating a new user.
const { supabase } = require('../database');
const bcrypt = require('bcryptjs');

async function run() {
    const username = process.argv[2] || 'murat';
    const password = process.argv[3] || (username + '123');
    const role = process.argv[4] || 'loader';

    console.log(`🔄 Setting credentials for "${username}"...`);
    try {
        const hashed = await bcrypt.hash(password, 10);

        // Look the user up by its UNIQUE username (NOT by role — there can be
        // several loaders, which would make .single() return a PGRST116 error).
        const { data: user, error: findError } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        if (findError && findError.code !== 'PGRST116') {
            console.error('❌ Error finding user:', findError);
            return;
        }

        if (user) {
            const { error } = await supabase
                .from('users')
                .update({ password: hashed })
                .eq('id', user.id);
            if (error) console.error('❌ Error updating user:', error);
            else console.log(`✅ Password updated for "${username}".`);
        } else {
            const { error } = await supabase
                .from('users')
                .insert([{ username, password: hashed, role }]);
            if (error) console.error('❌ Error creating user:', error);
            else console.log(`✅ Created user "${username}" (role: ${role}).`);
        }
    } catch (error) {
        console.error('❌ Unexpected error:', error);
    }
}

run();
