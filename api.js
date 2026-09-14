// api.js — ชั้นเชื่อมต่อ backend (Google Apps Script Web App)
// เอา URL มาจาก Apps Script > Deploy > New deployment > Web app
// ตั้งค่า Execute as: Me, Who has access: Anyone
const API_URL = 'https://script.google.com/macros/s/AKfycbx3RytkK159eAGBtLlHam7eUiittvqT0u77yXVvJ9VYwhnNAP-c7c1xZkIkhDe0B_qR/exec';

const API = (() => {
    const useGas = typeof google !== 'undefined' && google.script && google.script.run;

    function viaGas(action, args) {
        return new Promise((resolve, reject) => {
            google.script.run
                .withSuccessHandler(resolve)
                .withFailureHandler(reject)[action](...args);
        });
    }

    async function fetchOnce(action, args, timeoutMs) {
        // เน็ตร้านหลุดกลางคัน fetch จะค้างไม่จบ ปุ่มที่สั่ง disabled ไว้ก่อนยิงจะกดไม่ได้อีกเลย
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);

        let res;
        try {
            // text/plain เพื่อให้เป็น simple request — Apps Script ไม่ตอบ preflight OPTIONS
            res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: action, args: args }),
                signal: ctrl.signal
            });
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('เซิร์ฟเวอร์ไม่ตอบกลับภายในเวลาที่กำหนด');
            throw err;
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`Server ตอบกลับ ${res.status}`);

        // Apps Script ตอบเป็นหน้า HTML (ไม่ใช่ JSON) เมื่อ deployment ถูกลบ หมดอายุ
        // หรือยังไม่ได้ตั้ง Who has access: Anyone — บอกให้ชัดแทน error ของ JSON parser
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error('เรียก API ไม่ได้ — ตรวจว่า deployment ยังอยู่ และตั้ง Who has access เป็น Anyone แล้ว deploy ใหม่');
        }
        if (data.error) throw new Error(data.error);
        return data.result;
    }

    // Apps Script หลุดเป็นครั้งคราว (เน็ตสะดุด / โควตาชน) ลองซ้ำสองครั้งก่อนยอมแพ้
    // แต่เฉพาะคำสั่งอ่านเท่านั้น คำสั่งเขียนถ้าลองซ้ำอาจได้บิลหรือเมนูซ้ำ
    const RETRYABLE = { getMenu: 1, getAllMenuForAdmin: 1, getOrdersByDate: 1 };

    // เฉพาะคำสั่งที่อาจแนบรูปมาด้วยเท่านั้นที่ต้องรอนาน คำสั่งเขียนอื่นจบในไม่กี่วินาที
    // ถ้าให้รอ 60 วิเท่ากันหมด ปุ่มจะค้างอยู่นานเกินไปเวลาการตอบกลับหลุด
    const SLOW_WRITE = { addMenuItem: 1, updateMenuItem: 1 };

    const TIMEOUT_READ = 20000;
    const TIMEOUT_WRITE = 25000;
    const TIMEOUT_UPLOAD = 60000;

    // ล็อกอินเป็นจังหวะเดียวที่ผู้ใช้นั่งจ้องหน้าจอรอโดยทำอย่างอื่นไม่ได้
    // ลองซ้ำสามรอบรอบละ 20 วิ จะกลายเป็นรอเงียบ ๆ เกือบนาที ยอมแพ้เร็วแล้วให้กดใหม่เองดีกว่า
    const TIMEOUT_LOGIN = 12000;

    async function viaFetch(action, args) {
        const retryable = !!RETRYABLE[action];
        const tries = retryable ? 3 : 1;
        const timeoutMs = action === 'checkLogin' ? TIMEOUT_LOGIN
            : retryable ? TIMEOUT_READ
                : SLOW_WRITE[action] ? TIMEOUT_UPLOAD
                    : TIMEOUT_WRITE;
        let lastErr;
        for (let i = 0; i < tries; i++) {
            try {
                return await fetchOnce(action, args, timeoutMs);
            } catch (err) {
                lastErr = err;
                if (i < tries - 1) await new Promise(r => setTimeout(r, 700 * (i + 1)));
            }
        }
        throw lastErr;
    }

    const call = (action, ...args) => useGas ? viaGas(action, args) : viaFetch(action, args);

    return {
        isReady: () => useGas || /^https:\/\//.test(API_URL),
        mode: () => useGas ? 'google.script.run' : 'fetch: ' + API_URL,

        checkLogin: (username, password) => call('checkLogin', username, password),
        getMenu: () => call('getMenu'),
        getAllMenuForAdmin: () => call('getAllMenuForAdmin'),
        addMenuItem: (item) => call('addMenuItem', item),
        updateMenuItem: (item) => call('updateMenuItem', item),
        deleteMenuItem: (id) => call('deleteMenuItem', id),
        submitOrder: (order) => call('submitOrder', order),
        getOrdersByDate: (date) => call('getOrdersByDate', date)
    };
})();
