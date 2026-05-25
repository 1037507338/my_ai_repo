import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ code: 405, error: 'Method not allowed' });
    }
    
    try {
        const fundList = req.body;
        
        if (!Array.isArray(fundList)) {
            return res.status(400).json({ code: 400, error: 'Invalid request: body must be an array' });
        }
        
        console.log('保存基金顺序：', fundList);
        
        // 1. 获取现有基金
        const { data: existingFunds, error: fetchError } = await supabase
            .from('funds')
            .select('*');
        
        if (fetchError) throw fetchError;
        
        // 2. 删除所有现有基金
        const { error: deleteError } = await supabase
            .from('funds')
            .delete()
            .neq('id', 0);  // 删除所有行
        
        if (deleteError) throw deleteError;
        
        // 3. 按新顺序插入基金
        const fundsToInsert = fundList.map(code => ({ code }));
        const { error: insertError } = await supabase
            .from('funds')
            .insert(fundsToInsert);
        
        if (insertError) throw insertError;
        
        console.log('顺序保存成功：', fundList);
        
        return res.status(200).json({
            code: 0,
            message: 'Order saved successfully',
            data: fundList
        });
        
    } catch (error) {
        console.error('保存顺序失败：', error);
        return res.status(500).json({ code: 500, error: error.message });
    }
}
