const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function testSql() {
  try {
    const { data, error } = await supabase.rpc('exec_sql', { 
      sql_query: 'SELECT 1' 
    });
    if (error) {
      console.log('RPC exec_sql error:', error.message);
    } else {
      console.log('RPC exec_sql success:', data);
    }
  } catch (e) {
    console.log('Catch error:', e.message);
  }
}

testSql();
