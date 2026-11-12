/* ============================================================
   DeniseClothing — front-end behaviour
   ------------------------------------------------------------
   Everything lives in one file and runs after the DOM is ready.
   Nothing here is required for the site to work: if JavaScript
   is off, every form still submits and every link still works.
   JS only makes things nicer.

   The Content-Security-Policy in server.js blocks inline event
   handlers (onclick="...", onmouseover="..."), so ALL behaviour
   has to live in this file and hook onto data- attributes.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {

  // ============================================================
  // 1. Flash messages — dismiss button + auto-fade
  // ============================================================
  document.querySelectorAll('.flash').forEach(function (flash) {
    const close = flash.querySelector('[data-flash-close]');

    function dismiss() {
      flash.style.opacity = '0';
      flash.style.transform = 'translateY(-6px)';
      // Wait for the CSS transition to finish before removing it,
      // otherwise it vanishes instantly with no animation
      setTimeout(function () { flash.remove(); }, 250);
    }

    if (close) close.addEventListener('click', dismiss);

    // Success messages disappear on their own. Errors stay put —
    // the user needs time to read what went wrong.
    if (flash.classList.contains('flash--success')) {
      setTimeout(dismiss, 5000);
    }
  });


  // ============================================================
  // 2. Reveal on scroll
  // ------------------------------------------------------------
  // IntersectionObserver tells us when an element scrolls into
  // view. Cheaper than listening to every scroll event, because
  // the browser does the maths itself.
  // ============================================================
  const revealItems = document.querySelectorAll('.reveal');

  // Respect the OS "reduce motion" setting — some people get
  // motion sickness from animations
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReduced || !('IntersectionObserver' in window)) {
    // No animation: just show everything straight away
    revealItems.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          // Once it's shown, stop watching it — it never needs
          // to animate again
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.12,          // fire when 12% of it is on screen
      rootMargin: '0px 0px -40px 0px'  // start slightly before it's fully in view
    });

    revealItems.forEach(function (el) { observer.observe(el); });
  }


  // ============================================================
  // 3. Quantity steppers
  // ------------------------------------------------------------
  // Two jobs depending on where the stepper is:
  //   - product page: just change the number
  //   - cart page:    change the number AND submit the form
  //
  // On the cart page we debounce. If someone taps "+" five times
  // quickly we don't want five round-trips to the server — we
  // wait until they stop clicking, then send once.
  // ============================================================
  document.querySelectorAll('[data-stepper]').forEach(function (stepper) {
    const input = stepper.querySelector('input[type="number"]');
    if (!input) return;

    const autoSubmit = stepper.hasAttribute('data-autosubmit');
    const form = stepper.closest('form');
    let timer = null;

    function changeBy(amount) {
      const min = Number(input.min || 1);
      const max = Number(input.max || 99);
      const current = Number(input.value) || min;
      const next = Math.min(max, Math.max(min, current + amount));

      if (next === current) return;  // already at a limit, nothing to do
      input.value = next;

      if (autoSubmit && form) {
        clearTimeout(timer);
        timer = setTimeout(function () { form.submit(); }, 600);
      }
    }

    stepper.querySelectorAll('[data-step]').forEach(function (button) {
      button.addEventListener('click', function () {
        changeBy(button.dataset.step === 'up' ? 1 : -1);
      });
    });

    // Someone can also type into the box directly
    if (autoSubmit && form) {
      input.addEventListener('change', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { form.submit(); }, 600);
      });
    }
  });


  // ============================================================
  // 4. Cart badge bump
  // ------------------------------------------------------------
  // The badge count is rendered by the server. We compare it to
  // what it was on the last page view (kept in sessionStorage)
  // and animate only when it actually changed, so it doesn't
  // bounce on every single page load.
  // ============================================================
  const badge = document.querySelector('[data-cart-count]');
  if (badge) {
    const current = badge.textContent.trim();

    try {
      const previous = sessionStorage.getItem('cartCount');
      if (previous !== null && previous !== current) {
        badge.classList.add('is-bumped');
        setTimeout(function () { badge.classList.remove('is-bumped'); }, 450);
      }
      sessionStorage.setItem('cartCount', current);
    } catch (err) {
      // sessionStorage throws in private mode on some browsers.
      // The badge still shows the right number, it just won't
      // animate — not worth breaking the page over.
    }
  }


  // ============================================================
  // 5. Password matching
  // ------------------------------------------------------------
  // Live feedback on register and reset-password forms.
  // This is convenience only — server.js checks both fields
  // again, because anything in the browser can be bypassed.
  // ============================================================
  const pwForm = document.querySelector('[data-password-match]');
  if (pwForm) {
    const password = pwForm.querySelector('[data-password]');
    const confirm = pwForm.querySelector('[data-password-confirm]');
    const hint = pwForm.querySelector('[data-password-hint]');
    const submit = pwForm.querySelector('button[type="submit"], button:not([type])');

    if (password && confirm) {
      function check() {
        const a = password.value;
        const b = confirm.value;

        // Don't nag before they've typed anything in the second box
        if (b.length === 0) {
          if (hint) { hint.textContent = ''; hint.className = 'form-text'; }
          confirm.classList.remove('is-invalid', 'is-valid');
          if (submit) submit.disabled = false;
          return;
        }

        if (a === b) {
          if (hint) { hint.textContent = 'Passwords match.'; hint.className = 'form-text text-success'; }
          confirm.classList.remove('is-invalid');
          confirm.classList.add('is-valid');
          if (submit) submit.disabled = false;
        } else {
          if (hint) { hint.textContent = 'Passwords do not match.'; hint.className = 'form-text text-danger'; }
          confirm.classList.remove('is-valid');
          confirm.classList.add('is-invalid');
          if (submit) submit.disabled = true;
        }
      }

      password.addEventListener('input', check);
      confirm.addEventListener('input', check);
    }
  }


  // ============================================================
  // 6. Live product preview (admin new-product form)
  // ------------------------------------------------------------
  // Mirrors what the admin types into a fake product card, so
  // they can see roughly how it will look in the shop before
  // they save anything.
  // ============================================================
  const previewForm = document.querySelector('[data-live-preview]');
  if (previewForm) {
    const out = {
      name: document.querySelector('[data-preview-name]'),
      price: document.querySelector('[data-preview-price]'),
      department: document.querySelector('[data-preview-department]'),
      image: document.querySelector('[data-preview-image]')
    };

    previewForm.querySelectorAll('[data-preview-source]').forEach(function (input) {
      const key = input.dataset.previewSource;

      function update() {
        if (!out[key]) return;

        if (key === 'price') {
          const n = parseFloat(input.value);
          out[key].textContent = '$' + (isNaN(n) ? '0.00' : n.toFixed(2));
        } else {
          out[key].textContent = input.value || (key === 'name' ? 'Product name' : 'unisex');
        }
      }

      input.addEventListener('input', update);
      input.addEventListener('change', update);  // covers <select>
      update();  // run once so a re-rendered form (after a validation
                 // error) shows the values that came back
    });

    // Show the chosen file straight away. FileReader reads the
    // file from the user's own disk into a data: URL — nothing
    // is uploaded until the form is actually submitted.
    const fileInput = previewForm.querySelector('[data-preview-file]');
    if (fileInput && out.image) {
      fileInput.addEventListener('change', function () {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (e) { out.image.src = e.target.result; };
        reader.readAsDataURL(file);
      });
    }
  }

  // ============================================================
  // 7. Checkout address picker
  // ------------------------------------------------------------
  // Shows the new-address fields only when "Use a new address"
  // is picked, and makes them required only then. Otherwise the
  // browser would refuse to submit empty fields the customer
  // can't even see.
  // ============================================================
  const addressChoices = document.querySelectorAll('[data-address-choice]');
  const newAddress = document.querySelector('[data-new-address]');

  if (addressChoices.length && newAddress) {
    function syncAddressChoice() {
      const picked = document.querySelector('[data-address-choice]:checked');
      const isNew = !picked || picked.value === 'new';

      newAddress.hidden = !isNew;
      newAddress.querySelectorAll('[data-required-when-new]').forEach(function (input) {
        input.required = isNew;
      });
    }

    addressChoices.forEach(function (choice) {
      choice.addEventListener('change', syncAddressChoice);
    });
    syncAddressChoice();
  }


  // ============================================================
  // 8. Confirm before destructive buttons
  // ------------------------------------------------------------
  // <form data-confirm="Delete this address?"> asks first. The
  // CSP blocks onsubmit="return confirm(...)", which is why this
  // lives here instead of in the HTML.
  // ============================================================
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

});
