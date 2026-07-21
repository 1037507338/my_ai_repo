// Vercel Cron Job: 刷新基金缓存
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_USER_ID = 1;
const CACHE_TTL = 120000;

const fundDataCache = {};

async function fetchFundDataFromAPI(fundCode) {
  try {
    const cached = fundDataCache[fundCode];
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.data;
    }

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
    // 新表结构：每行一只基金，查询 fund_code 列
    const { data, error } = await supabase
      .from('funds')
      .select('fund_code')
      .eq('user_id', DEFAULT_USER_ID);
    
    if (error || !data || data.length === 0) {
      return res.status(200).json({ message: 'No funds to refresh' });
    }
    
    const fundCodes = data.map(d => d.fund_code);
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
