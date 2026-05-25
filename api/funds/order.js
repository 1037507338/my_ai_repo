import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_USER_ID = 'default';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ code: 405, error: 'Method not allowed' });
    
    try {
        const fundList = req.body;
        if (!Array.isArray(fundList)) {
            return res.status(400).json({ code: 400, error: 'Body must be an array' });
        }
        
        console.log('保存基金顺序：', fundList);
        
        // 直接更新 fund_codes 字段（顺序即保存在数组中）
        const { error } = await supabase
            .from('funds')
            .update({ fund_codes: fundList })
            .eq('user_id', DEFAULT_USER_ID);
        
        if (error) throw error;
        
        console.log('顺序保存成功');
        return res.status(200).json({ code: 0, message: 'Order saved', data: fundList });
    } catch (error) {
        console.error('保存顺序失败：', error);
        return res.status(500).json({ code: 500, error: error.message });
    }
}
