const fs = require('fs');
const path = require('path');

// 数据存储文件
const DATA_FILE = path.join(process.cwd(), 'data', 'funds.json');

// 确保数据目录存在
function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // 如果文件不存在，创建空数组
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

// 读取基金列表
function loadFunds() {
  try {
    ensureDataDir();
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('读取基金列表失败：', error);
    return [];
  }
}

// 保存基金列表
function saveFunds(funds) {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(funds, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('保存基金列表失败：', error);
    return false;
  }
}

module.exports = (req, res) => {
  // 允许CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // 处理OPTIONS预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    if (req.method === 'GET') {
      // 读取基金列表
      const funds = loadFunds();
      return res.status(200).json({
        code: 0,
        data: funds,
        message: '读取成功'
      });
    } else if (req.method === 'POST') {
      // 保存基金列表
      const funds = req.body;
      
      if (!Array.isArray(funds)) {
        return res.status(400).json({
          code: -1,
          error: 'Invalid data format, expected array'
        });
      }
      
      const success = saveFunds(funds);
      
      if (success) {
        return res.status(200).json({
          code: 0,
          message: '保存成功'
        });
      } else {
        return res.status(500).json({
          code: -1,
          error: '保存失败'
        });
      }
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
