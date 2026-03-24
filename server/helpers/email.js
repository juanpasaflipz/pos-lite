export async function sendPasswordResetEmail(email, resetUrl, tenantName) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[Email] No RESEND_API_KEY — reset URL for ${email}: ${resetUrl}`);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Desktop Kitchen <noreply@desktop.kitchen>',
        to: [email],
        subject: 'Reset your password — Desktop Kitchen',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#0d9488">Reset Your Password</h2>
            <p>We received a request to reset the password for <strong>${tenantName}</strong>.</p>
            <p style="margin:24px 0">
              <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#0d9488;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Reset Password</a>
            </p>
            <p style="color:#666;font-size:14px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
      }),
    });
  } catch (err) {
    console.error('[Email] Failed to send password reset email:', err.message);
  }
}

export async function sendWelcomeEmail(email, restaurantName, subdomain, pin) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[Email] No RESEND_API_KEY — welcome email for ${email} skipped`);
    return;
  }
  const loginUrl = subdomain
    ? `https://${subdomain}.desktop.kitchen`
    : 'https://pos.desktop.kitchen';
  const docsUrl = 'https://docs.desktop.kitchen';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Desktop Kitchen <noreply@desktop.kitchen>',
        to: [email],
        subject: `Welcome to Desktop Kitchen — ${restaurantName}`,
        html: `
          <div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
            <h2 style="color:#0d9488;margin-bottom:4px">Welcome to Desktop Kitchen!</h2>
            <p style="color:#666;margin-top:0">Your POS system for <strong>${restaurantName}</strong> is ready.</p>

            <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:16px;margin:20px 0">
              <p style="margin:0 0 8px"><strong>Your Admin PIN:</strong> <span style="font-size:20px;font-weight:700;letter-spacing:4px">${pin}</span></p>
              <p style="margin:0"><strong>Login:</strong> <a href="${loginUrl}" style="color:#0d9488">${loginUrl.replace('https://', '')}</a></p>
            </div>

            <h3 style="color:#0d9488;margin-bottom:8px">Getting Started</h3>
            <ol style="color:#374151;line-height:1.8;padding-left:20px">
              <li>Log in with your PIN above</li>
              <li>Set up your menu categories and items</li>
              <li>Add employees and assign roles</li>
              <li>Configure payment methods</li>
              <li>Start taking orders!</li>
            </ol>

            <p style="margin-top:20px">
              <a href="${docsUrl}" style="display:inline-block;padding:10px 20px;background:#0d9488;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">View Setup Guide</a>
            </p>

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
            <p style="color:#9ca3af;font-size:13px">Need help? Visit <a href="${docsUrl}" style="color:#0d9488">docs.desktop.kitchen</a> or reply to this email.</p>
          </div>
        `,
      }),
    });
  } catch (err) {
    console.error('[Email] Failed to send welcome email:', err.message);
  }
}

export async function sendSalesRepWelcomeEmail(email, fullName, password) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[Email] No RESEND_API_KEY — sales rep welcome for ${email} skipped`);
    return;
  }
  const loginUrl = 'https://sales.desktop.kitchen';

  // Load welcome package attachments
  const { readFileSync } = await import('fs');
  const { dirname, join } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const salesTemplatesDir = join(__dirname, '..', 'templates', 'sales');

  const attachments = [];
  try {
    attachments.push({
      filename: 'Desktop_Kitchen_Script_Ventas.docx',
      content: readFileSync(join(salesTemplatesDir, 'Desktop_Kitchen_Script_Ventas.docx')).toString('base64'),
    });
  } catch (err) {
    console.error('[Email] Failed to load sales welcome package attachments:', err.message);
  }

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Desktop Kitchen <hello@desktop.kitchen>',
        to: [email],
        subject: 'Bienvenido al equipo de ventas de Desktop Kitchen',
        html: `
          <div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
            <h2 style="color:#0d9488;margin-bottom:4px">Bienvenido/a al equipo, ${fullName}!</h2>
            <p style="color:#666;margin-top:0">Has sido agregado/a al equipo de ventas de Desktop Kitchen.</p>

            <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:16px;margin:20px 0">
              <p style="margin:0 0 8px"><strong>Correo:</strong> ${email}</p>
              <p style="margin:0 0 12px"><strong>Contrase\u00f1a:</strong> <span style="font-size:18px;font-weight:700">${password}</span></p>
              <p style="margin:0">
                <a href="${loginUrl}" style="display:inline-block;padding:10px 20px;background:#0d9488;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Iniciar Sesi\u00f3n</a>
                <span style="color:#666;font-size:13px;margin-left:12px">${loginUrl.replace('https://', '')}</span>
              </p>
            </div>

            <h3 style="color:#0d9488;margin-bottom:8px">Lo que puedes hacer</h3>
            <ul style="color:#374151;line-height:1.8;padding-left:20px">
              <li>Registrar los prospectos que visitas</li>
              <li>Dar seguimiento desde la primera visita hasta la conversi\u00f3n</li>
              <li>Generar datos demo para restaurantes convertidos</li>
              <li>Ver tus comisiones y ganancias</li>
            </ul>

            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0">
              <h3 style="color:#0d9488;margin:0 0 8px">POS Demo</h3>
              <p style="color:#374151;margin:0 0 8px;font-size:14px">Usa estas credenciales para explorar el sistema y hacer demos a prospectos:</p>
              <p style="margin:0 0 4px;font-size:14px"><strong>URL:</strong> <a href="https://pos.desktop.kitchen" style="color:#0d9488">pos.desktop.kitchen</a></p>
              <p style="margin:0 0 4px;font-size:14px"><strong>Correo:</strong> admin@bobbys.com</p>
              <p style="margin:0 0 4px;font-size:14px"><strong>Contrase\u00f1a:</strong> demo54321</p>
              <p style="margin:0;font-size:14px"><strong>PIN:</strong> 599158</p>
            </div>

            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0">
              <h3 style="color:#0d9488;margin:0 0 8px">Paquete de bienvenida</h3>
              <p style="color:#374151;margin:0;font-size:14px">Adjunto encontrar\u00e1s un documento importante para comenzar:</p>
              <ul style="color:#374151;font-size:14px;line-height:1.8;padding-left:20px;margin-bottom:0">
                <li><strong>Script de Ventas</strong> \u2014 gu\u00eda para tus visitas a restaurantes</li>
              </ul>
            </div>

            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0">
              <h3 style="color:#0d9488;margin:0 0 8px">Enlaces \u00fatiles</h3>
              <ul style="color:#374151;font-size:14px;line-height:2;padding-left:20px;margin:0">
                <li><a href="https://es.desktop.kitchen" style="color:#0d9488">es.desktop.kitchen</a> \u2014 Sitio web (espa\u00f1ol)</li>
                <li><a href="https://es.desktop.kitchen/blog" style="color:#0d9488">es.desktop.kitchen/blog</a> \u2014 Blog</li>
                <li><a href="https://www.desktop.kitchen/investors" style="color:#0d9488">www.desktop.kitchen/investors</a> \u2014 Inversionistas</li>
              </ul>
            </div>

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
            <p style="color:#9ca3af;font-size:13px">Por favor cambia tu contrase\u00f1a despu\u00e9s de tu primer inicio de sesi\u00f3n. \u00bfPreguntas? Responde a este correo.</p>
          </div>
        `,
        attachments,
      }),
    });
  } catch (err) {
    console.error('[Email] Failed to send sales rep welcome email:', err.message);
  }
}

export async function sendSecurityAlertEmail(email, restaurantName, ip, attempts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[Email] No RESEND_API_KEY — security alert for ${email} skipped`);
    return;
  }
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' });
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Desktop Kitchen <noreply@desktop.kitchen>',
        to: [email],
        subject: `Security Alert — ${restaurantName}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#dc2626">Security Alert</h2>
            <p>Multiple failed PIN login attempts were detected on your POS system <strong>${restaurantName}</strong>.</p>
            <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px;margin:20px 0">
              <p style="margin:0 0 8px"><strong>Failed attempts:</strong> ${attempts}</p>
              <p style="margin:0 0 8px"><strong>IP address:</strong> ${ip || 'Unknown'}</p>
              <p style="margin:0"><strong>Time:</strong> ${timestamp}</p>
            </div>
            <p>The account has been <strong>temporarily locked for 30 minutes</strong> to prevent unauthorized access.</p>
            <p style="color:#666;font-size:14px">If this was you, wait 30 minutes and try again. If you don't recognize this activity, consider changing your employee PINs immediately.</p>
          </div>
        `,
      }),
    });
  } catch (err) {
    console.error('[Email] Failed to send security alert email:', err.message);
  }
}

export async function sendPinEmail(email, pin, restaurantName, subdomain) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[Email] No RESEND_API_KEY — PIN for ${email}: ${pin}`);
    return;
  }
  const loginUrl = subdomain
    ? `https://${subdomain}.desktop.kitchen`
    : 'https://pos.desktop.kitchen';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Desktop Kitchen <noreply@desktop.kitchen>',
        to: [email],
        subject: `Your POS Login PIN — ${restaurantName}`,
        html: `<h2>Welcome to Desktop Kitchen!</h2><p>Your admin PIN: <strong style="font-size:24px">${pin}</strong></p><p>Log in at <a href="${loginUrl}">${loginUrl.replace('https://', '')}</a></p>`,
      }),
    });
  } catch (err) {
    console.error('[Email] Failed to send PIN email:', err.message);
  }
}
