const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials in .env file');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize database tables
async function initializeDatabase() {
    console.log('Checking database tables...');

    // Check if users table has data, if not, create default users
    const { data: existingUsers, error: usersError } = await supabase
        .from('users')
        .select('id')
        .limit(1);

    if (usersError) {
        console.log('Users table might not exist. Please run the SQL setup in Supabase.');
        console.log('SQL to run in Supabase SQL Editor:');
        console.log(`
-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('loader', 'manager')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create loadings table
CREATE TABLE IF NOT EXISTS loadings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    -- Team info
    manager TEXT,
    worker1 TEXT,
    worker2 TEXT,
    worker3 TEXT,
    worker4 TEXT,
    
    -- Vehicle info
    plate1 TEXT,
    plate2 TEXT,
    loading_date DATE,
    
    -- Weight info
    product_weight TEXT,
    vehicle_weight_after TEXT,
    destination_company TEXT,
    destination_country TEXT,
    destination_customer TEXT,
    
    -- Driver info
    driver_name TEXT,
    driver_phone TEXT,
    forklift_operator TEXT,
    
    -- Products (JSON array)
    products JSONB DEFAULT '[]',
    
    -- Documentation
    goods_photos TEXT[] DEFAULT '{}',
    damaged_goods_photos TEXT[] DEFAULT '{}',
    scale_receipt_photo TEXT,
    loaded_vehicle_photos TEXT[] DEFAULT '{}',
    
    -- Times
    entry_time TIME,
    exit_time TIME,
    
    -- Comments
    comments TEXT,
    
    -- Metadata
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create storage bucket for images (run this separately)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('loading-images', 'loading-images', true);
        `);
        return false;
    }

    if (!existingUsers || existingUsers.length === 0) {
        console.log('Creating default users...');
        const bcrypt = require('bcryptjs');

        const loaderPassword = await bcrypt.hash('murat123', 10);
        const managerPassword = await bcrypt.hash('manager123', 10);
        const pinarPassword = await bcrypt.hash('pinar123', 10);

        const { error: insertError } = await supabase
            .from('users')
            .insert([
                { username: 'murat', password: loaderPassword, role: 'murat' },
                { username: 'manager', password: managerPassword, role: 'manager' },
                { username: 'pinar', password: pinarPassword, role: 'manager' }
            ]);

        if (insertError) {
            console.error('Error creating default users:', insertError);
            return false;
        }
        console.log('Default users created successfully!');
    }

    return true;
}

module.exports = { supabase, initializeDatabase };
