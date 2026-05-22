const { createClient } = require('@supabase/supabase-js');

// 初始化Supabase客户端
const supabaseUrl = process.env.SUPABASE_URL || 'https://ypqxjtkiazawlmakvjnc.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwcXhqdGtpYXphd2xtYWt2am5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzE3NjQsImV4cCI6MjA5NTAwNzc2NH0.vbQU_khbbvoX0XKqOpFF3Ce7CXdBuyZ-HvIqjJ71tko';
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_USER_ID = 'default';

// 内存缓存
const fundDataCache = {};
const CACHE_TTL = 120000; // 缓存2分钟

// 从天天基金API获取基金数据（带缓存）
async function fetchFundDataFromAPI(fundCode) {
  try {
    // 检查缓存
    const cached = fundDataCache[fundCode];
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log(`从缓存读取: ${fundCode}`);
      return cached.data;
    }

    console.log(`从API获取: ${fundCode}`);
    
    const url = `http://fundgz.1234567.com.cn/js/${fundCode}.js`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }
    
    const text = await response.text();
    
    // 解析JSONP响应：jsonpgz({...})
    const match = text.match(/jsonpgz\((.*)\)/s);
    
    if (!match) {
      throw new Error('Invalid API response format');
    }
    
    const data = JSON.parse(match[1]);
    
    const result = {
      code: data.fundcode,
      name: data.name,
      nav: parseFloat(data.dwjz),
      estimatedNav: data.gsz ? parseFloat(data.gsz) : null,
      growth: data.gszzl ? parseFloat(data.gszzl) : 0,
      time: data.gztime
    };
    
    // 更新缓存
    fundDataCache[fundCode] = {
      data: result,
      timestamp: Date.now()
    };
    
    return result;
  } catch (error) {
    console.error(`获取基金数据失败: ${fundCode}`, error);
    
    // 如果有缓存，即使过期也返回
    if (fundDataCache[fundCode]) {
      console.log(`使用过期缓存: ${fundCode}`);
      return fundDataCache[fundCode].data;
    }
    
    return null;
  }
}

module.exports = async (req, res) => {
  // 允许CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // 处理OPTIONS预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { force, code } = req.query;
    
    // GET /api/funds?code=xxx → 获取单只基金数据
    if (req.method === 'GET' && code) {
      const fundData = await fetchFundDataFromAPI(code);
      
      if (!fundData) {
        return res.status(500).json({
          code: -1,
          error: '获取基金数据失败'
        });
      }
      
      return res.status(200).json({
        code: 0,
        data: fundData,
        message: '获取成功'
      });
    }
    
    // GET /api/funds → 获取基金代码列表（带数据）
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('funds')
        .select('fund_codes')
        .eq('user_id', DEFAULT_USER_ID)
        .single();
      
      if (error) {
        // 如果记录不存在，创建新记录
        if (error.code === 'PGRST116') {
          const { data: newData, error: insertError } = await supabase
            .from('funds')
            .insert([{ user_id: DEFAULT_USER_ID, fund_codes: [] }])
            .select('fund_codes')
            .single();
          
          if (insertError) {
            throw insertError;
          }
          
          return res.status(200).json({
            code: 0,
            data: [],
            message: '读取成功（新创建）'
          });
        }
        
        throw error;
      }
      
      const fundCodes = data.fund_codes || [];
      
      // 正常查询：从缓存读取
      if (fundCodes.length > 0) {
        console.log(`读取 ${fundCodes.length} 只基金数据（优先缓存）...`);
        
        // 优先从缓存读取
        const cachedData = [];
        const uncachedCodes = [];
        
        fundCodes.forEach(code => {
          if (fundDataCache[code] && (Date.now() - fundDataCache[code].timestamp) < CACHE_TTL) {
            cachedData.push(fundDataCache[code].data);
          } else {
            uncachedCodes.push(code);
          }
        });
        
        // 如果强制刷新或部分缓存缺失，从API获取
        if (force === 'true' || uncachedCodes.length > 0) {
          const codesToFetch = force === 'true' ? fundCodes : uncachedCodes;
          console.log(`从API获取 ${codesToFetch.length} 只基金...`);
          
          // 并行获取
          const fundDataList = await Promise.all(
            codesToFetch.map(code => fetchFundDataFromAPI(code))
          );
          
          // 过滤失败请求
          const validData = fundDataList.filter(d => d !== null);
          
          // 更新缓存
          validData.forEach(d => {
            fundDataCache[d.code] = {
              data: d,
              timestamp: Date.now()
            };
          });
          
          // 如果强制刷新，返回API数据
          if (force === 'true') {
            return res.status(200).json({
              code: 0,
              data: validData,
              message: '读取成功（强制刷新）'
            });
          }
          
          // 否则合并缓存和新数据
          const allData = [...cachedData, ...validData];
          
          return res.status(200).json({
            code: 0,
            data: allData,
            message: '读取成功'
          });
        }
        
        // 全部命中缓存
        return res.status(200).json({
          code: 0,
          data: cachedData,
          message: '读取成功（缓存）'
        });
      }
      
      return res.status(200).json({
        code: 0,
        data: fundCodes,
        message: '读取成功'
      });
      
    } else if (req.method === 'POST') {
      // POST /api/funds → 保存基金代码列表
      const fundCodes = req.body;
      
      if (!Array.isArray(fundCodes)) {
        return res.status(400).json({
          code: -1,
          error: 'Invalid data format, expected array'
        });
      }
      
      // 更新基金列表
      const { error } = await supabase
        .from('funds')
        .update({ fund_codes: fundCodes })
        .eq('user_id', DEFAULT_USER_ID);
      
      if (error) {
        throw error;
      }
      
      return res.status(200).json({
        code: 0,
        message: '保存成功'
      });
      
    } else {
      return res.status(405).json({
        code: -1,
        error: 'Method not allowed'
      });
    }
    
  } catch (error) {
    console.error('Funds API error:', error);
    return res.status(500).json({
      code: -1,
      error: error.message
    });
  }
};