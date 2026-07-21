const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_USER_ID = 1;

// 内存缓存（实时1分钟，历史2分钟）
const fundDataCache = {};
const CACHE_TTL_REAL = 60 * 1000;   // 实时数据 1 分钟
const CACHE_TTL_HIST = 120 * 1000;  // 历史数据 2 分钟

// 基金名称缓存（长期有效）
const fundNameCache = {};

// 获取基金名称（3层兜底）
async function fetchFundName(fundCode) {
  if (fundNameCache[fundCode]) return fundNameCache[fundCode];

  const fetchWithTimeout = (url, opts, ms = 5000) =>
    Promise.race([
      fetch(url, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]).catch(() => null);

  // 方式1：东方财富 F10 基金概况接口
  try {
    const r = await fetchWithTimeout(
      `https://fundgz.1234567.com.cn/f10/${fundCode}.js?rt=${Date.now()}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (r && r.ok) {
      const t = await r.text();
      const m = t.match(/[,"]name:"([^"]+)"/);
      if (m && m[1]) { fundNameCache[fundCode] = m[1]; return m[1]; }
    }
  } catch (_) {}

  // 方式2：东方财富搜索建议接口
  try {
    const r = await fetchWithTimeout(
      `https://suggest3.eastmoney.com/search?words=${fundCode}&type=fs&t=${Date.now()}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' } }
    );
    if (r && r.ok) {
      const j = await r.json();
      const found = j?.Query?.Result?.find(x => (x.CODE || x.FCODE) === fundCode);
      if (found && (found.SHORTNAME || found.NAME)) {
        fundNameCache[fundCode] = found.SHORTNAME || found.NAME;
        return fundNameCache[fundCode];
      }
    }
  } catch (_) {}

  // 方式3：pingzhongdata 基金概况
  try {
    const r = await fetchWithTimeout(
      `https://fund.eastmoney.com/pingzhongdata/${fundCode}.js?v=${Date.now()}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (r && r.ok) {
      const t = await r.text();
      const m = t.match(/fS_name\s*=\s*["']([^"']+)["']/);
      if (m && m[1]) { fundNameCache[fundCode] = m[1]; return m[1]; }
    }
  } catch (_) {}

  fundNameCache[fundCode] = '';
  return '';
}

// 判断当前是否在交易时间内（工作日 9:30-15:00）
function isTradingTime() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 15 * 60;
}

// 从新浪财经接口获取实时估算净值（盘中）
// 返回格式: var hq_str_f_003567="name,pre_nav,nav,pct,date,unknown";
async function fetchSinaEstimate(fundCode) {
  const url = `https://hq.sinajs.cn/rn=${Date.now()}&list=f_${fundCode}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://finance.sina.com.cn/'
    }
  });
  if (!resp.ok) throw new Error(`Sina HTTP ${resp.status}`);

  const text = await resp.text();
  const m = text.match(/="([^"]+)"/);
  if (!m) throw new Error('No data');

  const parts = m[1].split(',');
  if (!parts || parts.length < 6) throw new Error('Invalid data');

  // parts[0] = name（GBK乱码，跳过，名称从别处获取）
  // parts[1] = pre_nav（昨日单位净值）
  // parts[2] = nav（估算净值，部分基金盘中可能与昨日相同）
  // parts[3] = pct（估算涨跌幅%，已是百分比形式如 1.485）
  // parts[4] = date（净值估算日期）
  // parts[5] = unknown

  const preNav      = parseFloat(parts[1]);
  const estimateNav = parseFloat(parts[2]);
  const navPct      = parseFloat(parts[3]);  // 已是%，如 1.485 = +1.485%
  const updateTime  = parts[4] || null;      // 如 "2026-07-20"

  return {
    preNav,
    estimateNav,
    estimateGrowth: isNaN(navPct) ? null : navPct,
    updateTime,
    source: 'sina_realtime'
  };
}

// 从东方财富历史净值接口获取上一交易日净值
async function fetchEastMoneyHistory(fundCode) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=1&appType=android&client=android`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com' }
  });
  if (!resp.ok) throw new Error(`EM HTTP ${resp.status}`);
  const json = await resp.json();
  const data = json.Data;
  if (!data || !data.LSJZList || data.LSJZList.length === 0) throw new Error('No hist data');
  const fund = data.LSJZList[0];
  return {
    nav:     parseFloat(fund.DWJZ),
    prevNav: null,
    growth:  parseFloat(fund.JZZZL),
    navDate: fund.FSRQ,
    time:    fund.FSRQ,
    source:  'eastmoney_hist'
  };
}

// 主获取函数：盘中优先实时估算，降级到历史净值
async function fetchFundDataFromAPI(fundCode) {
  const now = Date.now();

  // 缓存命中判断
  if (fundDataCache[fundCode]) {
    const entry = fundDataCache[fundCode];
    const ttl = entry.data.source === 'sina_realtime' ? CACHE_TTL_REAL : CACHE_TTL_HIST;
    if ((now - entry.timestamp) < ttl) return entry.data;
  }

  // 并行获取基金名称 + 判断是否尝试实时
  const namePromise  = fetchFundName(fundCode);
  const tryRealtime  = isTradingTime();

  const [nameResult, sinaResult] = await Promise.allSettled([
    namePromise,
    tryRealtime ? fetchSinaEstimate(fundCode).catch(() => null) : Promise.resolve(null)
  ]);

  const nameVal = nameResult.status === 'fulfilled' ? nameResult.value : '';
  let result = {
    code: fundCode,
    name: nameVal,
    nav: null,
    prevNav: null,
    growth: null,
    navDate: null,
    time: null,
    source: 'none'
  };

  // 有实时数据
  if (sinaResult.status === 'fulfilled' && sinaResult.value) {
    const s = sinaResult.value;
    if (s.estimateNav && !isNaN(s.estimateNav)) {
      result.nav      = s.estimateNav;
      result.prevNav  = s.preNav;
      result.growth   = s.estimateGrowth;
      result.navDate  = s.updateTime ? s.updateTime.substring(0, 10) : new Date().toISOString().substring(0, 10);
      result.time     = s.updateTime || new Date().toISOString().substring(0, 16);
      result.source   = 'sina_realtime';
    }
  }

  // 兜底：历史净值
  if (!result.nav) {
    try {
      const hist = await fetchEastMoneyHistory(fundCode);
      result.nav     = hist.nav;
      result.prevNav = hist.prevNav;
      result.growth  = hist.growth;
      result.navDate = hist.navDate;
      result.time    = hist.time;
      result.source  = 'eastmoney_hist';
    } catch (e) {
      console.error(`[funds] ${fundCode} hist failed:`, e.message);
    }
  }

  fundDataCache[fundCode] = { data: result, timestamp: now };
  return result;
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

    // GET /api/funds?code=xxx → 单只基金数据
    if (req.method === 'GET' && code) {
      const fundData = await fetchFundDataFromAPI(code);
      if (!fundData) return res.status(500).json({ code: -1, error: '获取失败' });
      return res.status(200).json({ code: 0, data: fundData });
    }

    // GET /api/funds → 获取基金列表+数据
    if (req.method === 'GET') {
      const fundCodes = await getFundList();
      if (fundCodes.length === 0) return res.status(200).json({ code: 0, data: [] });

      const cachedData = [];
      const uncachedCodes = [];
      fundCodes.forEach(c => {
        if (fundDataCache[c]) {
          const entry = fundDataCache[c];
          const ttl = entry.data.source === 'sina_realtime' ? CACHE_TTL_REAL : CACHE_TTL_HIST;
          if ((Date.now() - entry.timestamp) < ttl) {
            cachedData.push(entry.data);
            return;
          }
        }
        uncachedCodes.push(c);
      });

      if (force === 'true' || uncachedCodes.length > 0) {
        const codesToFetch = force === 'true' ? fundCodes : uncachedCodes;
        console.log(`[funds] 获取 ${codesToFetch.length} 只基金（${force === 'true' ? '强制刷新' : '增量'}）...`);
        const fundDataList = await Promise.all(codesToFetch.map(c => fetchFundDataFromAPI(c)));
        const validData = fundDataList.filter(d => d !== null);
        return res.status(200).json({
          code: 0,
          data: force === 'true' ? validData : [...cachedData, ...validData],
          message: force === 'true' ? '强制刷新' : undefined
        });
      }
      return res.status(200).json({ code: 0, data: cachedData });
    }

    // POST /api/funds → 添加基金
    if (req.method === 'POST') {
      const { action, fundCode: bodyFundCode } = req.body;
      const fc = bodyFundCode || fundCode;
      if (action === 'add' && fc) {
        const fundList = await getFundList();
        if (fundList.includes(fc)) return res.status(200).json({ code: 0, message: '已存在' });
        const { error } = await supabase
          .from('funds')
          .insert([{ user_id: DEFAULT_USER_ID, fund_code: fc, sort_order: fundList.length }]);
        if (error) throw error;
        return res.status(200).json({ code: 0, message: '添加成功' });
      }
      return res.status(400).json({ code: -1, error: '参数错误' });
    }

    // DELETE /api/funds → 删除基金
    if (req.method === 'DELETE') {
      const fc = fundCode || (req.query || {}).fundCode;
      if (clear === 'all') {
        const { error } = await supabase.from('funds').delete().eq('user_id', DEFAULT_USER_ID);
        if (error) throw error;
        return res.status(200).json({ code: 0, message: '清空成功' });
      }
      if (!fc) return res.status(400).json({ code: -1, error: '缺少fundCode' });
      const { error } = await supabase.from('funds').delete()
        .eq('user_id', DEFAULT_USER_ID).eq('fund_code', fc);
      if (error) throw error;
      return res.status(200).json({ code: 0, message: '删除成功' });
    }

    return res.status(405).json({ code: -1, error: 'Method not allowed' });

  } catch (error) {
    console.error('Funds API error:', error);
    return res.status(500).json({ code: -1, error: error.message });
  }
};
