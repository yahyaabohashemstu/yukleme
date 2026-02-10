const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials in .env file');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function updateLoaderCredentials() {
    console.log('🔄 Updating loader credentials...');

    try {
        // Hash the new password
        const newPassword = await bcrypt.hash('murat123', 10);
        const newUsername = 'murat';

        // Check if 'loader' user exists
        const { data: loaderUser, error: findError } = await supabase
            .from('users')
            .select('*')
            .eq('role', 'loader')
            .single(); // Assuming only one loader role user for now based on previous code

        if (findError && findError.code !== 'PGRST116') { // PGRST116 is "The result contains 0 rows"
            console.error('❌ Error finding loader user:', findError);
            return;
        }

        if (loaderUser) {
            console.log(`Found user with role 'loader': ${loaderUser.username}`);
            // Update the existing user
            const { error: updateError } = await supabase
                .from('users')
                .update({
                    username: newUsername,
                    password: newPassword
                })
                .eq('id', loaderUser.id);

            if (updateError) {
                console.error('❌ Error updating user:', updateError);
            } else {
                console.log(`✅ Successfully updated user credentials to: ${newUsername} / murat123`);
            }
        } else {
            console.log("⚠️ No user with role 'loader' found. Creating new user...");
            // If not found (maybe deleted?), insert new one
            const { error: insertError } = await supabase
                .from('users')
                .insert([
                    { username: newUsername, password: newPassword, role: 'loader' }
                ]);

            if (insertError) {
                console.error('❌ Error creating user:', insertError);
            } else {
                console.log(`✅ Successfully created user: ${newUsername} / murat123`);
            }
        }

    } catch (error) {
        console.error('❌ Unexpected error:', error);
    }
}

updateLoaderCredentials();
