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
        
        // 简化逻辑：直接删除所有行，然后插入新顺序
        // 1. 删除所有现有基金（不使用 .neq）
        const { error: deleteError } = await supabase
            .from('funds')
            .delete()
            .gte('id', 0);  // 删除所有行（id >= 0）
        
        if (deleteError) {
            console.error('删除失败：', deleteError);
            throw deleteError;
        }
        
        console.log('删除成功，准备插入新顺序');
        
        // 2. 按新顺序插入基金
        const fundsToInsert = fundList.map(code => ({ code }));
        console.log('准备插入：', fundsToInsert);
        
        const { data: insertData, error: insertError } = await supabase
            .from('funds')
            .insert(fundsToInsert)
            .select();
        
        if (insertError) {
            console.error('插入失败：', insertError);
            throw insertError;
        }
        
        console.log('顺序保存成功：', insertData);
        
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
