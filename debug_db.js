const { supabase } = require('./database');

async function test() {
    try {
        console.log('--- Fetching latest loading ---');
        const { data: latestLoading, error: loadingErr } = await supabase
            .from('loadings')
            .select('id, manager, worker1, comments')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (loadingErr) throw loadingErr;
        console.log(JSON.stringify(latestLoading, null, 2));

        console.log('\n--- Fetching versions for this loading ---');
        const { data: versions, error: versionsErr } = await supabase
            .from('loading_versions')
            .select('version_number, archived_by, data')
            .eq('loading_id', latestLoading.id)
            .order('version_number', { ascending: false });

        if (versionsErr) throw versionsErr;

        versions.forEach(v => {
            console.log(`Version ${v.version_number}: manager=${v.data.manager}, worker1=${v.data.worker1}`);
            console.log(`Comments in Version ${v.version_number}: "${v.data.comments}"`);
        });

    } catch (err) {
        console.error('Error:', err);
    }
}

test();
