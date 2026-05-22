const { createClient } = require('@supabase/supabase-js');

// 初始化Supabase客户端
const supabaseUrl = process.env.SUPABASE_URL || 'https://ypqxjtkiazawlmakvjnc.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwcXhqdGtpYXphd2xtYWt2am5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzE3NjQsImV4cCI6MjA5NTAwNzc2NH0.vbQU_khbbvoX0XKqOpFF3Ce7CXdBuyZ-HvIqjJ71tko';
const supabase = createClient(supabaseUrl, supabaseKey);

// 默认用户ID
const DEFAULT_USER_ID = 'default';

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
    if (req.method === 'GET') {
      // 读取基金列表
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
            data: newData.fund_codes,
            message: '读取成功（新创建）'
          });
        }
        
        throw error;
      }
      
      return res.status(200).json({
        code: 0,
        data: data.fund_codes,
        message: '读取成功'
      });
      
    } else if (req.method === 'POST') {
      // 保存基金列表
      const fundCodes = req.body;
      
      if (!Array.isArray(fundCodes)) {
        return res.status(400).json({
          code: -1,
          error: 'Invalid data format, expected array'
        });
      }
      
      // 更新基金列表
      const { data, error } = await supabase
        .from('funds')
        .update({ fund_codes: fundCodes })
        .eq('user_id', DEFAULT_USER_ID)
        .select();
      
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
