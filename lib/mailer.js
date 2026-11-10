const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendOrderConfirmation(order, items) {
  const rows = items.map(item => `
    <tr>
      <td style="padding:8px 0;">
        ${item.product_name}<br>
        <span style="color:#777;font-size:13px;">
          ${item.color} &middot; Size ${item.size} &times; ${item.quantity}
        </span>
      </td>
      <td style="padding:8px 0;text-align:right;">
        $${(Number(item.unit_price) * item.quantity).toFixed(2)}
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2>Thank you for your order</h2>
      <p>Hi ${order.shipping_name}, we've received your order <strong>#${order.id}</strong>.</p>

      <table style="width:100%;border-collapse:collapse;margin:24px 0;">
        ${rows}
        <tr><td colspan="2"><hr style="border:none;border-top:1px solid #ddd;"></td></tr>
        <tr>
          <td style="padding:4px 0;">Subtotal</td>
          <td style="padding:4px 0;text-align:right;">$${Number(order.subtotal).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;">Shipping</td>
          <td style="padding:4px 0;text-align:right;">$${Number(order.shipping_fee).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-weight:bold;">Total</td>
          <td style="padding:8px 0;text-align:right;font-weight:bold;">
            $${Number(order.total).toFixed(2)}
          </td>
        </tr>
      </table>

      <h4 style="margin-bottom:4px;">Shipping to</h4>
      <p style="color:#555;margin-top:0;">
        ${order.shipping_name}<br>
        ${order.shipping_address.replace(/\n/g, '<br>')}
      </p>
    </div>
  `;

  return resend.emails.send({
    from: process.env.MAIL_FROM,
    to: order.email,
    subject: `Order #${order.id} confirmed`,
    html
  });
}

async function sendPasswordReset(user, resetUrl) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <h2 style="color:#15143A">Reset your password</h2>
      <p>Hi ${user.name}, someone asked to reset the password for your
         DeniseClothing account.</p>
      <p style="margin:28px 0">
        <a href="${resetUrl}"
           style="background:#FF6B1A;color:#fff;padding:12px 24px;
                  border-radius:8px;text-decoration:none;font-weight:600;
                  display:inline-block">Choose a new password</a>
      </p>
      <p style="color:#8785A8;font-size:13px">
        This link works once and expires in one hour. If you didn't ask for
        this, you can ignore this email — your password hasn't changed.
      </p>
      <p style="color:#8785A8;font-size:12px;word-break:break-all">
        If the button doesn't work, paste this into your browser:<br>${resetUrl}
      </p>
    </div>
  `;

  return resend.emails.send({
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: 'Reset your DeniseClothing password',
    html
  });
}

module.exports = { sendOrderConfirmation, sendPasswordReset };
