const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_USER_ID = 1;

const fundDataCache = {};
const fundNameCache = {};
const CACHE_TTL = 120000;
const NAME_CACHE_TTL = 24 * 3600 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// 新浪估值：当天估算净值 + 涨跌幅 + 估值时间
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

// 东方财富历史净值：单位净值（最新一条）
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

async function fetchNameFromMobApi(fundCode) {
  const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBaseInfo?FCODE=${fundCode}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=vercel${Date.now()}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`mobapi ${resp.status}`);
  const json = await resp.json();
  return json?.Datas?.SHORTNAME || json?.Datas?.FULLNAME || json?.Datas?.NAME || '';
}

async function fetchNameFromSuggest(fundCode) {
  const cb = `cb_${Date.now()}`;
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${fundCode}&callback=${cb}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://fund.eastmoney.com/' } });
  if (!resp.ok) throw new Error(`suggest ${resp.status}`);
  const text = await resp.text();
  const match = text.match(new RegExp(`${cb}\\((.*)\\)\\s*;?\\s*$`, 's'));
  if (!match) throw new Error('suggest jsonp parse fail');
  const json = JSON.parse(match[1]);
  const arr = json?.Datas;
  if (!Array.isArray(arr)) return '';
  const hit = arr.find(d => d.CODE === fundCode) || arr[0];
  return hit?.NAME || hit?.FundBaseInfo?.SHORTNAME || '';
}

async function fetchFundName(fundCode) {
  const cached = fundNameCache[fundCode];
  if (cached && (Date.now() - cached.timestamp) < NAME_CACHE_TTL) return cached.name;

  const tries = [fetchNameFromMobApi, fetchNameFromSuggest];
  for (const fn of tries) {
    try {
      const name = await fn(fundCode);
      if (name) {
        fundNameCache[fundCode] = { name, timestamp: Date.now() };
        return name;
      }
    } catch (e) {
      console.error(`获取基金名失败(${fn.name}): ${fundCode}`, e.message);
    }
  }
  return '';
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

    // 无新浪估值时，用东财历史涨跌幅作为兜底
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
    console.error(`获取基金数据失败: ${fundCode}`, error.message);
    if (fundDataCache[fundCode]) return fundDataCache[fundCode].data;
    return null;
  }
}

async function getFundList() {
  const { data, error } = await supabase
    .from('funds')
    .select('fund_code, sort_order')
    .eq('user_id', DEFAULT_USER_ID)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return (data || []).map(f => f.fund_code);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { force, code, clear, fundCode } = req.query;

    if (req.method === 'GET' && code) {
      const fundData = await fetchFundDataFromAPI(code);
      if (!fundData) return res.status(500).json({ code: -1, error: '获取失败' });
      return res.status(200).json({ code: 0, data: fundData });
    }

    if (req.method === 'GET') {
      const fundCodes = await getFundList();

      if (fundCodes.length === 0) {
        return res.status(200).json({ code: 0, data: [] });
      }

      const cachedData = [];
      const uncachedCodes = [];

      fundCodes.forEach(c => {
        if (fundDataCache[c] && (Date.now() - fundDataCache[c].timestamp) < CACHE_TTL) {
          cachedData.push(fundDataCache[c].data);
        } else {
          uncachedCodes.push(c);
        }
      });

      if (force === 'true' || uncachedCodes.length > 0) {
        const codesToFetch = force === 'true' ? fundCodes : uncachedCodes;
        console.log(`从API获取 ${codesToFetch.length} 只基金...`);

        const fundDataList = await Promise.all(
          codesToFetch.map(c => fetchFundDataFromAPI(c))
        );
        const validData = fundDataList.filter(d => d !== null);

        if (force === 'true') {
          return res.status(200).json({ code: 0, data: validData, message: '强制刷新' });
        }

        const allData = [...cachedData, ...validData];
        return res.status(200).json({ code: 0, data: allData });
      }

      return res.status(200).json({ code: 0, data: cachedData, message: '缓存' });
    }

    if (req.method === 'POST') {
      const { action, fundCode: bodyFundCode } = req.body;
      const fc = bodyFundCode || fundCode;

      if (action === 'add' && fc) {
        const fundList = await getFundList();

        if (fundList.includes(fc)) {
          return res.status(200).json({ code: 0, message: '已存在' });
        }

        const { error } = await supabase
          .from('funds')
          .insert([{ user_id: DEFAULT_USER_ID, fund_code: fc, sort_order: fundList.length }]);

        if (error) throw error;
        return res.status(200).json({ code: 0, message: '添加成功' });
      }

      return res.status(400).json({ code: -1, error: '参数错误' });
    }

    if (req.method === 'DELETE') {
      const fc = fundCode || (req.query || {}).fundCode;

      if (clear === 'all') {
        const { error } = await supabase
          .from('funds')
          .delete()
          .eq('user_id', DEFAULT_USER_ID);

        if (error) throw error;
        return res.status(200).json({ code: 0, message: '清空成功' });
      }

      if (!fc) return res.status(400).json({ code: -1, error: '缺少fundCode' });

      const { error } = await supabase
        .from('funds')
        .delete()
        .eq('user_id', DEFAULT_USER_ID)
        .eq('fund_code', fc);

      if (error) throw error;
      return res.status(200).json({ code: 0, message: '删除成功' });
    }

    return res.status(405).json({ code: -1, error: 'Method not allowed' });

  } catch (error) {
    console.error('Funds API error:', error);
    return res.status(500).json({ code: -1, error: error.message });
  }
};
