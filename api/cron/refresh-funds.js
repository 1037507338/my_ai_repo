// Vercel Cron Job: 每30秒刷新基金缓存
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://ypqxjtkiazawlmakvjnc.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwcXhqdGtpYXphd2xtYWt2am5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzE3NjQsImV4cCI6MjA5NTAwNzc2NH0.vbQU_khbbvoX0XKqOpFF3Ce7CXdBuyZ-HvIqjJ71tko';
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_USER_ID = 'default';
const CACHE_TTL = 120000;

// 内存缓存（与 funds.js 共享）
const fundDataCache = {};

async function fetchFundDataFromAPI(fundCode) {
  try {
    const cached = fundDataCache[fundCode];
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log(`Cron: 从缓存读取 ${fundCode}`);
      return cached.data;
    }

    console.log(`Cron: 从API获取 ${fundCode}`);
    const url = `http://fundgz.1234567.com.cn/js/${fundCode}.js`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    if (!response.ok) throw new Error(`API ${response.status}`);
    
    const text = await response.text();
    const match = text.match(/jsonpgz\((.*)\)/s);
    if (!match) throw new Error('Invalid response');
    
    const data = JSON.parse(match[1]);
    const result = {
      code: data.fundcode,
      name: data.name,
      nav: parseFloat(data.dwjz),
      estimatedNav: data.gsz ? parseFloat(data.gsz) : null,
      growth: data.gszzl ? parseFloat(data.gszzl) : 0,
      time: data.gztime
    };
    
    fundDataCache[fundCode] = { data: result, timestamp: Date.now() };
    return result;
  } catch (error) {
    console.error(`Cron: 获取失败 ${fundCode}:`, error.message);
    return fundDataCache[fundCode]?.data || null;
  }
}

module.exports = async (req, res) => {
  console.log('Cron Job: 刷新基金缓存...');
  
  try {
    const { data, error } = await supabase
      .from('funds')
      .select('fund_codes')
      .eq('user_id', DEFAULT_USER_ID)
      .single();
    
    if (error || !data) {
      return res.status(200).json({ message: 'No funds to refresh' });
    }
    
    const fundCodes = data.fund_codes || [];
    if (fundCodes.length === 0) {
      return res.status(200).json({ message: 'Empty fund list' });
    }
    
    console.log(`Cron: 刷新 ${fundCodes.length} 只基金...`);
    const results = await Promise.all(
      fundCodes.map(code => fetchFundDataFromAPI(code))
    );
    
    const success = results.filter(r => r !== null).length;
    console.log(`Cron: 成功 ${success}/${fundCodes.length}`);
    
    return res.status(200).json({
      message: 'Cache refreshed',
      total: fundCodes.length,
      success
    });
  } catch (error) {
    console.error('Cron Job失败:', error);
    return res.status(500).json({ error: error.message });
  }
};
