// Dismiss flash messages, and fade them out after a while
document.addEventListener('DOMContentLoaded', () => {
  const dismiss = (el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    setTimeout(() => el.remove(), 250);
  };

  document.querySelectorAll('[data-dismiss-flash]').forEach(btn => {
    btn.addEventListener('click', () => dismiss(btn.closest('.flash')));
  });

  // Auto-dismiss successes only; errors stay until the user reads them
  document.querySelectorAll('.flash--success').forEach(el => {
    setTimeout(() => dismiss(el), 5000);
  });
});