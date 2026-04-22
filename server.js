import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

const API_SECRET = process.env.RAILWAY_API_SECRET;

app.get('/debug-env', (req, res) => {
  res.json({
    ALIEXPRESS_MAIL: !!process.env.ALI_MAIL,
    ALIEXPRESS_PASSWORD: !!process.env.ALIEXPRESS_PASSWORD,
    RAILWAY_API_SECRET: !!process.env.RAILWAY_API_SECRET,
    MAIL_PREVIEW: (process.env.ALI_MAIL || '').substring(0, 10),
    SECRET_PREVIEW: (process.env.RAILWAY_API_SECRET || '').substring(0, 5),
  });
});

app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });
  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
  if (!SCRAPER_API_KEY) return res.status(500).json({ error: 'SCRAPER_API_KEY non configurée' });
  try {
    const encodedUrl = encodeURIComponent(url);
    const response = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodedUrl}`);
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

  const ALIEXPRESS_MAIL = ali_mail || process.env.ALI_MAIL;
  const ALIEXPRESS_PASSWORD = ali_password || process.env.ALIEXPRESS_PASSWORD;

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

    // 1. Aller directement sur la page de login avec les params
    console.log('[place-order] Navigation vers login...');
    await page.goto('https://login.aliexpress.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    console.log('[place-order] URL après goto login:', currentUrl);

    // Logger tous les frames disponibles
    const allFrames = page.frames();
    console.log('[place-order] Frames count:', allFrames.length);
    for (const f of allFrames) {
      console.log('[place-order] Frame URL:', f.url());
      // Lister les inputs dans chaque frame
      try {
        const inputs = await f.$$eval('input', els => els.map(e => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder })));
        if (inputs.length > 0) console.log('[place-order] Inputs dans frame:', JSON.stringify(inputs));
      } catch {}
    }

    // 2. Trouver le frame qui contient un input
    let loginFrame = null;
    for (const f of allFrames) {
      try {
        const inputs = await f.$$('input');
        if (inputs.length > 0) {
          loginFrame = f;
          console.log('[place-order] Frame avec inputs trouvé:', f.url());
          break;
        }
      } catch {}
    }

    if (!loginFrame) {
      throw new Error(`Aucun frame avec inputs trouvé. Frames: ${allFrames.map(f => f.url()).join(', ')}`);
    }

    // 3. Remplir email - essayer tous les inputs du frame
    const allInputs = await loginFrame.$$('input');
    console.log('[place-order] Nombre d\'inputs dans loginFrame:', allInputs.length);

    // Premier input = email/login
    if (allInputs.length > 0) {
      await allInputs[0].click();
      await allInputs[0].fill(ALIEXPRESS_MAIL);
      console.log('[place-order] Email rempli dans input[0]');
    } else {
      throw new Error('Aucun input trouvé dans le frame de login');
    }
    await page.waitForTimeout(800);

    // Deuxième input = password
    if (allInputs.length > 1) {
      await allInputs[1].click();
      await allInputs[1].fill(ALIEXPRESS_PASSWORD);
      console.log('[place-order] Password rempli dans input[1]');
    } else {
      throw new Error('Input password introuvable');
    }
    await page.waitForTimeout(800);

    // 4. Cliquer sur submit
    const submitSelectors = ['button[type="submit"]', '.login-submit', '#fm-login-submit', 'button:has-text("Sign in")', 'button:has-text("Log in")'];
    let submitClicked = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await loginFrame.$(sel);
        if (btn) {
          await btn.click();
          submitClicked = true;
          console.log('[place-order] Submit cliqué:', sel);
          break;
        }
      } catch {}
    }
    if (!submitClicked) {
      // Essayer Enter sur le champ password
      if (allInputs.length > 1) {
        await allInputs[1].press('Enter');
        console.log('[place-order] Enter pressé sur password');
      }
    }

    await page.waitForTimeout(6000);
    console.log('[place-order] URL après login:', page.url());

    // 5. Aller sur la page produit
    console.log('[place-order] Navigation vers le produit...');
    await page.goto(aliexpress_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // 6. Quantité
    if (quantity && quantity > 1) {
      try {
        const qtyInput = await page.$('input[class*="quantity"], input[data-role="quantity"]');
        if (qtyInput) {
          await qtyInput.click({ clickCount: 3 });
          await qtyInput.type(String(quantity));
        }
      } catch (e) {
        console.log('[place-order] Quantité non modifiée:', e.message);
      }
    }

    // 7. Buy Now
    await page.waitForTimeout(2000);
    const buyNowSelectors = [
      'button:has-text("Buy Now")',
      'button:has-text("Acheter")',
      '[data-pl="buy-now"]',
      '.buy-now-btn',
      'a:has-text("Buy Now")'
    ];
    let clicked = false;
    for (const sel of buyNowSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          clicked = true;
          console.log('[place-order] Buy Now cliqué:', sel);
          break;
        }
      } catch {}
    }
    if (!clicked) throw new Error('Bouton Buy Now introuvable');

    await page.waitForTimeout(5000);
    console.log('[place-order] URL après Buy Now:', page.url());

    const checkoutUrl = page.url();
    if (!checkoutUrl.includes('trade') && !checkoutUrl.includes('order') && !checkoutUrl.includes('checkout')) {
      throw new Error(`Redirection inattendue: ${checkoutUrl}`);
    }

    // 8. Confirmer commande
    await page.waitForTimeout(2000);
    const confirmSelectors = [
      'button:has-text("Place Order")',
      'button:has-text("Confirm Order")',
      'button:has-text("Passer la commande")',
      '[class*="place-order"]',
      '[class*="confirm-order"]',
    ];
    let confirmed = false;
    for (const sel of confirmSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          confirmed = true;
          console.log('[place-order] Commande confirmée avec:', sel);
          break;
        }
      } catch {}
    }

    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    console.log('[place-order] URL finale:', finalUrl);

    // 9. Extraire order ID
    let aliexpress_order_id = null;
    const orderIdMatch = finalUrl.match(/orderId=(\d+)/) || finalUrl.match(/order\/(\d+)/);
    if (orderIdMatch) aliexpress_order_id = orderIdMatch[1];
    if (!aliexpress_order_id) {
      try {
        const pageContent = await page.content();
        const contentMatch = pageContent.match(/"orderId":"?(\d+)"?/);
        if (contentMatch) aliexpress_order_id = contentMatch[1];
      } catch {}
    }

    await browser.close();

    return res.json({
      success: true,
      aliexpress_order_id: aliexpress_order_id || `manual_${order_id}`,
      message: confirmed ? 'Commande passée avec succès' : 'Commande initiée (vérification manuelle requise)',
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
