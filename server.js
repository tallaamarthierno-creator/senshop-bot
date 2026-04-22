import express from 'express';
import { chromium } from 'playwright';
import Captcha from 'node-2captcha';

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET;

app.get('/debug-env', (req, res) => {
  res.json({
    ALIEXPRESS_MAIL_set: !!process.env.ALIEXPRESS_MAIL,
    ALIEXPRESS_PASSWORD_set: !!process.env.ALIEXPRESS_PASSWORD,
    TWOCAPTCHA_set: !!process.env.TWOCAPTCHA_API_KEY,
    MAIL_PREVIEW: (process.env.ALIEXPRESS_MAIL || '').substring(0, 15),
  });
});

app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

async function getLoginFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    try {
      const inputs = await f.$$('input');
      if (inputs.length > 0) return f;
    } catch {}
  }
  return null;
}

async function solveCaptchaIfPresent(page) {
  const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY;
  if (!TWOCAPTCHA_KEY) return;

  try {
    const content = await page.content();
    const hasCaptcha = content.includes('captcha') || content.includes('slider') || content.includes('verify');
    if (!hasCaptcha) return;

    console.log('[captcha] CAPTCHA détecté, tentative de résolution...');

    // Chercher le slider dans tous les frames
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
      try {
        const slider = await frame.$('.nc_iconfont.btn_slide, .btn-slide, [class*="slide"], [class*="slider-btn"]');
        if (!slider) continue;

        const sliderBox = await slider.boundingBox();
        if (!sliderBox) continue;

        console.log('[captcha] Slider trouvé, simulation drag...');

        // Simuler un drag humain
        await page.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(200);

        // Drag progressif pour simuler un humain
        const steps = 20;
        const distance = 300;
        for (let i = 0; i <= steps; i++) {
          const x = sliderBox.x + sliderBox.width / 2 + (distance * i) / steps;
          const y = sliderBox.y + sliderBox.height / 2 + Math.sin(i / steps * Math.PI) * 3;
          await page.mouse.move(x, y);
          await page.waitForTimeout(20 + Math.random() * 30);
        }

        await page.mouse.up();
        await page.waitForTimeout(3000);
        console.log('[captcha] Drag effectué');
        return;
      } catch {}
    }
  } catch (e) {
    console.log('[captcha] Erreur:', e.message);
  }
}

app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });
  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
  if (!SCRAPER_API_KEY) return res.status(500).json({ error: 'SCRAPER_API_KEY non configurée' });
  try {
    const response = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`);
    const html = await response.text();
    const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || html.match(/"subject":"([^"]+)"/);
    const name = nameMatch?.[1]?.trim() || null;
    const priceMatch = html.match(/"minAmount":\{"value":(\d+\.?\d*)/);
    const price_usd = priceMatch ? parseFloat(priceMatch[1]) : null;
    const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    const image_url = imgMatch?.[1] || null;
    res.json({ name, price_usd, image_url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/place-order', async (req, res) => {
  const { aliexpress_url, quantity, shipping_address, order_id, ali_mail, ali_password } = req.body;

  if (!aliexpress_url || !shipping_address) {
    return res.status(400).json({ error: 'aliexpress_url et shipping_address requis' });
  }

  const ALIEXPRESS_MAIL = ali_mail || process.env.ALIEXPRESS_MAIL;
  const ALIEXPRESS_PASSWORD = ali_password || process.env.ALIEXPRESS_PASSWORD;

  console.log('[place-order] Mail utilisé:', ALIEXPRESS_MAIL?.substring(0, 15));

  if (!ALIEXPRESS_MAIL || !ALIEXPRESS_PASSWORD) {
    return res.status(500).json({ error: 'Identifiants AliExpress non configurés' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // 1. Login
    console.log('[place-order] Navigation vers login...');
    await page.goto('https://login.aliexpress.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    let loginFrame = await getLoginFrame(page);
    if (!loginFrame) throw new Error('Aucun frame avec inputs trouvé');

    const inputsInit = await loginFrame.$$eval('input', els => els.map(e => ({ type: e.type, name: e.name, placeholder: e.placeholder })));
    console.log('[place-order] Inputs initiaux:', JSON.stringify(inputsInit));

    const inputs = await loginFrame.$$('input');
    await inputs[0].click();
    await inputs[0].fill(ALIEXPRESS_MAIL);
    console.log('[place-order] Email rempli');
    await page.waitForTimeout(500);
    await inputs[0].press('Enter');
    await page.waitForTimeout(3000);

    let allInputsAfter = await loginFrame.$$('input');
    console.log('[place-order] Inputs après Enter:', allInputsAfter.length);

    // Chercher champ password
    let passwordInput = null;
    for (const inp of allInputsAfter) {
      const type = await inp.getAttribute('type');
      if (type === 'password') { passwordInput = inp; break; }
    }
    if (!passwordInput && allInputsAfter.length >= 2) {
      passwordInput = allInputsAfter[allInputsAfter.length - 1];
    }
    if (!passwordInput) throw new Error('Champ password introuvable');

    await passwordInput.click();
    await passwordInput.fill(ALIEXPRESS_PASSWORD);
    console.log('[place-order] Password rempli');
    await page.waitForTimeout(500);

    // Submit
    const submitSelectors = ['button[type="submit"]', '#fm-login-submit', 'button:has-text("Sign in")', 'button:has-text("Log in")'];
    let submitClicked = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await loginFrame.$(sel);
        if (btn) { await btn.click(); submitClicked = true; console.log('[place-order] Submit:', sel); break; }
      } catch {}
    }
    if (!submitClicked) await passwordInput.press('Enter');

    await page.waitForTimeout(4000);

    // Résoudre CAPTCHA si présent
    await solveCaptchaIfPresent(page);
    await page.waitForTimeout(4000);

    const urlAfterLogin = page.url();
    console.log('[place-order] URL après login:', urlAfterLogin);

    if (urlAfterLogin.includes('login') || urlAfterLogin.includes('signin')) {
      const content = await page.content();
      const hasCaptcha = content.includes('captcha') || content.includes('slider') || content.includes('verify');
      throw new Error(hasCaptcha
        ? 'CAPTCHA non résolu — AliExpress bloque ce serveur. Solution: utiliser des cookies de session.'
        : `Login échoué — mauvais credentials ou 2FA. URL: ${urlAfterLogin}`
      );
    }

    // 2. Page produit
    console.log('[place-order] Navigation vers le produit...');
    await page.goto(aliexpress_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    if (quantity && quantity > 1) {
      try {
        const qtyInput = await page.$('input[class*="quantity"]');
        if (qtyInput) { await qtyInput.click({ clickCount: 3 }); await qtyInput.type(String(quantity)); }
      } catch {}
    }

    // Buy Now
    await page.waitForTimeout(2000);
    const buyNowSelectors = ['button:has-text("Buy Now")', '[data-pl="buy-now"]', '.buy-now-btn', 'a:has-text("Buy Now")'];
    let clicked = false;
    for (const sel of buyNowSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); clicked = true; console.log('[place-order] Buy Now:', sel); break; }
      } catch {}
    }
    if (!clicked) throw new Error('Bouton Buy Now introuvable');

    await page.waitForTimeout(5000);
    const checkoutUrl = page.url();
    console.log('[place-order] URL checkout:', checkoutUrl);

    if (!checkoutUrl.includes('trade') && !checkoutUrl.includes('order') && !checkoutUrl.includes('checkout')) {
      throw new Error(`Redirection inattendue: ${checkoutUrl}`);
    }

    // Confirmer
    await page.waitForTimeout(2000);
    const confirmSelectors = ['button:has-text("Place Order")', 'button:has-text("Confirm Order")', '[class*="place-order"]'];
    let confirmed = false;
    for (const sel of confirmSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); confirmed = true; console.log('[place-order] Confirmé:', sel); break; }
      } catch {}
    }

    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    console.log('[place-order] URL finale:', finalUrl);

    let aliexpress_order_id = null;
    const m = finalUrl.match(/orderId=(\d+)/) || finalUrl.match(/order\/(\d+)/);
    if (m) aliexpress_order_id = m[1];
    if (!aliexpress_order_id) {
      const c = await page.content();
      const cm = c.match(/"orderId":"?(\d+)"?/);
      if (cm) aliexpress_order_id = cm[1];
    }

    await browser.close();

    return res.json({
      success: true,
      aliexpress_order_id: aliexpress_order_id || `manual_${order_id}`,
      message: confirmed ? 'Commande passée avec succès' : 'Commande initiée',
      final_url: finalUrl
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error('[place-order] ERREUR:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur le port ${PORT}`));
