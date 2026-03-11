const express = require('express');
const cookieSession = require('cookie-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const { supabase, initializeDatabase } = require('./database');
const { sendNotification } = require('./utils/telegramBot');

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy is required for secure cookies on Render/Heroku
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session configuration
app.use(cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'yukleme-secret-key',
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year (Never log out)
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
}));





// Multer setup (Memory Storage for Supabase)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Sadece resim ve video dosyaları yüklenebilir.'));
        }
    }
});

// Helper: Upload file to Supabase Storage
async function uploadToSupabase(file) {
    const fileExt = path.extname(file.originalname);
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${fileExt}`;
    const filePath = `${fileName}`;

    const { data, error } = await supabase
        .storage
        .from('loading-photos')
        .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false
        });

    if (error) throw error;

    // Get Public URL
    const { data: { publicUrl } } = supabase
        .storage
        .from('loading-photos')
        .getPublicUrl(filePath);

    return publicUrl;
}

// Auth middleware
const requireAuth = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
    }
    next();
};

const requireLoader = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.' }); // Session expired
    }
    if (req.session.user.role !== 'loader') {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok (Sadece Loader).' });
    }
    next();
};

const requireManager = (req, res, next) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Oturum süresi doldu. Lütfen tekrar giriş yapın.' }); // Session expired
    }
    if (req.session.user.role !== 'manager') {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz yok (Sadece Manager).' });
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
    req.session = null;
    res.json({ message: 'تم تسجيل الخروج بنجاح' });
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
app.post('/api/loadings', requireLoader, upload.array('photos'), async (req, res) => {
    try {
        // Upload Photos to Supabase
        const uploadedUrls = [];
        if (req.files && req.files.length > 0) {
            const uploadPromises = req.files.map(file => uploadToSupabase(file));
            const results = await Promise.all(uploadPromises);
            uploadedUrls.push(...results);
        }

        // Parse products (sent as JSON string in FormData)
        let products = [];
        try {
            products = JSON.parse(req.body.products || '[]');
        } catch (e) {
            products = [];
        }

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
            container_no: req.body.container_no || null,
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
            products: products,

            // Documentation (Using loaded_vehicle_photos as the main gallery)
            goods_photos: [],
            damaged_goods_photos: [],
            scale_receipt_photo: null,
            loaded_vehicle_photos: uploadedUrls, // All photos go here

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

        // Send Telegram Notification (Async, don't block response)
        try {
            await sendNotification(data, 'new');
        } catch (notifyError) {
            console.error('Notification failed:', notifyError);
        }

        res.status(201).json({
            message: 'تم إرسال بيانات التحميل بنجاح',
            loading: data
        });
    } catch (error) {
        console.error('Create loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم: ' + error.message });
    }
});

// Get my loadings (loader only)
app.get('/api/my-loadings', requireLoader, async (req, res) => {
    try {
        console.log('Fetching all active loadings for loader view');
        const { data, error } = await supabase
            .from('loadings')
            .select('*, users!created_by(username)')
            .eq('is_archived', false)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Fetch error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء جلب البيانات' });
        }

        console.log('Found loadings:', data ? data.length : 0);
        if (data && data.length > 0) {
            console.log('Sample loading data (first item):', JSON.stringify(data[0], null, 2));
        }
        res.json(data || []);
    } catch (error) {
        console.error('Get my loadings error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Get all loadings (manager only)
app.get('/api/loadings', requireManager, async (req, res) => {
    try {
        const fetchArchived = req.query.archived === 'true';

        const { data, error } = await supabase
            .from('loadings')
            .select('*, loading_versions(count), users!created_by(username)')
            .eq('is_archived', fetchArchived)
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
            .select('*, users!archived_by(username)')
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

// Update loading (loader or manager) - Archives old version
app.put('/api/loadings/:id', requireAuth, upload.array('photos'), async (req, res) => {
    try {
        const id = req.params.id;
        const currentUser = req.session.user;
        const currentRole = currentUser?.role;

        if (!currentRole || !['loader', 'manager'].includes(currentRole)) {
            return res.status(403).json({ error: 'Bu işlem için yetkiniz yok.' });
        }

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
                archived_by: currentUser.id
            }]);

        if (archiveError) {
            console.error('Archive error:', archiveError);
            return res.status(500).json({ error: 'فشل في أرشفة النسخة الحالية' });
        }

        // 3. Process Photos
        // New uploads
        const newUploadedUrls = [];
        if (req.files && req.files.length > 0) {
            const uploadPromises = req.files.map(file => uploadToSupabase(file));
            const results = await Promise.all(uploadPromises);
            newUploadedUrls.push(...results);
        }

        // Preserve existing photos (sent as strings in body)
        // req.body.loaded_vehicle_photos might be a single string or an array of strings
        let preservedPhotos = [];
        if (req.body.loaded_vehicle_photos) {
            if (Array.isArray(req.body.loaded_vehicle_photos)) {
                preservedPhotos = req.body.loaded_vehicle_photos;
            } else {
                preservedPhotos = [req.body.loaded_vehicle_photos];
            }
        }

        // Combine
        const finalPhotos = [...preservedPhotos, ...newUploadedUrls];


        // 4. Prepare new data
        // Parse products if sent as string (Multipart form data sends JSON as string)
        let products = [];
        if (typeof req.body.products === 'string') {
            try {
                products = JSON.parse(req.body.products);
            } catch (e) {
                products = [];
            }
        } else {
            products = req.body.products || [];
        }

        // 4. Prepare new data
        const managerEditNote = 'Bu rapor yönetici tarafından düzenlenmiştir.';

        let comments = req.body.comments;
        if (currentRole === 'manager') {
            const existingComments = comments || current.comments || '';
            if (!existingComments.includes(managerEditNote)) {
                comments = existingComments
                    ? `${managerEditNote}\n\n${existingComments}`
                    : managerEditNote;
            } else {
                comments = existingComments;
            }
        } else {
            // It's a loader making the edit. We MUST preserve existing comments since loader edit form doesn't send them,
            // AND we MUST remove the managerEditNote if it was previously added by a manager.
            const existingComments = comments || current.comments || '';
            comments = existingComments.replace(managerEditNote, '').trim();
        }

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
            products: products,
            goods_photos: [], // Reserved for future use if needed, currently unused in UI
            damaged_goods_photos: [], // Reserved
            scale_receipt_photo: null, // Reserved
            loaded_vehicle_photos: finalPhotos, // All photos go here
            entry_time: req.body.entry_time === '' ? null : req.body.entry_time,
            exit_time: req.body.exit_time === '' ? null : req.body.exit_time,
            comments,
            // Reset recorded status on edit
            is_recorded: false,
            recorded_at: null,
            recorded_by: null,
            recorded_at: null,
            recorded_by: null,
            // Clear specific manager records
            safwat_recorded_at: null,
            pinar_recorded_at: null,
            // Reset viewed status so it appears as "New/Edited" to managers
            viewed_at: null
        };

        // 5. Update
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

        // Send Telegram Notification (Conditional)
        try {
            // Only send notifications if the user is a loader, not a manager
            if (req.session.user.role !== 'manager') {
                // Check if ANY manager has viewed the report
                // current.viewed_at is set when any manager opens the report
                if (current.viewed_at) {
                    // If viewed, send URGENT alert
                    console.log(`Report ${id} changed after viewing. Sending ALERT.`);
                    await sendNotification(updated, 'update_important');
                } else {
                    // If NOT viewed, update silently (No notification)
                    console.log(`Report ${id} updated before viewing. Silent update.`);
                }
            } else {
                console.log(`Report ${id} updated by manager. No Telegram notification sent.`);
            }
        } catch (notifyError) {
            console.error('Notification failed:', notifyError);
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
        const username = req.session.user.username ? req.session.user.username.trim().toLowerCase() : 'safwat';
        const now = new Date().toISOString();

        // Determine which column to update based on username
        let updateData = {};
        if (username === 'pinar') {
            updateData.pinar_recorded_at = now;
        } else {
            // Default to safwat for manager/other
            updateData.safwat_recorded_at = now;
        }

        // BACKWARD COMPATIBILITY:
        // Also update legacy columns so 'is_recorded' becomes true if AT LEAST ONE manager recorded it.
        updateData.is_recorded = true;
        updateData.recorded_at = now;
        updateData.recorded_by = req.session.user.id;

        const { data, error } = await supabase
            .from('loadings')
            .update(updateData)
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
        const username = req.session.user.username ? req.session.user.username.trim().toLowerCase() : 'safwat';

        // Determine which column to clear based on username
        let updateData = {};
        if (username === 'pinar') {
            updateData.pinar_recorded_at = null;
        } else {
            // Default to safwat for manager/other
            updateData.safwat_recorded_at = null;
        }

        // We first update the specific column
        const { data: updatedSpecific, error: updateError } = await supabase
            .from('loadings')
            .update(updateData)
            .eq('id', req.params.id)
            .select()
            .single();

        if (updateError) {
            console.error('Update error:', updateError);
            return res.status(500).json({ error: 'حدث خطأ أثناء إلغاء التقييد' });
        }

        // BACKWARD COMPATIBILITY CHECK:
        // If BOTH are null, then set is_recorded = false
        const s = updatedSpecific.safwat_recorded_at;
        const p = updatedSpecific.pinar_recorded_at;

        if (!s && !p) {
            const { data: finalData, error: finalError } = await supabase
                .from('loadings')
                .update({
                    is_recorded: false,
                    recorded_at: null,
                    recorded_by: null
                })
                .eq('id', req.params.id)
                .select()
                .single();

            if (!finalError) {
                return res.json({ message: 'تم إلغاء التقييد بنجاح', loading: finalData });
            }
        }

        res.json({
            message: 'تم إلغاء التقييد بنجاح',
            loading: updatedSpecific
        });
    } catch (error) {
        console.error('Unrecord loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});



// Archive loading (manager only)
app.patch('/api/loadings/:id/archive', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .update({ is_archived: true })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Archive error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء أرشفة التقرير' });
        }

        res.json({ message: 'تم أرشفة التقرير بنجاح', loading: data });
    } catch (error) {
        console.error('Archive loading error:', error);
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
    }
});

// Restore loading (manager only)
app.patch('/api/loadings/:id/restore', requireManager, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('loadings')
            .update({ is_archived: false })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) {
            console.error('Restore error:', error);
            return res.status(500).json({ error: 'حدث خطأ أثناء عرض التقرير' });
        }

        res.json({ message: 'تم استعادة التقرير بنجاح', loading: data });
    } catch (error) {
        console.error('Restore loading error:', error);
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
        console.log(`   Loader 1: username=murat, password=murat123`);
        console.log(`   Loader 2: username=mahmud, password=mahmud123`);
        console.log(`   Manager: username=manager, password=manager123`);
        console.log(`   Manager: username=pinar, password=pinar123\n`);
    });
}

startServer();
