// Vercel Cron Job: 刷新基金缓存（使用东方财富历史净值接口）
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

    // 东方财富历史净值接口（实时接口已下线）
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=1`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://fund.eastmoney.com'
      }
    });

    if (!response.ok) throw new Error(`API ${response.status}`);

    const json = await response.json();
    const data = json.Data;

    if (!data || !data.LSJZList || data.LSJZList.length === 0) {
      throw new Error('No data');
    }

    const fund = data.LSJZList[0];
    const result = {
      code: fundCode,
      name: '',
      nav: parseFloat(fund.DWJZ),
      growth: parseFloat(fund.JZZZL),
      navDate: fund.FSRQ,
      time: fund.FSRQ,
      source: 'eastmoney_hist'
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
