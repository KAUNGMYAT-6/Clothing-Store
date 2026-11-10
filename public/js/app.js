document.addEventListener('DOMContentLoaded', () => {

  // ---- Flash messages ----
  const dismiss = (el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 250);
  };

  document.querySelectorAll('[data-dismiss-flash]').forEach(btn => {
    btn.addEventListener('click', () => dismiss(btn.closest('.flash')));
  });

  // Successes clear themselves; errors stay until read
  document.querySelectorAll('.flash--success').forEach(el => {
    setTimeout(() => dismiss(el), 5000);
  });

  // ---- Reveal on scroll ----
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
    revealables.forEach(el => el.classList.add('is-visible'));
  }

  // ---- Quantity steppers ----
  document.querySelectorAll('[data-stepper]').forEach(stepper => {
    const input = stepper.querySelector('input');
    const down  = stepper.querySelector('[data-step="down"]');
    const up    = stepper.querySelector('[data-step="up"]');
    const max = input.max ? parseInt(input.max, 10) : Infinity;
    const min = input.min ? parseInt(input.min, 10) : 1;

    const sync = () => {
      const v = parseInt(input.value, 10) || min;
      down.disabled = v <= min;
      up.disabled   = v >= max;
    };
    const step = (delta) => {
      const next = Math.min(max, Math.max(min, (parseInt(input.value, 10) || min) + delta));
      input.value = next;
      sync();
    };

    down.addEventListener('click', () => step(-1));
    up.addEventListener('click', () => step(1));
    input.addEventListener('change', sync);
    sync();
  });

  // ---- Cart badge bump when the count changed ----
  const pill = document.getElementById('cartPill');
  if (pill) {
    const count = pill.querySelector('.count').textContent.trim();
    try {
      const last = sessionStorage.getItem('cartCount');
      if (last !== null && last !== count) {
        pill.classList.add('is-bumped');
        setTimeout(() => pill.classList.remove('is-bumped'), 460);
      }
      sessionStorage.setItem('cartCount', count);
    } catch (e) { /* private browsing */ }
  }

});