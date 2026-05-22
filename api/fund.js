module.exports = async (req, res) => {
  // 允许CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  // 处理OPTIONS预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // 只接受GET请求
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({ error: 'Missing fund code parameter' });
  }
  
  try {
    // 调用天天基金API
    const url = `http://fundgz.1234567.com.cn/js/${code}.js`;
    
    const response = await fetch(url);
    
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
    
    // 返回JSON数据
    return res.status(200).json({
      code: 0,
      data: {
        fundcode: data.fundcode,
        name: data.name,
        dwjz: data.dwjz,
        gsz: data.gsz,
        gszzl: data.gszzl,
        gztime: data.gztime
      }
    });
    
  } catch (error) {
    console.error('Fund API error:', error);
    return res.status(500).json({
      code: -1,
      error: error.message
    });
  }
};
