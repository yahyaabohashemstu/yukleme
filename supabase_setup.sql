-- =============================================
-- نظام إدارة التحميل - Yükleme Belgesi
-- Database Setup Script for Supabase
-- =============================================

-- 1. Create users table
CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('loader', 'manager')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create loadings table
CREATE TABLE IF NOT EXISTS loadings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    
    -- Team info (معلومات الفريق)
    manager TEXT,
    worker1 TEXT,
    worker2 TEXT,
    worker3 TEXT,
    worker4 TEXT,
    
    -- Vehicle info (معلومات المركبة)
    plate1 TEXT,
    plate2 TEXT,
    loading_date DATE,
    
    -- Weight info (الأوزان والوجهة)
    product_weight TEXT,
    vehicle_weight_after TEXT,
    destination_company TEXT,
    destination_country TEXT,
    destination_customer TEXT,
    
    -- Driver info (معلومات السائقين)
    driver_name TEXT,
    driver_phone TEXT,
    forklift_operator TEXT,
    
    -- Products (البضائع) - JSON array
    products JSONB DEFAULT '[]',
    
    -- Documentation (التوثيق) - file paths
    goods_photos TEXT[] DEFAULT '{}',
    damaged_goods_photos TEXT[] DEFAULT '{}',
    scale_receipt_photo TEXT,
    loaded_vehicle_photos TEXT[] DEFAULT '{}',
    
    -- Times (الأوقات)
    entry_time TIME,
    exit_time TIME,
    
    -- Comments (الملاحظات)
    comments TEXT,
    
    -- Recording status (for manager)
    is_recorded BOOLEAN DEFAULT FALSE,
    recorded_at TIMESTAMP WITH TIME ZONE,
    recorded_by UUID REFERENCES users(id),
    
    -- Metadata
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create loading_versions table (for history)
CREATE TABLE IF NOT EXISTS loading_versions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    loading_id UUID REFERENCES loadings(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    data JSONB NOT NULL,
    archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    archived_by UUID REFERENCES users(id)
);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE loadings ENABLE ROW LEVEL SECURITY;

-- 4. Create policies for public access (for this demo)
-- Users table policies
CREATE POLICY "Allow public read on users" ON users FOR SELECT USING (true);
CREATE POLICY "Allow public insert on users" ON users FOR INSERT WITH CHECK (true);

-- Loadings table policies
CREATE POLICY "Allow public read on loadings" ON loadings FOR SELECT USING (true);
CREATE POLICY "Allow public insert on loadings" ON loadings FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on loadings" ON loadings FOR UPDATE USING (true);

-- 5. Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_loadings_date ON loadings(loading_date DESC);
CREATE INDEX IF NOT EXISTS idx_loadings_created ON loadings(created_at DESC);
