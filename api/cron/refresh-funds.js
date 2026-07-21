// Vercel Cron Job: 刷新基金缓存
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_USER_ID = 1;
const CACHE_TTL = 120000;
const NAME_CACHE_TTL = 24 * 3600 * 1000;

const fundDataCache = {};
const fundNameCache = {};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchSinaEstimate(fundCode) {
  const cb = `jsonp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=${fundCode}&callback=${cb}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn' } });
  if (!resp.ok) throw new Error(`sina ${resp.status}`);
  const text = await resp.text();
  const match = text.match(new RegExp(`${cb}\\((.*)\\)\\s*;?\\s*$`, 's'));
  if (!match) throw new Error('sina jsonp parse fail');
  const json = JSON.parse(match[1]);
  const networth = json?.result?.data?.networth;
  if (!Array.isArray(networth) || networth.length === 0) throw new Error('sina empty networth');
  const last = networth[networth.length - 1];
  const gsz = parseFloat(last.pre_nav);
  const rate = parseFloat(last.growthrate);
  const time = last.min_time && last.pre_date ? `${last.pre_date} ${last.min_time}` : null;
  return {
    estimatedNav: Number.isFinite(gsz) ? gsz : null,
    growth: Number.isFinite(rate) ? rate * 100 : null,
    time
  };
}

async function fetchEastmoneyNav(fundCode) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=1`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://fundf10.eastmoney.com/' } });
  if (!resp.ok) throw new Error(`eastmoney lsjz ${resp.status}`);
  const json = await resp.json();
  const list = json?.Data?.LSJZList;
  if (!Array.isArray(list) || list.length === 0) throw new Error('lsjz empty');
  const row = list[0];
  const nav = parseFloat(row.DWJZ);
  const growth = parseFloat(row.JZZZL);
  return {
    nav: Number.isFinite(nav) ? nav : null,
    navDate: row.FSRQ || null,
    histGrowth: Number.isFinite(growth) ? growth : null
  };
}

async function fetchFundName(fundCode) {
  const cached = fundNameCache[fundCode];
  if (cached && (Date.now() - cached.timestamp) < NAME_CACHE_TTL) return cached.name;
  try {
    const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBaseInfo?FCODE=${fundCode}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=vercel${Date.now()}`;
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error('baseinfo fail');
    const json = await resp.json();
    const name = json?.Datas?.SHORTNAME || json?.Datas?.NAME || '';
    if (name) fundNameCache[fundCode] = { name, timestamp: Date.now() };
    return name;
  } catch (e) {
    return '';
  }
}

async function fetchFundDataFromAPI(fundCode) {
  try {
    const cached = fundDataCache[fundCode];
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.data;

    const [emRes, sinaRes, nameRes] = await Promise.allSettled([
      fetchEastmoneyNav(fundCode),
      fetchSinaEstimate(fundCode),
      fetchFundName(fundCode)
    ]);

    const em = emRes.status === 'fulfilled' ? emRes.value : null;
    const sina = sinaRes.status === 'fulfilled' ? sinaRes.value : null;
    const name = nameRes.status === 'fulfilled' ? nameRes.value : '';

    if (!em && !sina) throw new Error('all sources failed');

    const growth = sina?.growth ?? em?.histGrowth ?? 0;
    const time = sina?.time || em?.navDate || '';

    const result = {
      code: fundCode,
      name: name || `基金${fundCode}`,
      nav: em?.nav ?? null,
      estimatedNav: sina?.estimatedNav ?? null,
      growth,
      time
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
