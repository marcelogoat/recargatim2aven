(function () {

    // Microsoft Clarity
    (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "xbdwsygp4w");

    window.timNavigate = function (url) {
        window.location.href = url;
    };

    // Verifica se há pagamento pendente salvo (caso usuário fechou o browser)
    (function checkPendingPayment() {
        var raw = localStorage.getItem('tim_pending_tx');
        if (!raw) return;
        try {
            var tx = JSON.parse(raw);
            if (!tx || !tx.transaction_id) return;
            fetch('/api/check_status?id=' + encodeURIComponent(tx.transaction_id))
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.status === 'approved') {
                        localStorage.removeItem('tim_pending_tx');
                        // Restaura sessionStorage para a página de sucesso exibir os dados
                        sessionStorage.setItem('tim_transaction', JSON.stringify(tx));
                        var amt = tx.amount || 0;
                        var tid = tx.transaction_id || '';
                        window.location.href = '/pagamento/pos-pagamento.html?transaction_id=' + encodeURIComponent(tid) + '&amount=' + amt;
                    }
                })
                .catch(function() {});
        } catch(e) {}
    })();

    // Scroll-reveal
    function initReveal() {
        var els = Array.from(document.querySelectorAll('[style*="opacity: 0"]'));
        if (!('IntersectionObserver' in window)) {
            els.forEach(function (el) { el.style.opacity = '1'; el.style.transform = 'none'; });
            return;
        }
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var el = entry.target;
                el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
                el.style.opacity    = '1';
                el.style.transform  = 'none';
                io.unobserve(el);
            });
        }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });
        els.forEach(function (el) { io.observe(el); });
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', initReveal)
        : initReveal();

    // Menu mobile full-screen
    function initMobileMenu() {
        var btn = document.querySelector('button[aria-label="Menu"]');
        if (!btn) return;
        var nav = document.querySelector('nav.hidden.md\\:flex');
        if (!nav) return;

        var st = document.createElement('style');
        st.textContent = '#_mm-overlay{display:none}'
            + '#_mm{position:fixed;top:0;left:0;width:100%;z-index:99998;background:var(--primary,#1040a0);display:flex;flex-direction:column;transform:translateY(-100%);transition:transform .35s cubic-bezier(.4,0,.2,1);box-shadow:0 8px 32px rgba(0,0,0,0.3)}'
            + '#_mm.open{transform:translateY(0)}'
            + '#_mm-head{display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:48px;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.1)}'
            + '#_mm-logo{display:flex;align-items:center;gap:6px;font-weight:800;font-size:22px;color:#fff;text-decoration:none}'
            + '#_mm-close{background:rgba(255,255,255,0.12);border:2px solid rgba(255,255,255,0.3);color:#fff;width:36px;height:36px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1}'
            + '#_mm-links{overflow-y:auto}'
            + '#_mm-links a{display:block;padding:12px 20px;color:rgba(255,255,255,0.85);font-size:15px;font-weight:500;text-decoration:none;border-bottom:1px solid rgba(255,255,255,0.08)}'
            + '#_mm-links a:active{background:rgba(255,255,255,0.08);color:#fff}';
        document.head.appendChild(st);

        var overlay = document.createElement('div');
        overlay.id = '_mm-overlay';
        document.body.appendChild(overlay);

        var panel = document.createElement('div');
        panel.id = '_mm';

        // Header do menu
        var head = document.createElement('div');
        head.id = '_mm-head';
        head.innerHTML = '<a id="_mm-logo" href="/"><span style="color:#e53e3e;font-size:24px;">≡</span>TIM</a>';
        var closeBtn = document.createElement('button');
        closeBtn.id = '_mm-close';
        closeBtn.innerHTML = '&#x2715;';
        head.appendChild(closeBtn);
        panel.appendChild(head);

        // Links
        var linksDiv = document.createElement('div');
        linksDiv.id = '_mm-links';
        linksDiv.innerHTML = '<div class="section-container py-4 flex flex-col gap-2">'
            + '<a class="text-sm font-medium py-2 transition-colors text-primary-foreground border-b border-primary-foreground/10 pb-3" href="/">Início</a>'
            + '<a class="text-sm font-medium py-2 transition-colors text-primary-foreground/80 hover:text-primary-foreground border-b border-primary-foreground/10 pb-3" href="/recarga">Recarga</a>'
            + '<a class="text-sm font-medium py-2 transition-colors text-primary-foreground/80 hover:text-primary-foreground border-b border-primary-foreground/10 pb-3" href="/sobre">Sobre a TIM</a>'
            + '<a class="text-sm font-medium py-2 transition-colors text-primary-foreground/80 hover:text-primary-foreground" href="/contato">Contato</a>'
            + '</div>';
        panel.appendChild(linksDiv);
        document.body.appendChild(panel);

        function openMenu()  { panel.classList.add('open'); overlay.classList.add('open'); btn.setAttribute('aria-expanded','true'); }
        function closeMenu() { panel.classList.remove('open'); overlay.classList.remove('open'); btn.setAttribute('aria-expanded','false'); }

        btn.addEventListener('click', function(e) { e.stopPropagation(); panel.classList.contains('open') ? closeMenu() : openMenu(); });
        closeBtn.addEventListener('click', closeMenu);
        overlay.addEventListener('click', closeMenu);
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', initMobileMenu)
        : initMobileMenu();

})();
