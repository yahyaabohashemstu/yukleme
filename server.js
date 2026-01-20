const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const { supabase, initializeDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy is required for secure cookies on Render/Heroku
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'yukleme-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));





// Auth middleware
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
    }
    next();
};

const requireLoader = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'loader') {
        return res.status(403).json({ error: 'غير مصرح - هذه الصفحة لمسؤول التحميل فقط' });
    }
    next();
};

const requireManager = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'manager') {
        return res.status(403).json({ error: 'غير مصرح - هذه الصفحة لمدير الإنتاج فقط' });
    }
    next();
};

// ============ AUTH ROUTES ============

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
        }

        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            role: user.role
        };

        res.json({
            message: 'تم تسجيل الدخول بنجاح',
            user: {
                username: user.username,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الخروج' });
        }
        res.json({ message: 'تم تسجيل الخروج بنجاح' });
    });
});

// Check auth status
app.get('/api/check-auth', (req, res) => {
    if (req.session.user) {
        res.json({
            authenticated: true,
            user: req.session.user
        });
    } else {
        res.json({ authenticated: false });
    }
});

// ============ LOADING ROUTES ============

// Create new loading (loader only)
// Create new loading (loader only)
app.post('/api/loadings', requireLoader, async (req, res) => {
    try {
        const loadingData = {
            // Team info
            manager: req.body.manager || null,
            worker1: req.body.worker1 || null,
            worker2: req.body.worker2 || null,
            worker3: req.body.worker3 || null,
            worker4: req.body.worker4 || null,

            // Vehicle info
            plate1: req.body.plate1 || null,
            plate2: req.body.plate2 || null,
            loading_date: req.body.loading_date || null,

            // Weight info
            product_weight: req.body.product_weight || null,
            vehicle_weight_after: req.body.vehicle_weight_after || null,
            destination_company: req.body.destination_company || null,
            destination_country: req.body.destination_country || null,
            destination_customer: req.body.destination_customer || null,

            // Driver info
            driver_name: req.body.driver_name || null,
            driver_phone: req.body.driver_phone || null,
            forklift_operator: req.body.forklift_operator || null,

            // Products
            products: req.body.products || [],

            // Documentation (Removed)
            goods_photos: [],
            damaged_goods_photos: [],
            scale_receipt_photo: null,
            loaded_vehicle_photos: [],

            // Times
            entry_time: req.body.entry_time || null,
            exit_time: req.body.exit_time || null,

            // Comments
            comments: req.body.comments || null,

            // Metadata
            created_by: req.session.user.id
        };

        const { data, error } = await supabase
            .from('loadings')
            .insert([loadingData])
            .select()
            .single();

        if (error) {
            console.error('Insert error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء حفظ البيانات' });
        }

        res.status(201).json({
            message: 'تم إرسال بيانات التحميل بنجاح',
            loading: data
        });
    } catch (error) {
        console.error('Create loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Get my loadings (loader only)
app.get('/api/my-loadings', requireLoader, async (req, res) => {
    try {
        console.log('Fetching loadings for user:', req.session.user.id);
        const { data, error } = await supabase
            .from('loadings')
            .select('*')
            .eq('created_by', req.session.user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Fetch error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء جلب البيانات' });
        }

        console.log('Found loadings:', data ? data.length : 0);
        res.json(data || []);
    } catch (error) {
        console.error('Get my loadings error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Get all loadings (manager only)
app.get('/api/loadings', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Fetch error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء جلب البيانات' });
        }

        res.json(data || []);
    } catch (error) {
        console.error('Get loadings error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Get single loading (manager only)
app.get('/api/loadings/:id', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error) {
            return res.status(404).json({ error: 'لم يتم العثور على بيانات التحميل' });
        }

        res.json(data);
    } catch (error) {
        console.error('Get loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});



// Get loading versions (loader & manager)
app.get('/api/loadings/:id/versions', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loading_versions')
            .select('*')
            .eq('loading_id', req.params.id)
            .order('version_number', { ascending: false });

        if (error) {
            console.error('Fetch versions error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء جلب النسخ' });
        }

        res.json(data || []);
    } catch (error) {
        console.error('Get versions error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Update loading (loader only) - Archives old version
app.put('/api/loadings/:id', requireLoader, async (req, res) => {
    try {
        const id = req.params.id;

        // 1. Get current data
        const { data: current, error: fetchError } = await supabase
            .from('loadings')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !current) {
            return res.status(404).json({ error: 'التقرير غير موجود' });
        }

        // 2. Archive current data
        // Get next version number
        const { count, error: countError } = await supabase
            .from('loading_versions')
            .select('*', { count: 'exact', head: true })
            .eq('loading_id', id);

        const nextVersion = (count || 0) + 1;

        const { error: archiveError } = await supabase
            .from('loading_versions')
            .insert([{
                loading_id: id,
                version_number: nextVersion,
                data: current,
                archived_by: req.session.user.id
            }]);

        if (archiveError) {
            console.error('Archive error:', archiveError);
            return res.status(500).json({ error: 'فشل في أرشفة النسخة الحالية' });
        }

        // 3. Prepare new data
        const updateData = {
            manager: req.body.manager,
            worker1: req.body.worker1,
            worker2: req.body.worker2,
            worker3: req.body.worker3,
            worker4: req.body.worker4,
            plate1: req.body.plate1,
            plate2: req.body.plate2,
            loading_date: req.body.loading_date,
            product_weight: req.body.product_weight,
            vehicle_weight_after: req.body.vehicle_weight_after,
            destination_company: req.body.destination_company,
            destination_country: req.body.destination_country,
            destination_customer: req.body.destination_customer,
            driver_name: req.body.driver_name,
            driver_phone: req.body.driver_phone,
            forklift_operator: req.body.forklift_operator,
            products: req.body.products || [],
            goods_photos: [],
            damaged_goods_photos: [],
            scale_receipt_photo: null,
            loaded_vehicle_photos: [],
            entry_time: req.body.entry_time,
            exit_time: req.body.exit_time,
            comments: req.body.comments,
            // Reset recorded status on edit?
            is_recorded: false,
            recorded_at: null,
            recorded_by: null
        };

        // 4. Update
        const { data: updated, error: updateError } = await supabase
            .from('loadings')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (updateError) {
            console.error('Update error:', updateError);
            return res.status(500).json({ error: 'فشل تديث البيانات' });
        }

        res.json({ message: 'تم التحديث بنجاح', loading: updated });


    } catch (error) {
        console.error('Update loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Mark loading as recorded (manager only)
app.patch('/api/loadings/:id/record', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .update({
                is_recorded: true,
                recorded_at: new Date().toISOString(),
                recorded_by: req.session.user.id
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Update error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء تحديث الحالة' });
        }

        res.json({
            message: 'تم تسجيل التقييد بنجاح',
            loading: data
        });
    } catch (error) {
        console.error('Record loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Cancel recording (manager only)
app.patch('/api/loadings/:id/unrecord', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .update({
                is_recorded: false,
                recorded_at: null,
                recorded_by: null
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Update error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء إلغاء التقييد' });
        }

        res.json({
            message: 'تم إلغاء التقييد بنجاح',
            loading: data
        });
    } catch (error) {
        console.error('Unrecord loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Mark loading as viewed (manager only)
app.patch('/api/loadings/:id/view', requireManager, async (req, res) => {
    try {
        // Only update if viewed_at is null
        const { data, error } = await supabase
            .from('loadings')
            .update({ viewed_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .is('viewed_at', null)
            .select()
            .single();

        if (error) {
            // Check if it's just that it was already viewed (update returned no rows)
            // If no row was updated, it might be because of the .is('viewed_at', null) filter
            // We don't error out, just return success
            return res.json({ message: 'View recorded' });
        }

        res.json({ message: 'View recorded', loading: data });
    } catch (error) {
        console.error('View loading error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Redirect routes based on role
app.get('/loader', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loader.html'));
});

app.get('/manager', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

// Start server
async function startServer() {
    const dbReady = await initializeDatabase();
    if (!dbReady) {
        console.log('\n⚠️  Please set up the database tables in Supabase first.\n');
    }

    app.listen(PORT, () => {
        console.log(`\n🚀 Server running on http://localhost:${PORT}`);
        console.log(`\n📋 Default users:`);
        console.log(`   Loader: username=loader, password=loader123`);
        console.log(`   Manager: username=manager, password=manager123\n`);
    });
}

startServer();
