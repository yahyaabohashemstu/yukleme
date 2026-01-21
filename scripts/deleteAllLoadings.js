const { supabase } = require('../database');

async function deleteAllLoadings() {
    console.log('🗑️  Deleting all loadings...');

    // Delete versions first (Foreign Key constraint)
    const { error: versionsError, count: versionsCount } = await supabase
        .from('loading_versions')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Hack to delete all

    if (versionsError) {
        console.error('❌ Error deleting versions:', versionsError);
    } else {
        console.log(`✅ Deleted versions.`);
    }

    // Delete loadings
    const { error: loadingsError, count: loadingsCount } = await supabase
        .from('loadings')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Hack to delete all

    if (loadingsError) {
        console.error('❌ Error deleting loadings:', loadingsError);
    } else {
        console.log(`✅ Deleted loadings.`);
    }

    console.log('🎉 Database cleared!');
    process.exit(0);
}

deleteAllLoadings().catch(err => {
    console.error(err);
    process.exit(1);
});
