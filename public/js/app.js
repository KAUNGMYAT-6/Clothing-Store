document.addEventListener('DOMContentLoaded', () => {

  // ============================================================
  // Flash messages
  // ============================================================
  const dismiss = (el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 250);
  };

  document.querySelectorAll('[data-dismiss-flash]').forEach(btn => {
    btn.addEventListener('click', () => dismiss(btn.closest('.flash')));
  });

  // Successes clear themselves; errors stay until the user has read them
  document.querySelectorAll('.flash--success').forEach(el => {
    setTimeout(() => dismiss(el), 5000);
  });

  // ============================================================
  // Reveal on scroll
  // ============================================================
  const revealables = document.querySelectorAll('.reveal');
  if (revealables.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    revealables.forEach(el => io.observe(el));
  } else {
    // No IntersectionObserver: show everything rather than hiding it
    revealables.forEach(el => el.classList.add('is-visible'));
  }

  // ============================================================
  // Quantity steppers
  // data-autosubmit: saves the form shortly after the last click
  // ============================================================
  document.querySelectorAll('[data-stepper]').forEach(stepper => {
    const input = stepper.querySelector('input');
    const down  = stepper.querySelector('[data-step="down"]');
    const up    = stepper.querySelector('[data-step="up"]');
    if (!input || !down || !up) return;

    const max = input.max ? parseInt(input.max, 10) : Infinity;
    const min = input.min ? parseInt(input.min, 10) : 1;
    const form = stepper.hasAttribute('data-autosubmit') ? stepper.closest('form') : null;
    let timer;

    const sync = () => {
      const v = parseInt(input.value, 10) || min;
      down.disabled = v <= min;
      up.disabled   = v >= max;
    };

    const step = (delta) => {
      const current = parseInt(input.value, 10) || min;
      input.value = Math.min(max, Math.max(min, current + delta));
      sync();

      if (form) {
        // Debounced, so three quick clicks save once
        clearTimeout(timer);
        stepper.classList.add('is-saving');
        timer = setTimeout(() => form.submit(), 550);
      }
    };

    down.addEventListener('click', () => step(-1));
    up.addEventListener('click', () => step(1));
    input.addEventListener('change', sync);
    sync();
  });

  // ============================================================
  // Cart badge bump when the count changed since the last page
  // ============================================================
  const pill = document.getElementById('cartPill');
  if (pill) {
    const countEl = pill.querySelector('.count');
    if (countEl) {
      const count = countEl.textContent.trim();
      try {
        const last = sessionStorage.getItem('cartCount');
        if (last !== null && last !== count) {
          pill.classList.add('is-bumped');
          setTimeout(() => pill.classList.remove('is-bumped'), 460);
        }
        sessionStorage.setItem('cartCount', count);
      } catch (e) {
        // sessionStorage can throw in private browsing — not worth failing over
      }
    }
  }

  // ============================================================
  // Password confirmation (register form)
  // ============================================================
  const pw = document.querySelector('[data-pw]');
  const pwConfirm = document.querySelector('[data-pw-confirm]');
  const pwFeedback = document.querySelector('[data-pw-feedback]');

  if (pw && pwConfirm && pwFeedback) {
    const check = () => {
      if (!pwConfirm.value) {
        pwFeedback.textContent = '';
        pwConfirm.setCustomValidity('');
        return;
      }
      if (pw.value === pwConfirm.value) {
        pwFeedback.textContent = 'Passwords match';
        pwFeedback.style.color = 'var(--success)';
        pwConfirm.setCustomValidity('');
      } else {
        pwFeedback.textContent = 'Passwords do not match';
        pwFeedback.style.color = 'var(--danger)';
        pwConfirm.setCustomValidity('Passwords do not match');
      }
    };

    pw.addEventListener('input', check);
    pwConfirm.addEventListener('input', check);
  }

});