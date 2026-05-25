const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://ypqxjtkiazawlmakvjnc.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwcXhqdGtpYXphd2xtYWt2am5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzE3NjQsImV4cCI6MjA5NTAwNzc2NH0.vbQU_khbbvoX0XKqOpFF3Ce7CXdBuyZ-HvIqjJ71tko';
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_USER_ID = 1; // 默认用户id

// 内存缓存
const fundDataCache = {};
const CACHE_TTL = 120000; // 2分钟

// 从天天基金API获取数据（带缓存）
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
    
    if (!response.ok) throw new Error(`API failed: ${response.status}`);
    
    const text = await response.text();
    const match = text.match(/jsonpgz\((.*)\)/s);
    if (!match) throw new Error('Invalid API response');
    
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
    console.error(`获取基金数据失败: ${fundCode}`, error);
    if (fundDataCache[fundCode]) return fundDataCache[fundCode].data;
    return null;
  }
}

// 获取基金列表（按sort_order排序）
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
    const { force, code } = req.query;
    
    // GET /api/funds?code=xxx → 单只基金数据
    if (req.method === 'GET' && code) {
      const fundData = await fetchFundDataFromAPI(code);
      if (!fundData) return res.status(500).json({ code: -1, error: '获取失败' });
      return res.status(200).json({ code: 0, data: fundData });
    }
    
    // GET /api/funds → 获取基金列表+数据
    if (req.method === 'GET') {
      const fundCodes = await getFundList();
      
      if (fundCodes.length === 0) {
        return res.status(200).json({ code: 0, data: [] });
      }
      
      // 分缓存命中和未命中
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
    
    // POST /api/funds → 添加基金
    if (req.method === 'POST') {
      const { action, fundCode } = req.body;
      
      // 添加基金
      if (action === 'add' && fundCode) {
        // 获取当前最大sort_order
        const fundList = await getFundList();
        
        // 检查是否已存在
        if (fundList.includes(fundCode)) {
          return res.status(200).json({ code: 0, message: '已存在' });
        }
        
        const { error } = await supabase
          .from('funds')
          .insert([{ user_id: DEFAULT_USER_ID, fund_code: fundCode, sort_order: fundList.length }]);
        
        if (error) throw error;
        return res.status(200).json({ code: 0, message: '添加成功' });
      }
      
      return res.status(400).json({ code: -1, error: '参数错误' });
    }
    
    // DELETE /api/funds → 删除基金
    if (req.method === 'DELETE') {
      const { fundCode, clear } = req.query;
      
      // 清空所有
      if (clear === 'all') {
        const { error } = await supabase
          .from('funds')
          .delete()
          .eq('user_id', DEFAULT_USER_ID);
        
        if (error) throw error;
        return res.status(200).json({ code: 0, message: '清空成功' });
      }
      
      // 删除单只
      if (!fundCode) return res.status(400).json({ code: -1, error: '缺少fundCode' });
      
      const { error } = await supabase
        .from('funds')
        .delete()
        .eq('user_id', DEFAULT_USER_ID)
        .eq('fund_code', fundCode);
      
      if (error) throw error;
      return res.status(200).json({ code: 0, message: '删除成功' });
    }
    
    return res.status(405).json({ code: -1, error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Funds API error:', error);
    return res.status(500).json({ code: -1, error: error.message });
  }
};
